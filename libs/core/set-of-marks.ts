import type { OcrResult } from './ocr-types.js';

/**
 * Set-of-Marks fusion.
 *
 * Detectors (DOM snapshot rects, OCR lines, future pixel detectors) propose
 * candidate boxes in image pixels. Fusion turns them into a short, numbered
 * list of click targets:
 *
 * 1. icon-over-text suppression: a text box mostly covered by a control/icon
 *    box is the label of that control, so it is absorbed as its label;
 * 2. non-maximum suppression drops duplicates of the same element proposed by
 *    different detectors, keeping the best-scored box and merging provenance;
 * 3. marks are numbered in reading order (top to bottom, left to right, with
 *    a row tolerance so slightly misaligned boxes in one row stay in order).
 *
 * Everything here is pure; drawing and persistence live elsewhere.
 */

export const ICON_TEXT_COVERAGE = 0.7;
export const NMS_IOU_THRESHOLD = 0.5;
export const READING_ROW_TOLERANCE_PX = 12;
export const DEFAULT_MAX_MARKS = 200;

export interface SomBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SomSource = 'ocr' | 'dom' | 'detector';
export type SomKind = 'text' | 'icon' | 'control';

export interface SomCandidate {
  box: SomBox;
  source: SomSource;
  kind: SomKind;
  label?: string;
  /** 0..1; higher wins NMS. */
  score: number;
  /** Browser snapshot ref (e.g. `@e3`) when the candidate is a DOM element. */
  ref?: string;
}

export interface SomMark {
  /** 1-based mark number in reading order. */
  n: number;
  box: SomBox;
  center: { x: number; y: number };
  kind: SomKind;
  label?: string;
  sources: SomSource[];
  ref?: string;
}

export interface SomImageSize {
  width: number;
  height: number;
}

export interface FuseSetOfMarksOptions {
  /** Clip boxes to the image; boxes fully outside are dropped. */
  imageSize?: SomImageSize;
  coverage?: number;
  iou?: number;
  rowTolerance?: number;
  maxMarks?: number;
}

interface WorkingCandidate {
  box: SomBox;
  kind: SomKind;
  label?: string;
  score: number;
  ref?: string;
  sources: Set<SomSource>;
  order: number;
}

const SOURCE_ORDER: SomSource[] = ['dom', 'detector', 'ocr'];
const KIND_PRIORITY: Record<SomKind, number> = { control: 2, icon: 1, text: 0 };

export function boxArea(box: SomBox): number {
  return Math.max(0, box.width) * Math.max(0, box.height);
}

export function intersectionArea(a: SomBox, b: SomBox): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

export function iou(a: SomBox, b: SomBox): number {
  const inter = intersectionArea(a, b);
  const union = boxArea(a) + boxArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** Share of `inner` that lies inside `outer` (0..1). */
export function coverageRatio(inner: SomBox, outer: SomBox): number {
  const area = boxArea(inner);
  return area > 0 ? intersectionArea(inner, outer) / area : 0;
}

export function boxCenter(box: SomBox): { x: number; y: number } {
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

function finiteBox(box: SomBox | undefined): box is SomBox {
  return (
    !!box &&
    [box.x, box.y, box.width, box.height].every((value) => Number.isFinite(value)) &&
    box.width > 0 &&
    box.height > 0
  );
}

function clipBox(box: SomBox, size: SomImageSize | undefined): SomBox | undefined {
  if (!size) return box;
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(size.width, box.x + box.width);
  const y1 = Math.min(size.height, box.y + box.height);
  if (x1 <= x0 || y1 <= y0) return undefined;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function cleanLabel(label: string | undefined): string | undefined {
  const trimmed = label?.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed : undefined;
}

function absorb(into: WorkingCandidate, from: WorkingCandidate): void {
  for (const source of from.sources) into.sources.add(source);
  if (!into.label && from.label) into.label = from.label;
  if (!into.ref && from.ref) into.ref = from.ref;
}

/** Stronger candidate first; ties broken deterministically. */
function compareStrength(a: WorkingCandidate, b: WorkingCandidate): number {
  return (
    b.score - a.score ||
    Number(Boolean(b.ref)) - Number(Boolean(a.ref)) ||
    KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind] ||
    a.order - b.order
  );
}

function suppressTextInsideIcons(
  candidates: WorkingCandidate[],
  coverage: number
): WorkingCandidate[] {
  const containers = candidates.filter((candidate) => candidate.kind !== 'text');
  const kept: WorkingCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind !== 'text') {
      kept.push(candidate);
      continue;
    }
    // The smallest covering container is the element the text labels.
    let owner: WorkingCandidate | undefined;
    for (const container of containers) {
      if (coverageRatio(candidate.box, container.box) < coverage) continue;
      if (!owner || boxArea(container.box) < boxArea(owner.box)) owner = container;
    }
    if (owner) absorb(owner, candidate);
    else kept.push(candidate);
  }
  return kept;
}

