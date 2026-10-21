/**
 * OOXML package integrity for PPTX files.
 *
 * `inspectPptxPackage` finds the structural defects that make PowerPoint
 * demand a repair (empty text bodies, broken or dangling relationships,
 * missing content types, duplicate slide ids). Every governed PPTX writer in
 * the media actuator calls `assertPptxPackage` on the bytes it is about to
 * write, so a defective package is refused instead of landing on disk.
 *
 * `diffPptxPackages` compares two packages part by part and separates real
 * changes from serialisation noise (attribute order, embedded font subsets).
 */
import AdmZip from 'adm-zip';
import * as path from 'node:path';
import { logger } from '@agent/core/core';

export type PptxIssueSeverity = 'error' | 'warn';

export type PptxIssueCode =
  | 'EMPTY_TXBODY'
  | 'BROKEN_REL'
  | 'DANGLING_RID'
  | 'MISSING_CONTENT_TYPE'
  | 'DUPLICATE_SLDID'
  | 'ORPHAN_PART'
  | 'CHANGES_INFO_PRESENT';

export interface PptxPackageIssue {
  severity: PptxIssueSeverity;
  code: PptxIssueCode;
  part: string;
  detail: string;
}

export interface PptxPackageReport {
  ok: boolean;
  issues: PptxPackageIssue[];
}

export interface PptxRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
  raw: string;
}

const EXPECTED_CONTENT_TYPES: Array<{ pattern: RegExp; contentType: string }> = [
  {
    pattern: /^ppt\/slides\/slide\d+\.xml$/u,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  },
  {
    pattern: /^ppt\/slideLayouts\/slideLayout\d+\.xml$/u,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  },
  {
    pattern: /^ppt\/slideMasters\/slideMaster\d+\.xml$/u,
    contentType: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  },
];

/** Parts whose relationship ids are checked against their own rels part. */
const RID_CHECKED_PART = /^ppt\/(?:slides|slideLayouts|slideMasters)\/[^/]+\.xml$/u;
/** Parts whose text bodies must hold at least one paragraph. */
const TXBODY_CHECKED_PART =
  /^ppt\/(?:slides|slideLayouts|slideMasters|notesSlides|notesMasters|handoutMasters)\/[^/]+\.xml$/u;

// ---------------------------------------------------------------------------
// Package access helpers (shared with the slide replacement writer)
// ---------------------------------------------------------------------------

/** Read every file entry of a PPTX buffer into a part-name → bytes map. */
export function readPptxParts(buffer: Buffer, label = 'pptx'): Map<string, Buffer> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (error) {
    throw new Error(
      `${label}: cannot open the PPTX package — the bytes are not a readable ZIP archive | next: check that the path points at a .pptx file | evidence: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const parts = new Map<string, Buffer>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    parts.set(entry.entryName, entry.getData());
  }
  return parts;
}

/** Serialise a part map back into a ZIP buffer ([Content_Types].xml first). */
export function writePptxParts(parts: Map<string, Buffer>): Buffer {
  const zip = new AdmZip();
  const names = [...parts.keys()].sort((a, b) => {
    if (a === '[Content_Types].xml') return -1;
    if (b === '[Content_Types].xml') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const name of names) zip.addFile(name, parts.get(name)!);
  return zip.toBuffer();
}

export function partText(parts: Map<string, Buffer>, name: string): string | undefined {
  return parts.get(name)?.toString('utf8');
}

/** `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`; the package itself → `_rels/.rels`. */
export function relsPartFor(partName: string): string {
  if (!partName) return '_rels/.rels';
  const dir = path.posix.dirname(partName);
  const base = path.posix.basename(partName);
  return dir === '.' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/** `ppt/slides/_rels/slide1.xml.rels` → `ppt/slides/slide1.xml`; `_rels/.rels` → '' (the package). */
export function sourcePartForRels(relsPart: string): string {
  const match = relsPart.match(/^(.*?)_rels\/([^/]*)\.rels$/u);
  if (!match) return relsPart;
  return `${match[1]}${match[2]}`;
}

/** Resolve a relationship Target against the source part of its rels part. */
export function resolveRelTarget(relsPart: string, target: string): string {
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    decoded = target;
  }
  if (decoded.startsWith('/')) return path.posix.normalize(decoded.slice(1));
  const source = sourcePartForRels(relsPart);
  const baseDir = source.includes('/') ? path.posix.dirname(source) : '';
  const joined = path.posix.normalize(baseDir ? `${baseDir}/${decoded}` : decoded);
  return joined.replace(/^(\.\/)+/u, '');
}

export function readAttr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = tag.match(new RegExp(`\\s${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'u'));
  if (!match) return undefined;
  return match[1] ?? match[2];
}

export function parseRelationships(xml: string): PptxRelationship[] {
  const rels: PptxRelationship[] = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*?\/?>/gu)) {
    const raw = match[0];
    rels.push({
      id: readAttr(raw, 'Id') ?? '',
      type: readAttr(raw, 'Type') ?? '',
      target: readAttr(raw, 'Target') ?? '',
      external: (readAttr(raw, 'TargetMode') ?? '').toLowerCase() === 'external',
      raw,
    });
  }
  return rels;
}

/** Every value of an attribute in the `r:` (relationships) namespace: r:id, r:embed, r:link, r:dm, ... */
export function collectRelationshipRefs(xml: string): Set<string> {
  const refs = new Set<string>();
  for (const match of xml.matchAll(/\sr:[A-Za-z]+\s*=\s*"([^"]*)"/gu)) {
    if (match[1]) refs.add(match[1]);
  }
  return refs;
}

interface ContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

export function parseContentTypes(xml: string): ContentTypes {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const match of xml.matchAll(/<Default\b[^>]*\/?>/gu)) {
    const ext = readAttr(match[0], 'Extension');
    const type = readAttr(match[0], 'ContentType');
    if (ext && type) defaults.set(ext.toLowerCase(), type);
  }
  for (const match of xml.matchAll(/<Override\b[^>]*\/?>/gu)) {
    const partName = readAttr(match[0], 'PartName');
    const type = readAttr(match[0], 'ContentType');
    if (partName && type) overrides.set(partName.replace(/^\//u, ''), type);
  }
  return { defaults, overrides };
}

function contentTypeOf(types: ContentTypes, part: string): string | undefined {
  const override = types.overrides.get(part);
  if (override) return override;
  // basename-based so dot-files such as `_rels/.rels` resolve to the `rels` Default.
  const base = path.posix.basename(part);
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  return ext ? types.defaults.get(ext) : undefined;
}

// ---------------------------------------------------------------------------
// Inspection
// ---------------------------------------------------------------------------

function inspectTextBodies(part: string, xml: string, issues: PptxPackageIssue[]): void {
  const pattern = /<(p|a):txBody\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1:txBody>)/gu;
  let index = 0;
  for (const match of xml.matchAll(pattern)) {
    index += 1;
    const inner = match[2] ?? '';
    if (!/<a:p[\s>/]/u.test(inner)) {
      issues.push({
        severity: 'error',
        code: 'EMPTY_TXBODY',
        part,
        detail: `<${match[1]}:txBody> #${index} has no <a:p> paragraph (PowerPoint requires at least one)`,
      });
    }
  }
}