function nonMaximumSuppression(candidates: WorkingCandidate[], threshold: number) {
  const kept: WorkingCandidate[] = [];
  for (const candidate of [...candidates].sort(compareStrength)) {
    const duplicateOf = kept.find((existing) => iou(existing.box, candidate.box) > threshold);
    if (duplicateOf) absorb(duplicateOf, candidate);
    else kept.push(candidate);
  }
  return kept;
}

/** Reading order: rows by vertical center (within tolerance), then left to right. */
export function sortReadingOrder<T extends { box: SomBox }>(
  items: readonly T[],
  rowTolerance = READING_ROW_TOLERANCE_PX
): T[] {
  const centerY = (item: T) => item.box.y + item.box.height / 2;
  const byTop = [...items].sort((a, b) => centerY(a) - centerY(b) || a.box.x - b.box.x);
  const rows: T[][] = [];
  let anchor = Number.NEGATIVE_INFINITY;
  for (const item of byTop) {
    const current = rows[rows.length - 1];
    if (current && centerY(item) - anchor <= rowTolerance) {
      current.push(item);
    } else {
      rows.push([item]);
      anchor = centerY(item);
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.box.x - b.box.x || a.box.y - b.box.y));
}

export function fuseSetOfMarks(
  candidates: readonly SomCandidate[],
  options: FuseSetOfMarksOptions = {}
): SomMark[] {
  const working: WorkingCandidate[] = [];
  candidates.forEach((candidate, order) => {
    if (!finiteBox(candidate.box)) return;
    const box = clipBox(candidate.box, options.imageSize);
    if (!box) return;
    working.push({
      box,
      kind: candidate.kind,
      label: cleanLabel(candidate.label),
      score: Number.isFinite(candidate.score) ? candidate.score : 0,
      ref: candidate.ref,
      sources: new Set([candidate.source]),
      order,
    });
  });

  const labelled = suppressTextInsideIcons(working, options.coverage ?? ICON_TEXT_COVERAGE);
  const unique = nonMaximumSuppression(labelled, options.iou ?? NMS_IOU_THRESHOLD);
  const ordered = sortReadingOrder(unique, options.rowTolerance ?? READING_ROW_TOLERANCE_PX);
  return ordered.slice(0, options.maxMarks ?? DEFAULT_MAX_MARKS).map((candidate, index) => ({
    n: index + 1,
    box: candidate.box,
    center: boxCenter(candidate.box),
    kind: candidate.kind,
    ...(candidate.label ? { label: candidate.label } : {}),
    sources: SOURCE_ORDER.filter((source) => candidate.sources.has(source)),
    ...(candidate.ref ? { ref: candidate.ref } : {}),
  }));
}

/** OCR confidence is 0..100 for most providers and 0..1 for some; normalise to 0..1. */
function normalizeConfidence(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence <= 0) return 0;
  return confidence > 1 ? Math.min(1, confidence / 100) : confidence;
}

/** OCR lines as text candidates in image pixels (normalized boxes are scaled). */
export function candidatesFromOcr(result: OcrResult, imageSize: SomImageSize): SomCandidate[] {
  if (result.status !== 'succeeded' || !Array.isArray(result.lines)) return [];
  const normalized = result.boundingBoxUnits === 'normalized';
  const candidates: SomCandidate[] = [];
  for (const line of result.lines) {
    const label = cleanLabel(line.text);
    const raw = line.boundingBox;
    if (!label || !raw) continue;
    const box = normalized
      ? {
          x: raw.x * imageSize.width,
          y: raw.y * imageSize.height,
          width: raw.width * imageSize.width,
          height: raw.height * imageSize.height,
        }
      : { ...raw };
    if (!finiteBox(box)) continue;
    candidates.push({
      box,
      source: 'ocr',
      kind: 'text',
      label,
      score: normalizeConfidence(line.confidence),
    });
  }
  return candidates;
}

/** Minimal shape of a browser snapshot element (browser-actuator `@eN` refs). */
export interface SomDomElement {
  ref: string;
  /** CSS pixels relative to the viewport. */
  bbox?: SomBox;
  name?: string | null;
  text?: string | null;
  role?: string | null;
  tag?: string | null;
  editable?: boolean;
  visible?: boolean;
}

export interface DomCandidateOptions {
  /** Screenshot pixels per CSS pixel (devicePixelRatio). Default 1. */
  scale?: number;
}

/** Browser snapshot elements as control candidates in image pixels. */
export function candidatesFromDomSnapshot(
  elements: readonly SomDomElement[],
  options: DomCandidateOptions = {}
): SomCandidate[] {
  const scale = options.scale && options.scale > 0 ? options.scale : 1;
  const candidates: SomCandidate[] = [];
  for (const element of elements) {
    if (!element || element.visible === false || !finiteBox(element.bbox)) continue;
    const box = {
      x: element.bbox.x * scale,
      y: element.bbox.y * scale,
      width: element.bbox.width * scale,
      height: element.bbox.height * scale,
    };
    const label = cleanLabel(element.name ?? undefined) ?? cleanLabel(element.text ?? undefined);
    candidates.push({
      box,
      source: 'dom',
      kind: 'control',
      ...(label ? { label } : {}),
      score: 1,
      ref: element.ref,
    });
  }
  return candidates;
}