export function inspectPptxPackage(buffer: Buffer): PptxPackageReport {
  const parts = readPptxParts(buffer, 'inspectPptxPackage');
  const issues: PptxPackageIssue[] = [];
  const relsByPart = new Map<string, PptxRelationship[]>();

  for (const [name, data] of parts) {
    if (!name.endsWith('.rels')) continue;
    const rels = parseRelationships(data.toString('utf8'));
    relsByPart.set(name, rels);
    for (const rel of rels) {
      if (rel.external) continue;
      if (/^[a-z][a-z0-9+.-]*:/iu.test(rel.target)) continue;
      if (isPlaceholderTarget(rel.target)) {
        // Some producers write Target="NULL" or an in-document "#anchor"; PowerPoint
        // tolerates both, so they are worth a look but do not block a write.
        issues.push({
          severity: 'warn',
          code: 'BROKEN_REL',
          part: name,
          detail: `${rel.id || '(no Id)'} → ${rel.target} is a placeholder target, not a part`,
        });
        continue;
      }
      const resolved = resolveRelTarget(name, rel.target);
      if (!parts.has(resolved)) {
        issues.push({
          severity: 'error',
          code: 'BROKEN_REL',
          part: name,
          detail: `${rel.id || '(no Id)'} → ${rel.target} resolves to missing part ${resolved}`,
        });
      }
    }
  }

  const contentTypesXml = partText(parts, '[Content_Types].xml');
  const contentTypes = contentTypesXml ? parseContentTypes(contentTypesXml) : undefined;
  if (!contentTypes) {
    issues.push({
      severity: 'error',
      code: 'MISSING_CONTENT_TYPE',
      part: '[Content_Types].xml',
      detail: 'the package has no [Content_Types].xml',
    });
  }

  for (const [name, data] of parts) {
    if (name === '[Content_Types].xml') continue;
    if (contentTypes) {
      const actual = contentTypeOf(contentTypes, name);
      const expected = EXPECTED_CONTENT_TYPES.find((entry) => entry.pattern.test(name));
      if (!actual) {
        issues.push({
          severity: 'error',
          code: 'MISSING_CONTENT_TYPE',
          part: name,
          detail: 'no <Override> for the part and no <Default> for its extension',
        });
      } else if (expected && actual !== expected.contentType) {
        issues.push({
          severity: 'error',
          code: 'MISSING_CONTENT_TYPE',
          part: name,
          detail: `content type is ${actual}; expected an <Override> with ${expected.contentType}`,
        });
      }
    }
    if (TXBODY_CHECKED_PART.test(name)) inspectTextBodies(name, data.toString('utf8'), issues);
    if (RID_CHECKED_PART.test(name)) {
      const xml = data.toString('utf8');
      const ids = new Set((relsByPart.get(relsPartFor(name)) ?? []).map((rel) => rel.id));
      for (const ref of collectRelationshipRefs(xml)) {
        if (!ids.has(ref)) {
          issues.push({
            severity: 'error',
            code: 'DANGLING_RID',
            part: name,
            detail: `${ref} is used in the XML but ${relsPartFor(name)} has no such relationship`,
          });
        }
      }
    }
    if (name.startsWith('ppt/changesInfos/')) {
      issues.push({
        severity: 'warn',
        code: 'CHANGES_INFO_PRESENT',
        part: name,
        detail:
          'co-authoring change history is present; it refers to slide content and goes stale when slides are rewritten',
      });
    }
  }

  // Every part must be reachable from the package root through relationships.
  const reachable = reachableParts(parts, relsByPart);
  for (const name of parts.keys()) {
    if (name === '[Content_Types].xml' || reachable.has(name)) continue;
    if (name.endsWith('.rels')) {
      const source = sourcePartForRels(name);
      if (name === '_rels/.rels' || reachable.has(source)) continue;
    }
    issues.push({
      severity: 'warn',
      code: 'ORPHAN_PART',
      part: name,
      detail: name.endsWith('.rels')
        ? 'relationship part of a part that is not in the package graph'
        : 'part is not reachable from the package root through any relationship',
    });
  }

  const presentationXml = partText(parts, 'ppt/presentation.xml');
  if (presentationXml) {
    const list = presentationXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/u)?.[1] ?? '';
    const seenIds = new Map<string, number>();
    const seenRids = new Map<string, number>();
    const entries = parseSldIdEntries(list);
    if (!entries) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_SLDID',
        part: 'ppt/presentation.xml',
        detail: '<p:sldIdLst> contains <p:sldId> elements that could not be parsed',
      });
    }
    for (const raw of entries ?? []) {
      const id = readAttr(raw, 'id') ?? '';
      const rid = readAttr(raw, 'r:id') ?? '';
      seenIds.set(id, (seenIds.get(id) ?? 0) + 1);
      seenRids.set(rid, (seenRids.get(rid) ?? 0) + 1);
      const numeric = Number(id);
      if (!Number.isInteger(numeric) || numeric < 256 || numeric >= 2147483648) {
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_SLDID',
          part: 'ppt/presentation.xml',
          detail: `slide id ${id} is outside the valid range 256..2147483647`,
        });
      }
    }
    for (const [id, count] of seenIds) {
      if (count > 1) {
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_SLDID',
          part: 'ppt/presentation.xml',
          detail: `slide id ${id} appears ${count} times in <p:sldIdLst>`,
        });
      }
    }
    for (const [rid, count] of seenRids) {
      if (count > 1) {
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_SLDID',
          part: 'ppt/presentation.xml',
          detail: `relationship ${rid} is used by ${count} <p:sldId> entries`,
        });
      }
    }
    const presentationRids = new Set(
      (relsByPart.get('ppt/_rels/presentation.xml.rels') ?? []).map((rel) => rel.id)
    );
    for (const rid of seenRids.keys()) {
      if (rid && !presentationRids.has(rid)) {
        issues.push({
          severity: 'error',
          code: 'DANGLING_RID',
          part: 'ppt/presentation.xml',
          detail: `<p:sldId r:id="${rid}"> has no relationship in ppt/_rels/presentation.xml.rels`,
        });
      }
    }
  }

  return { ok: !issues.some((issue) => issue.severity === 'error'), issues };
}

/** Rel targets some producers write instead of a part name (`NULL`, `#anchor`). */
export function isPlaceholderTarget(target: string): boolean {
  return target === 'NULL' || target.startsWith('#');
}

/**
 * Raw `<p:sldId>` elements of a sldIdLst body, self-closing or with children.
 * Returns undefined when the parsed count disagrees with the `<p:sldId` count,
 * so callers fail closed instead of silently skipping an entry.
 */
export function parseSldIdEntries(listXml: string): string[] | undefined {
  const entries = [...listXml.matchAll(/<p:sldId\b[^>]*?(?:\/>|>[\s\S]*?<\/p:sldId>)/gu)].map(
    (m) => m[0]
  );
  const occurrences = (listXml.match(/<p:sldId\b/gu) ?? []).length;
  return entries.length === occurrences ? entries : undefined;
}

/** Parts reachable from `_rels/.rels` through internal relationships. */
function reachableParts(
  parts: Map<string, Buffer>,
  relsByPart: Map<string, PptxRelationship[]>
): Set<string> {
  const reachable = new Set<string>();
  const queue = ['_rels/.rels'];
  while (queue.length) {
    const relsPart = queue.shift()!;
    for (const rel of relsByPart.get(relsPart) ?? []) {
      if (rel.external || isPlaceholderTarget(rel.target)) continue;
      if (/^[a-z][a-z0-9+.-]*:/iu.test(rel.target)) continue;
      const target = resolveRelTarget(relsPart, rel.target);
      if (reachable.has(target) || !parts.has(target)) continue;
      reachable.add(target);
      reachable.add(relsPartFor(target));
      queue.push(relsPartFor(target));
    }
  }
  return reachable;
}

export type PptxPackageCheckLevel = 'error' | 'warn' | 'never';

/**
 * Where a source part ends up after a write: its new name, or undefined when
 * the write removed or overwrote it. Defaults to identity (text patch writers).
 */
export type PptxPartMap = (sourcePart: string) => string | undefined;

/**
 * Split error issues of `report` into those inherited from `baseline` and those
 * the writer introduced. A baseline issue is credited only when its part still
 * exists in the output under the name `partMap` gives it, with the same code
 * (one credit per baseline issue). Issues on parts the write removed or
 * overwrote never excuse a new defect.
 */
export function partitionIntroducedIssues(
  report: PptxPackageReport,
  baseline?: PptxPackageReport,
  options: { outputParts?: Set<string>; partMap?: PptxPartMap } = {}
): { introduced: PptxPackageIssue[]; inherited: PptxPackageIssue[] } {
  const errors = report.issues.filter((issue) => issue.severity === 'error');
  if (!baseline) return { introduced: errors, inherited: [] };
  const partMap = options.partMap ?? ((part: string) => part);
  const credit = new Map<string, number>();
  for (const issue of baseline.issues) {
    if (issue.severity !== 'error') continue;
    const mapped = partMap(issue.part);
    if (mapped === undefined) continue;
    if (options.outputParts && !options.outputParts.has(mapped)) continue;
    const key = `${issue.code}|${mapped}`;
    credit.set(key, (credit.get(key) ?? 0) + 1);
  }
  const introduced: PptxPackageIssue[] = [];
  const inherited: PptxPackageIssue[] = [];
  for (const issue of errors) {
    const key = `${issue.code}|${issue.part}`;
    const left = credit.get(key) ?? 0;
    if (left > 0) {
      credit.set(key, left - 1);
      inherited.push(issue);
    } else {
      introduced.push(issue);
    }
  }
  return { introduced, inherited };
}

function evidenceOf(issues: PptxPackageIssue[]): string {
  const shown = issues
    .slice(0, 8)
    .map((issue) => `${issue.code} ${issue.part}: ${issue.detail}`)
    .join('; ');
  return issues.length > 8 ? `${shown} (+${issues.length - 8} more)` : shown;
}

/**
 * Write gate for PPTX writers. Edit writers pass the source deck as `baseline`:
 * defects the source already had are logged as a warning and written through;
 * only defects the writer introduced refuse the write. `level` lets an operator
 * downgrade (`warn`: log only) or skip (`never`) the gate explicitly.
 */
export function assertPptxPackageWrite(
  buffer: Buffer,
  label: string,
  options: {
    baseline?: Buffer | PptxPackageReport;
    level?: PptxPackageCheckLevel;
    partMap?: PptxPartMap;
  } = {}
): PptxPackageReport {
  const level = options.level ?? 'error';
  if (!['error', 'warn', 'never'].includes(level)) {
    throw new Error(
      `${label}: package_check '${String(level)}' is not supported — the write gate level is ambiguous | next: use error, warn or never | evidence: package_check=${String(level)}`
    );
  }
  const report = inspectPptxPackage(buffer);
  if (level === 'never') return report;
  const baseline = Buffer.isBuffer(options.baseline)
    ? inspectPptxPackage(options.baseline)
    : options.baseline;
  const outputParts = new Set(readPptxParts(buffer, label).keys());
  const { introduced, inherited } = partitionIntroducedIssues(report, baseline, {
    outputParts,
    partMap: options.partMap,
  });
  if (inherited.length > 0) {
    logger.warn(
      `${label}: writing a PPTX that keeps ${inherited.length} structural defect(s) inherited from the source deck — PowerPoint may still ask to repair it | next: run media:pptx_package_check on the source and repair it | evidence: ${evidenceOf(inherited)}`
    );
  }
  if (introduced.length > 0) {
    if (level === 'warn') {
      logger.warn(
        `${label}: package_check=warn lets ${introduced.length} new structural defect(s) through — PowerPoint will likely demand a repair | next: fix the writer input or restore package_check=error | evidence: ${evidenceOf(introduced)}`
      );
      return report;
    }
    throw new Error(
      `${label}: refused to write a defective PPTX package — ${introduced.length} structural error(s) introduced by this write would make PowerPoint demand a repair | next: fix the writer or its input (inherited source defects are only warned about; package_check=warn overrides) | evidence: ${evidenceOf(introduced)}`
    );
  }
  return report;
}

/**
 * Part map for a writer that renames slides (`renames`: old slide part → new
 * slide part) and drops every other slide. Slide rels follow their slide;
 * `overwritten` parts (rewritten wholesale by the writer) are never credited.
 */
export function slideRenamePartMap(
  renames: Map<string, string>,
  overwritten: Iterable<string> = []
): PptxPartMap {
  const map = new Map<string, string>();
  for (const [from, to] of renames) {
    map.set(from, to);
    map.set(relsPartFor(from), relsPartFor(to));
  }
  const gone = new Set(overwritten);
  return (part) => {
    if (gone.has(part)) return undefined;
    if (map.has(part)) return map.get(part);
    if (/^ppt\/slides\/(?:_rels\/)?slide\d+\.xml(?:\.rels)?$/u.test(part)) return undefined;
    return part;
  };
}

/** Throw a diagnostic error when the package has any error-severity issue. */
export function assertPptxPackage(buffer: Buffer, label: string): PptxPackageReport {
  const report = inspectPptxPackage(buffer);
  if (!report.ok) {
    const errors = report.issues.filter((issue) => issue.severity === 'error');
    const evidence = errors
      .slice(0, 8)
      .map((issue) => `${issue.code} ${issue.part}: ${issue.detail}`)
      .join('; ');
    const more = errors.length > 8 ? ` (+${errors.length - 8} more)` : '';
    throw new Error(
      `${label}: refused to write a defective PPTX package — ${errors.length} structural error(s) would make PowerPoint demand a repair | next: fix the writer or the source deck (run media:pptx_package_check on the source to see inherited defects) | evidence: ${evidence}${more}`
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export interface PptxTagDiff {
  before: string;
  after: string;
}

export interface PptxChangedPart {
  part: string;
  size_before: number;
  size_after: number;
  tag_diffs: PptxTagDiff[];
  noise_only: boolean;
  truncated?: boolean;
}

export interface PptxPackageDiffSummary {
  only_in_before: number;
  only_in_after: number;
  changed: number;
  noise_only: number;
  /** First five changed parts that are not noise, in relevance order. */
  significant_parts: string[];
}

export interface PptxPackageDiff {
  only_in_before: string[];
  only_in_after: string[];
  /** Ordered by relevance: package structure, then slides/layouts/masters, then the rest. */
  changed: PptxChangedPart[];
  summary: PptxPackageDiffSummary;
}

export interface PptxPackageDiffOptions {
  /** Glob over part names (`*` within a segment, `**` across segments); string or list. */
  parts?: string | string[];
  /** Maximum tag diffs reported per part (default 20). */
  max_tag_diffs?: number;
  /** Maximum LCS matrix cells before falling back to a single block diff (default 4,000,000). */
  max_lcs_cells?: number;
}

const NOISE_BINARY_PART = /(?:^|\/)fonts\/[^/]+\.fntdata$/u;
/** Document properties (app/core/custom) change on every save and carry no slide content. */
const NOISE_PART = /^docProps\//u;

/** 0 = package structure, 1 = slides / layouts / masters, 2 = everything else. */
function diffRelevance(part: string): number {
  if (part === '[Content_Types].xml' || part.endsWith('.rels') || part === 'ppt/presentation.xml') {
    return 0;
  }
  if (/^ppt\/(?:slides|slideLayouts|slideMasters)\//u.test(part)) return 1;
  return 2;
}
const XML_PART = /\.(?:xml|rels|vml)$/iu;
const SNIPPET_LIMIT = 400;

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        source += '.*';
        i += 1;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/gu, '\\$&');
    }
  }
  return new RegExp(`^${source}$`, 'u');
}

/** Tokenise XML by tags, sorting attributes so attribute order is not a difference. */
export function tokenizeXml(xml: string): string[] {
  const tokens: string[] = [];
  for (const raw of xml.split(/(?=<)/u)) {
    if (!raw) continue;
    const close = raw.indexOf('>');
    if (!raw.startsWith('<') || close < 0) {
      const text = raw.trim() === '' ? '' : raw;
      if (text) tokens.push(text);
      continue;
    }
    const tag = raw.slice(0, close + 1);
    const text = raw.slice(close + 1);
    tokens.push(normalizeTag(tag) + (text.trim() === '' ? '' : text));
  }
  return tokens;
}

function normalizeTag(tag: string): string {
  if (/^<[?!]/u.test(tag) || tag.startsWith('</')) return tag;
  const match = tag.match(/^<([^\s/>]+)([\s\S]*?)(\/?)>$/u);
  if (!match) return tag;
  // Namespace declarations and mc:Ignorable lists are serialisation detail.
  const attrs = [...match[2]!.matchAll(/([^\s=]+)\s*=\s*("[^"]*"|'[^']*')/gu)]
    .filter((attr) => !/^xmlns(?::|$)/u.test(attr[1]!) && attr[1] !== 'mc:Ignorable')
    .map((attr) => `${attr[1]}=${attr[2]!.replace(/^'|'$/gu, '"')}`)
    .sort();
  return `<${match[1]}${attrs.length ? ` ${attrs.join(' ')}` : ''}${match[3]}>`;
}

function clip(text: string): string {
  return text.length > SNIPPET_LIMIT ? `${text.slice(0, SNIPPET_LIMIT)}…` : text;
}

/** LCS-aligned hunks between two token arrays (common prefix/suffix trimmed first). */
function diffTokens(
  a: string[],
  b: string[],
  maxDiffs: number,
  maxCells: number
): { diffs: PptxTagDiff[]; truncated: boolean } {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return { diffs: [], truncated: false };

  const n = midA.length;
  const m = midB.length;
  if ((n + 1) * (m + 1) > maxCells) {
    return {
      diffs: [{ before: clip(midA.join('')), after: clip(midB.join('')) }],
      truncated: true,
    };
  }
  // lcs[i][j] = LCS length of midA[i..] and midB[j..]
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        midA[i] === midB[j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  const diffs: PptxTagDiff[] = [];
  let removed: string[] = [];
  let added: string[] = [];
  let truncated = false;
  const flush = () => {
    if (removed.length === 0 && added.length === 0) return;
    if (diffs.length < maxDiffs) {
      diffs.push({ before: clip(removed.join('')), after: clip(added.join('')) });
    } else {
      truncated = true;
    }
    removed = [];
    added = [];
  };
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      flush();
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || lcs[i * width + j + 1]! >= lcs[(i + 1) * width + j]!)) {
      added.push(midB[j]!);
      j += 1;
    } else {
      removed.push(midA[i]!);
      i += 1;
    }
  }
  flush();
  return { diffs, truncated };
}

export function diffPptxPackages(
  beforeBuf: Buffer,
  afterBuf: Buffer,
  opts: PptxPackageDiffOptions = {}
): PptxPackageDiff {
  const before = readPptxParts(beforeBuf, 'diffPptxPackages(before)');
  const after = readPptxParts(afterBuf, 'diffPptxPackages(after)');
  const globs = (Array.isArray(opts.parts) ? opts.parts : opts.parts ? [opts.parts] : []).map(
    globToRegExp
  );
  const included = (part: string) => globs.length === 0 || globs.some((glob) => glob.test(part));
  const maxDiffs = Math.max(1, opts.max_tag_diffs ?? 20);
  const maxCells = Math.max(1, opts.max_lcs_cells ?? 4_000_000);
  const sorted = (values: Iterable<string>) => [...values].filter(included).sort();

  const changed: PptxChangedPart[] = [];
  for (const part of sorted(before.keys())) {
    const a = before.get(part)!;
    const b = after.get(part);
    if (!b || a.equals(b)) continue;
    const entry: PptxChangedPart = {
      part,
      size_before: a.length,
      size_after: b.length,
      tag_diffs: [],
      noise_only: false,
    };
    if (NOISE_PART.test(part)) {
      entry.noise_only = true;
    } else if (XML_PART.test(part)) {
      const tokensA = tokenizeXml(a.toString('utf8'));
      const tokensB = tokenizeXml(b.toString('utf8'));
      const same =
        tokensA.length === tokensB.length && tokensA.every((token, i) => token === tokensB[i]);
      if (same) {
        entry.noise_only = true;
      } else {
        const { diffs, truncated } = diffTokens(tokensA, tokensB, maxDiffs, maxCells);
        entry.tag_diffs = diffs;
        if (truncated) entry.truncated = true;
      }
    } else {
      entry.noise_only = NOISE_BINARY_PART.test(part);
    }
    changed.push(entry);
  }

  changed.sort(
    (x, y) =>
      diffRelevance(x.part) - diffRelevance(y.part) ||
      (x.part < y.part ? -1 : x.part > y.part ? 1 : 0)
  );
  const onlyInBefore = sorted(before.keys()).filter((part) => !after.has(part));
  const onlyInAfter = sorted(after.keys()).filter((part) => !before.has(part));
  const noise = changed.filter((entry) => entry.noise_only).length;
  return {
    only_in_before: onlyInBefore,
    only_in_after: onlyInAfter,
    changed,
    summary: {
      only_in_before: onlyInBefore.length,
      only_in_after: onlyInAfter.length,
      changed: changed.length,
      noise_only: noise,
      significant_parts: changed
        .filter((entry) => !entry.noise_only)
        .slice(0, 5)
        .map((entry) => entry.part),
    },
  };
}
