/**
 * Protocol-level text fit: does every text box in a PptxDesignProtocol hold
 * its text the way the author laid it out?
 *
 * `pptx_layout_preflight` / `pptx_render` used to read only the fit results a
 * slide *builder* had recorded in `slide.metadata.layoutFit`. A hand-authored
 * or template-derived protocol carries none, so the gate passed every deck it
 * was given — including labels that wrapped in a chevron and body boxes whose
 * last line ran past the bottom edge. This module measures any protocol from
 * its elements alone and reports two distinct issue kinds:
 *
 *   - `overflow`        needed lines × line height push text past the box edge
 *                       (text area height plus the padding on the side
 *                       the anchor leaves free);
 *   - `unexpected_wrap` a paragraph the author wrote as one line will wrap
 *                       (labels, centred headlines, boxes sized to the
 *                       authored lines — where a wrap is always a defect).
 *
 * The width model follows what LibreOffice / PowerPoint actually do with
 * Japanese text: full-width glyphs are 1em, the renderer inserts ~¼em of
 * autospace at every CJK↔Latin boundary, lines break at any CJK character
 * (subject to kinsoku) but never inside a Latin word, the text area is the
 * preset shape's text rectangle minus the bodyPr insets (0.1in / 0.05in by
 * default), and a line is size × 1.2 × lineSpacing tall.
 *
 * Deterministic and file-free (no fonts are read), so it runs in every
 * preflight. Calibration against LibreOffice lives in protocol-text-fit.test.ts
 * and the post-render check (`pptx_render_check`) reports where the model and
 * the real renderer disagree.
 */

import type { PptxDesignProtocol, PptxElement } from '@agent/core/contracts/pptx-protocol';
import { applyPptxDesignDefaults } from '@agent/core/media/native-pptx-engine/design-cascade';
import { kinsokuAllowsBreak } from './ja-line-break.js';

// The measurement side of the post-render check ships under this subpath too.
export { extractPdfTextRuns, pdfTextItemsToRuns } from './pdf-text-runs.js';
export type { PdfJsTextItem, PdfPageSize, PdfTextRunsResult } from './pdf-text-runs.js';

export const PPTX_TEXT_FIT_MODEL = 'renderer-width-table-v1' as const;

export type PptxTextFitIssueKind = 'overflow' | 'unexpected_wrap';

export interface PptxTextFitIssue {
  kind: PptxTextFitIssueKind;
  /** overflow = error (text leaves its box); unexpected_wrap = warn. */
  severity: 'error' | 'warn';
  /** 1-based, matching how people and PDFs number slides. */
  slideIndex: number;
  slideId?: string;
  /** 0-based index into slide.elements. */
  elementIndex: number;
  elementName?: string;
  shapeType: string;
  excerpt: string;
  fontSizePt: number;
  /** 0-based paragraph (authored "\n" segment) that wraps, for unexpected_wrap. */
  paragraphIndex?: number;
  /** Lines the author wrote (paragraph count). */
  authoredLines: number;
  /** Lines the model (pre-render) or the renderer (post-render) produced. */
  lines: number;
  requiredHeightIn: number;
  availableHeightIn: number;
  availableWidthIn: number;
  /** pre-render = model prediction; post-render = measured in the rendered PDF. */
  source: 'model' | 'render';
  detail: string;
}

export interface PptxTextFitReport {
  status: 'pass' | 'warn' | 'overflow';
  measurementModel: typeof PPTX_TEXT_FIT_MODEL;
  checkedElements: number;
  /** Text elements the model cannot judge (raw template XML, no font size, rotated, …). */
  skippedElements: number;
  overflowCount: number;
  unexpectedWrapCount: number;
  issues: PptxTextFitIssue[];
}

/** Absolute rectangle on the slide, inches. */
export interface PptxRectIn {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the model expects one text box to look like once rendered. */
export interface PptxTextBoxPrediction {
  slideIndex: number;
  slideId?: string;
  elementIndex: number;
  elementName?: string;
  shapeType: string;
  text: string;
  paragraphs: string[];
  /** Font size per authored paragraph (textRuns may mix sizes). */
  paragraphSizesPt: number[];
  /** Largest size in the box. */
  fontSizePt: number;
  bold: boolean;
  /** Selects the Latin width table; absent = the brand stack (Helvetica-class). */
  fontFamily?: string;
  align: 'left' | 'center' | 'right' | 'justify';
  valign: 'top' | 'middle' | 'bottom';
  /** The element's bounding box. */
  box: PptxRectIn;
  /** Where text may be laid out: preset text rectangle minus insets. */
  textArea: PptxRectIn;
  /** Space between the text area and the box edge (shape + bodyPr insets), inches. */
  padTopIn: number;
  padBottomIn: number;
  lineHeightIn: number;
  linesPerParagraph: number[];
  lineCount: number;
  requiredHeightIn: number;
  widestLineIn: number;
  /** Wrapping is a defect here (label, centred line, box sized to the authored lines). */
  wrapSensitive: boolean;
  /** Renderer shrinks or grows the box: height overflow is not a defect. */
  autofit: 'none' | 'normal' | 'shrink';
}

const POINTS_PER_INCH = 72;

/** bodyPr defaults (ECMA-376 §21.1.2.1.1): 91440 EMU left/right, 45720 top/bottom. */
const DEFAULT_INSETS_IN: [number, number, number, number] = [0.05, 0.1, 0.05, 0.1];

/** Single line height as a multiple of font size (ascent + descent + gap). */
const DEFAULT_LINE_FACTOR = 1.2;

/** The last line's leading below the glyphs is not visible ink — allow it. */
const LAST_LINE_SLACK_EM = 0.15;

/** Autospace the renderer inserts between CJK and Latin runs (em). */
const CJK_LATIN_AUTOSPACE_EM = 0.25;

/**
 * A run that is wider than the text area by less than this still wraps in
 * LibreOffice (box geometry is rounded to 1/100 mm), so "exactly fits" is
 * treated as a wrap.
 */
const FIT_EPSILON_EM = 0.05;

// ───────────────────────────── character widths ─────────────────────────────

/**
 * Full-width in CJK fonts: ideographs, kana, full-width forms and the symbol
 * blocks Japanese decks lean on (①, →, ■, ※, ★). Wider than text-metrics'
 * table on purpose: in a Japanese font these glyphs are square.
 */
export function isRendererFullwidth(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x203b || // ※
    (code >= 0x2190 && code <= 0x21ff) || // arrows
    (code >= 0x2460 && code <= 0x24ff) || // ①②… enclosed alphanumerics
    (code >= 0x2500 && code <= 0x25ff) || // box drawing, ■●◆
    (code >= 0x2600 && code <= 0x27bf) || // ★☆ ✕ ✓ dingbats
    (code >= 0x2e80 && code <= 0x303f) || // CJK radicals, punctuation,
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** Half-width (Latin) advance widths per character class, in em. */
interface LatinMetrics {
  lower: number;
  upper: number;
  digit: number;
  narrow: number;
  wide: number;
  punct: number;
  space: number;
  /** Bold widening of Latin glyphs (CJK bold faces keep the 1em advance). */
  bold: number;
}

/**
 * Latin widths depend on the Latin typeface. Measured with LibreOffice 25.8:
 * Helvetica / Arial class averages sit within ±5% of `proportional`; BIZ UD
 * (universal-design) fonts set Latin about a quarter wider. Other Japanese UI
 * fonts (Meiryo, Noto Sans JP, Yu Gothic, Hiragino) were not installed on the
 * calibration host, so they use `proportional`: an unmeasured font must not
 * be guessed wider, or the gate would raise wraps the renderer never makes.
 */
const LATIN_METRICS: Record<'proportional' | 'bizUd', LatinMetrics> = {
  proportional: {
    lower: 0.52,
    upper: 0.66,
    digit: 0.56,
    narrow: 0.25,
    wide: 0.85,
    punct: 0.4,
    space: 0.27,
    bold: 1.08,
  },
  bizUd: {
    lower: 0.66,
    upper: 0.76,
    digit: 0.75,
    narrow: 0.35,
    wide: 0.95,
    punct: 0.55,
    space: 0.3,
    bold: 1.03,
  },
};

export type LatinMetricsClass = keyof typeof LATIN_METRICS;

/** Pick the Latin width table for a style.fontFamily value (first family of a stack). */
export function latinMetricsClass(fontFamily?: string): LatinMetricsClass {
  const family = (String(fontFamily || '').split(',')[0] ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLowerCase();
  return /biz\s*ud/.test(family) ? 'bizUd' : 'proportional';
}

const NARROW = new Set(Array.from("iljtfrI.,:;'|!`"));
const WIDE = new Set(Array.from('mwMW@%&'));
const PUNCT = new Set(Array.from('()[]{}-/\\"*+=<>~^_#$?'));

function isLatinWordChar(ch: string): boolean {
  return /[A-Za-z0-9]/.test(ch);
}

/** Advance width of one character in em, before bold / autospace. */
function charEm(ch: string, metrics: LatinMetrics): number {
  if (ch === ' ' || ch === '\t' || ch === ' ') return metrics.space;
  if (isRendererFullwidth(ch)) return 1;
  const code = ch.codePointAt(0) ?? 0;
  if (code >= 0xff61 && code <= 0xff9f) return 0.5; // half-width katakana
  if (NARROW.has(ch)) return metrics.narrow;
  if (WIDE.has(ch)) return metrics.wide;
  if (PUNCT.has(ch)) return metrics.punct;
  if (ch >= 'A' && ch <= 'Z') return metrics.upper;
  if (ch >= '0' && ch <= '9') return metrics.digit;
  // Lowercase and other scripts (accented Latin, Greek, Cyrillic).
  return metrics.lower;
}

/**
 * Width of a run of characters in em, including the CJK↔Latin autospace.
 * `fontFamily` selects the Latin width table (see latinMetricsClass).
 */
export function measureRendererWidthEm(text: string, bold = false, fontFamily?: string): number {
  const metrics = LATIN_METRICS[latinMetricsClass(fontFamily)];
  let em = 0;
  let prev = '';
  for (const ch of text) {
    const full = isRendererFullwidth(ch);
    em += full ? 1 : charEm(ch, metrics) * (bold ? metrics.bold : 1);
    if (prev) {
      const prevFull = isRendererFullwidth(prev);
      if ((prevFull && isLatinWordChar(ch)) || (full && isLatinWordChar(prev))) {
        em += CJK_LATIN_AUTOSPACE_EM;
      }
    }
    prev = ch;
  }
  return em;
}

/**
 * Wrap one paragraph the way a renderer does: greedy, CJK may break between
 * any two characters (kinsoku permitting), Latin words stay whole unless a
 * single word is wider than the line. Returns the rendered lines.
 */
export function wrapParagraphForRenderer(
  paragraph: string,
  maxWidthEm: number,
  bold = false,
  fontFamily?: string
): string[] {
  if (!paragraph) return [''];
  if (maxWidthEm <= 0) return [paragraph];
  // Units: a Latin word (incl. trailing spaces) or a single other character.
  const units: string[] = [];
  const chars = Array.from(paragraph);
  for (let i = 0; i < chars.length;) {
    const ch = chars[i]!;
    if (!isRendererFullwidth(ch) && ch !== ' ') {
      let j = i;
      while (j < chars.length && !isRendererFullwidth(chars[j]!) && chars[j] !== ' ') j += 1;
      while (j < chars.length && chars[j] === ' ') j += 1;
      units.push(chars.slice(i, j).join(''));
      i = j;
    } else {
      units.push(ch);
      i += 1;
    }
  }

  const lines: string[] = [];
  let current = '';
  const width = (s: string) => measureRendererWidthEm(s.trimEnd(), bold, fontFamily);
  const limit = maxWidthEm - FIT_EPSILON_EM;
  for (const unit of units) {
    const candidate = current + unit;
    // No hanging punctuation: the engine writes no hangingPunct and
    // LibreOffice wraps a trailing 。 rather than letting it hang.
    if (!current || width(candidate) <= limit) {
      current = candidate;
      continue;
    }
    // Kinsoku: a unit that may not start a line pulls the previous character
    // down with it; an opening bracket may not end the line either.
    const prevChars = Array.from(current);
    const last = prevChars[prevChars.length - 1] ?? '';
    const firstOfUnit = Array.from(unit)[0] ?? '';
    if (!kinsokuAllowsBreak(last, firstOfUnit) && prevChars.length > 1) {
      lines.push(prevChars.slice(0, -1).join('').trimEnd());
      current = last + unit;
    } else {
      lines.push(current.trimEnd());
      current = unit.trimStart();
    }
    // A single word wider than the line breaks mid-word.
    while (width(current) > limit && Array.from(current).length > 1) {
      const cs = Array.from(current);
      let cut = cs.length - 1;
      while (cut > 1 && width(cs.slice(0, cut).join('')) > limit) cut -= 1;
      lines.push(cs.slice(0, cut).join(''));
      current = cs.slice(cut).join('');
    }
  }
  lines.push(current.trimEnd());
  return lines;
}

// ───────────────────────────── shape text rectangles ─────────────────────────────

/** Preset adjust value (guide units) from style.cornerRadius, as the engine writes it. */
function adjFromCornerRadius(r: number | undefined): number | undefined {
  if (r === undefined || !Number.isFinite(r) || r <= 0) return undefined;
  const guide = r <= 1 ? r * 100000 : r;
  return Math.max(0, Math.min(50000, Math.round(guide)));
}

/**
 * Text rectangle of a preset shape as insets [top, right, bottom, left] in
 * inches, from the presetShapeDefinitions formulas with default adjusts.
 * Unknown presets fall back to the full bounding box — the conservative
 * choice for a gate that must not flood false positives.
 */
export function presetTextRectInsets(
  shapeType: string,
  w: number,
  h: number,
  cornerRadius?: number
): { insets: [number, number, number, number]; known: boolean } {
  const ss = Math.min(w, h);
  const adj = adjFromCornerRadius(cornerRadius);
  const none: [number, number, number, number] = [0, 0, 0, 0];
  switch (shapeType) {
    case 'rect':
    case 'flowChartProcess':
    case 'snip1Rect':
      return { insets: none, known: true };
    case 'roundRect': {
      const a = Math.min(adj ?? 16667, 50000);
      const d = (ss * a * 0.29289) / 100000;
      return { insets: [d, d, d, d], known: true };
    }
    case 'flowChartAlternateProcess': {
      const d = (ss / 6) * 0.29289;
      return { insets: [d, d, d, d], known: true };
    }
    case 'ellipse':
    case 'flowChartConnector': {
      const dx = (w / 2) * (1 - Math.SQRT1_2);
      const dy = (h / 2) * (1 - Math.SQRT1_2);
      return { insets: [dy, dx, dy, dx], known: true };
    }
    case 'homePlate':
    case 'pentagon': {
      const a = Math.min(adj ?? 50000, (100000 * w) / ss);
      const dx1 = (ss * a) / 100000;
      return { insets: [0, dx1 / 2, 0, 0], known: true };
    }
    case 'chevron': {
      const a = Math.min(adj ?? 50000, (100000 * w) / ss);
      const x1 = (ss * a) / 100000;
      return x1 < w - x1 ? { insets: [0, x1, 0, x1], known: true } : { insets: none, known: true };
    }
    case 'rightArrow':
    case 'leftArrow': {
      // adj1 = 50000 (shaft), adj2 = 50000 (head): text sits in the shaft.
      const dx1 = (ss * 50000) / 100000;
      const dy1 = h / 4;
      const dx2 = ((h / 2 - dy1) * dx1) / (h / 2);
      const side = dx1 - dx2;
      return shapeType === 'rightArrow'
        ? { insets: [dy1, side, dy1, 0], known: true }
        : { insets: [dy1, 0, dy1, side], known: true };
    }
    case 'leftRightArrow': {
      const dx1 = (ss * 50000) / 100000;
      const dy1 = h / 4;
      const dx2 = ((h / 2 - dy1) * dx1) / (h / 2);
      const side = dx1 - dx2;
      return { insets: [dy1, side, dy1, side], known: true };
    }
    case 'triangle':
      // Text rect: the lower half, between the side midpoints (default apex).
      return { insets: [h / 2, w / 4, 0, w / 4], known: true };
    case 'diamond':
      return { insets: [h / 4, w / 4, h / 4, w / 4], known: true };
    case 'octagon': {
      const a = Math.min(adj ?? 29289, 50000);
      const d = (ss * a) / 200000;
      return { insets: [d, d, d, d], known: true };
    }
    case 'plaque': {
      const a = Math.min(adj ?? 16667, 50000);
      const d = (ss * a * 0.70711) / 100000;
      return { insets: [d, d, d, d], known: true };
    }
    default:
      return { insets: none, known: false };
  }
}

// ───────────────────────────── element prediction ─────────────────────────────

function emuAttr(xml: string, attr: string): number | undefined {
  const match = xml.match(new RegExp(`\\b${attr}="(-?\\d+)"`));
  return match ? Number(match[1]) / 914400 : undefined;
}

function elementText(el: PptxElement): string {
  if (Array.isArray(el.textRuns) && el.textRuns.length > 0) {
    return el.textRuns.map((run) => run?.text ?? '').join('');
  }
  return typeof el.text === 'string' ? el.text : '';
}

/** Largest run size wins: a line is as tall as its tallest glyph. */
function elementFontSize(el: PptxElement): number | undefined {
  const sizes: number[] = [];
  if (typeof el.style?.fontSize === 'number') sizes.push(el.style.fontSize);
  for (const run of el.textRuns ?? []) {
    if (typeof run?.options?.fontSize === 'number') sizes.push(run.options.fontSize);
  }
  const valid = sizes.filter((size) => Number.isFinite(size) && size > 0);
  return valid.length > 0 ? Math.max(...valid) : undefined;
}

/**
 * Font size of each authored paragraph: the largest run that lands in it
 * (textRuns split on "\n" exactly as the engine emits paragraphs), falling
 * back to style.fontSize. A box whose first line is a 13pt heading and the
 * rest 9.5pt body is measured line by line, not all at 13pt.
 */
function paragraphFontSizes(el: PptxElement, paragraphCount: number, fallback: number): number[] {
  const sizes: number[] = new Array(paragraphCount).fill(0);
  const base = typeof el.style?.fontSize === 'number' ? el.style.fontSize : fallback;
  if (Array.isArray(el.textRuns) && el.textRuns.length > 0) {
    let index = 0;
    for (const run of el.textRuns) {
      const size = run?.options?.fontSize ?? base;
      const segments = String(run?.text ?? '').split('\n');
      segments.forEach((segment, segmentIndex) => {
        if (segmentIndex > 0) index += 1;
        if (segment && index < paragraphCount) sizes[index] = Math.max(sizes[index]!, size);
      });
    }
  }
  return sizes.map((size) => (size > 0 ? size : base));
}

function elementBold(el: PptxElement): boolean {
  if (el.style?.bold) return true;
  return (el.textRuns ?? []).some((run) => run?.options?.bold === true);
}

function lineSpacingMultiplier(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 1;
  return value <= 10 ? value : value / 100;
}

export interface PredictPptxTextOptions {
  /** Override the single-line height factor (default 1.2). */
  lineFactor?: number;
}

export interface PptxTextPredictionResult {
  boxes: PptxTextBoxPrediction[];
  skipped: Array<{ slideIndex: number; elementIndex: number; reason: string }>;
}

/**
 * Predict every measurable text box in a protocol. Elements are skipped (and
 * counted) rather than guessed when the model cannot see what the renderer
 * will do: untouched template paragraphs (pXmlLst), no resolvable font size,
 * rotation, vertical text, wrap="none" or a raw-parts passthrough protocol.
 */
export function predictPptxTextBoxes(
  protocol: PptxDesignProtocol,
  options: PredictPptxTextOptions = {}
): PptxTextPredictionResult {
  const boxes: PptxTextBoxPrediction[] = [];
  const skipped: PptxTextPredictionResult['skipped'] = [];
  if (!protocol || !Array.isArray(protocol.slides)) return { boxes, skipped };
  if (protocol.rawParts && Object.keys(protocol.rawParts).length > 0) return { boxes, skipped };
  const cascaded = applyPptxDesignDefaults(protocol);
  const lineFactor = options.lineFactor ?? DEFAULT_LINE_FACTOR;

  cascaded.slides.forEach((slide, slideIdx) => {
    (slide.elements ?? []).forEach((el, elementIndex) => {
      if (!el || (el.type !== 'text' && el.type !== 'shape')) return;
      const text = elementText(el);
      if (!text.trim()) return;
      const where = { slideIndex: slideIdx + 1, elementIndex };
      const skip = (reason: string) => skipped.push({ ...where, reason });
      if (!el.pos || !(el.pos.w > 0) || !(el.pos.h > 0)) return skip('no geometry');
      if (Array.isArray(el.pXmlLst) && el.pXmlLst.length > 0) {
        return skip('template paragraphs (pXmlLst) — font metrics come from the template');
      }
      if (el.style?.rotate && Math.abs(el.style.rotate) % 180 !== 0) return skip('rotated');
      const bodyPr = el.bodyPrXml || '';
      if (/\bvert="(?!horz)/.test(bodyPr)) return skip('vertical text');
      if (/\bwrap="none"/.test(bodyPr)) return skip('wrap="none"');
      if ((el.textColumns ?? 1) > 1 || /\bnumCol="[2-9]/.test(bodyPr)) {
        return skip('multi-column text');
      }
      const fontSizePt = elementFontSize(el);
      if (!fontSizePt) return skip('no font size (inherited from template)');

      const shapeType = el.shapeType || 'rect';
      if (el.custGeomXml) return skip('custom geometry');
      const { insets: shapeInsets } = presetTextRectInsets(
        shapeType,
        el.pos.w,
        el.pos.h,
        el.style?.cornerRadius
      );
      const bodyInsets: [number, number, number, number] = el.style?.margin
        ? [...el.style.margin]
        : [
            emuAttr(bodyPr, 'tIns') ?? DEFAULT_INSETS_IN[0],
            emuAttr(bodyPr, 'rIns') ?? DEFAULT_INSETS_IN[1],
            emuAttr(bodyPr, 'bIns') ?? DEFAULT_INSETS_IN[2],
            emuAttr(bodyPr, 'lIns') ?? DEFAULT_INSETS_IN[3],
          ];
      const indent = el.style?.bullet?.indent ?? 0;
      const textArea: PptxRectIn = {
        x: el.pos.x + shapeInsets[3] + bodyInsets[3] + indent,
        y: el.pos.y + shapeInsets[0] + bodyInsets[0],
        w: Math.max(
          0.01,
          el.pos.w - shapeInsets[1] - shapeInsets[3] - bodyInsets[1] - bodyInsets[3] - indent
        ),
        h: Math.max(
          0.01,
          el.pos.h - shapeInsets[0] - shapeInsets[2] - bodyInsets[0] - bodyInsets[2]
        ),
      };

      const bold = elementBold(el);
      const fontFamily =
        (el.textRuns ?? []).find((run) => run?.options?.fontFamily)?.options?.fontFamily ??
        el.style?.fontFamily;
      const paragraphs = text.split('\n');
      const paragraphSizesPt = paragraphFontSizes(el, paragraphs.length, fontSizePt);
      const spacing = lineSpacingMultiplier(el.style?.lineSpacing);
      let widestPt = 0;
      const linesPerParagraph = paragraphs.map((paragraph, index) => {
        const size = paragraphSizesPt[index]!;
        const lines = wrapParagraphForRenderer(
          paragraph,
          (textArea.w * POINTS_PER_INCH) / size,
          bold,
          fontFamily
        );
        for (const line of lines) {
          widestPt = Math.max(widestPt, measureRendererWidthEm(line, bold, fontFamily) * size);
        }
        return lines.length;
      });
      const lineCount = linesPerParagraph.reduce((sum, n) => sum + n, 0);
      // The tallest paragraph's line height, for reporting and capacity.
      const lineHeightIn = (fontSizePt * lineFactor * spacing) / POINTS_PER_INCH;
      const gapsIn =
        (((el.style?.spaceBefore ?? 0) + (el.style?.spaceAfter ?? 0)) *
          Math.max(0, paragraphs.length - 1)) /
        POINTS_PER_INCH;
      const requiredHeightIn =
        linesPerParagraph.reduce(
          (sum, lines, index) => sum + lines * paragraphSizesPt[index]! * lineFactor * spacing,
          0
        ) /
          POINTS_PER_INCH +
        gapsIn;

      const align = el.style?.align ?? 'left';
      const slackIn = (LAST_LINE_SLACK_EM * fontSizePt) / POINTS_PER_INCH;
      const authoredHeightIn =
        paragraphSizesPt.reduce((sum, size) => sum + size * lineFactor * spacing, 0) /
          POINTS_PER_INCH +
        gapsIn;
      // Room for at least one more line than the author wrote?
      const roomForWrap = textArea.h + slackIn + 1e-6 >= authoredHeightIn + lineHeightIn;
      // A wrap is a defect when the text is a label (inside a filled shape),
      // a centred / right-aligned line, or the box only has room for exactly
      // the lines the author wrote. Left-aligned body text in a box with
      // spare height is ordinary flowing text and is allowed to wrap.
      const wrapSensitive =
        el.type === 'shape' || align === 'center' || align === 'right' || !roomForWrap;

      boxes.push({
        slideIndex: slideIdx + 1,
        slideId: slide.id,
        elementIndex,
        elementName: el.name,
        shapeType,
        text,
        paragraphs,
        paragraphSizesPt,
        fontSizePt,
        bold,
        ...(fontFamily ? { fontFamily } : {}),
        align,
        valign: el.style?.valign ?? 'top',
        box: { ...el.pos },
        textArea,
        padTopIn: shapeInsets[0] + bodyInsets[0],
        padBottomIn: shapeInsets[2] + bodyInsets[2],
        lineHeightIn,
        linesPerParagraph,
        lineCount,
        requiredHeightIn,
        widestLineIn: widestPt / POINTS_PER_INCH,
        wrapSensitive,
        autofit: el.autofit === 'normal' ? 'normal' : el.autofit === 'shrink' ? 'shrink' : 'none',
      });
    });
  });
  return { boxes, skipped };
}

function excerptOf(text: string, max = 40): string {
  const flat = text.replace(/\s+/gu, (space) => (space.includes('\n') ? ' / ' : space)).trim();
  return Array.from(flat).length > max ? `${Array.from(flat).slice(0, max).join('')}…` : flat;
}

function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/**
 * Height the text may take before it visibly leaves the box. Text that only
 * eats into the padding (bodyPr insets, a rounded corner's text-rect inset)
 * still sits inside the shape; the renderer pushes the excess out on the side
 * the anchor leaves free — below for top, above for bottom, both halves for
 * middle — so that is the room it has.
 */
export function overflowAllowanceIn(prediction: PptxTextBoxPrediction): number {
  const pad =
    prediction.valign === 'top'
      ? prediction.padBottomIn
      : prediction.valign === 'bottom'
        ? prediction.padTopIn
        : 2 * Math.min(prediction.padTopIn, prediction.padBottomIn);
  return (
    prediction.textArea.h + pad + (LAST_LINE_SLACK_EM * prediction.fontSizePt) / POINTS_PER_INCH
  );
}

function issueBase(prediction: PptxTextBoxPrediction) {
  return {
    slideIndex: prediction.slideIndex,
    ...(prediction.slideId ? { slideId: prediction.slideId } : {}),
    elementIndex: prediction.elementIndex,
    ...(prediction.elementName ? { elementName: prediction.elementName } : {}),
    shapeType: prediction.shapeType,
    excerpt: excerptOf(prediction.text),
    fontSizePt: prediction.fontSizePt,
    authoredLines: prediction.paragraphs.length,
    availableHeightIn: round(prediction.textArea.h),
    availableWidthIn: round(prediction.textArea.w),
  };
}

export function summarizeTextFitIssues(
  issues: PptxTextFitIssue[],
  checkedElements: number,
  skippedElements: number
): PptxTextFitReport {
  const overflowCount = issues.filter((issue) => issue.kind === 'overflow').length;
  const unexpectedWrapCount = issues.filter((issue) => issue.kind === 'unexpected_wrap').length;
  return {
    status: overflowCount > 0 ? 'overflow' : unexpectedWrapCount > 0 ? 'warn' : 'pass',
    measurementModel: PPTX_TEXT_FIT_MODEL,
    checkedElements,
    skippedElements,
    overflowCount,
    unexpectedWrapCount,
    issues,
  };
}

/** Pre-render check: model the renderer and report overflow / unexpected wraps. */
export function checkPptxTextFit(
  protocol: PptxDesignProtocol,
  options: PredictPptxTextOptions = {}
): PptxTextFitReport {
  const { boxes, skipped } = predictPptxTextBoxes(protocol, options);
  const issues: PptxTextFitIssue[] = [];
  for (const prediction of boxes) {
    if (prediction.autofit === 'normal') continue; // renderer shrinks the font to fit
    const base = issueBase(prediction);
    if (prediction.wrapSensitive) {
      prediction.linesPerParagraph.forEach((lines, paragraphIndex) => {
        if (lines <= 1) return;
        issues.push({
          kind: 'unexpected_wrap',
          severity: 'warn',
          ...base,
          paragraphIndex,
          lines: prediction.lineCount,
          requiredHeightIn: round(prediction.requiredHeightIn),
          source: 'model',
          detail: `paragraph ${paragraphIndex + 1} "${excerptOf(prediction.paragraphs[paragraphIndex] ?? '', 24)}" needs ${round((measureRendererWidthEm(prediction.paragraphs[paragraphIndex] ?? '', prediction.bold, prediction.fontFamily) * (prediction.paragraphSizesPt[paragraphIndex] ?? prediction.fontSizePt)) / POINTS_PER_INCH, 2)}in but the text area is ${round(prediction.textArea.w, 2)}in wide — it wraps onto ${lines} lines`,
        });
      });
    }
    if (prediction.autofit === 'shrink') continue; // box grows to the text
    if (prediction.requiredHeightIn > overflowAllowanceIn(prediction) + 0.005) {
      issues.push({
        kind: 'overflow',
        severity: 'error',
        ...base,
        lines: prediction.lineCount,
        requiredHeightIn: round(prediction.requiredHeightIn),
        source: 'model',
        detail: `${prediction.lineCount} line(s) × ${round(prediction.lineHeightIn, 3)}in = ${round(prediction.requiredHeightIn, 2)}in exceed the ${round(prediction.textArea.h, 2)}in text area and its padding — the text leaves the ${round(prediction.box.h, 2)}in box (authored ${prediction.paragraphs.length} line(s))`,
      });
    }
  }
  return summarizeTextFitIssues(issues, boxes.length, skipped.length);
}

// ───────────────────────────── post-render comparison ─────────────────────────────

/**
 * One rendered text run (a line arrives as one or more runs), in inches from
 * the top-left of its page. Runs are not merged across a line: two boxes side
 * by side share a baseline, and only the run boundary tells them apart.
 */
export interface RenderedTextRun {
  /** 1-based page number (= slide number for a deck PDF). */
  page: number;
  text: string;
  x: number;
  width: number;
  /** Baseline position from the page top. */
  baseline: number;
  fontSizePt: number;
}

export interface RenderedBoxMeasurement {
  slideIndex: number;
  elementIndex: number;
  excerpt: string;
  predictedLines: number;
  renderedLines: number;
  /** Rendered ink extent from the page top (inches), when lines were found. */
  renderedTopIn?: number;
  renderedBottomIn?: number;
}

export interface PptxRenderTextCheckResult extends Omit<PptxTextFitReport, 'status'> {
  status: PptxTextFitReport['status'] | 'inconclusive';
  /** Boxes whose rendered lines could not be located in the PDF. */
  unmatchedElements: number;
  boxes: RenderedBoxMeasurement[];
}

const normalizeForMatch = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');

/**
 * Compare rendered PDF text runs with the authored boxes: count lines per box and
 * measure where the ink actually lands. Runs are attributed to a box by
 * position (inside the box's column, near its rows) and content (the run's
 * text occurs in the box's text) — overlapping boxes are told apart by text.
 */
export function compareRenderedTextRuns(
  predictions: PptxTextBoxPrediction[],
  runs: RenderedTextRun[],
  skippedElements = 0
): PptxRenderTextCheckResult {
  const assigned = new Map<PptxTextBoxPrediction, RenderedTextRun[]>();
  const normalizedText = new Map<PptxTextBoxPrediction, string>();
  for (const prediction of predictions) {
    assigned.set(prediction, []);
    normalizedText.set(prediction, normalizeForMatch(prediction.text));
  }

  for (const run of runs) {
    const needle = normalizeForMatch(run.text);
    if (!needle) continue;
    const centre = run.x + run.width / 2;
    let best: PptxTextBoxPrediction | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const prediction of predictions) {
      if (prediction.slideIndex !== run.page) continue;
      if (!prediction.paragraphSizesPt.some((size) => Math.abs(size - run.fontSizePt) <= 0.75)) {
        continue;
      }
      const { box } = prediction;
      if (centre < box.x - 0.1 || centre > box.x + box.w + 0.1) continue;
      // Overflowing text spills above (middle/bottom anchor) or below the box.
      const reach = Math.max(box.h, prediction.lineHeightIn * 3);
      if (run.baseline < box.y - reach || run.baseline > box.y + box.h + reach) continue;
      if (!normalizedText.get(prediction)!.includes(needle)) continue;
      const inside = run.baseline >= box.y && run.baseline <= box.y + box.h + 0.02;
      const score =
        (inside ? 0 : 10) +
        Math.abs(run.baseline - (box.y + box.h / 2)) +
        Math.abs(centre - (box.x + box.w / 2)) * 0.1;
      if (score < bestScore) {
        bestScore = score;
        best = prediction;
      }
    }
    if (best) assigned.get(best)!.push(run);
  }

  const issues: PptxTextFitIssue[] = [];
  const boxes: RenderedBoxMeasurement[] = [];
  let unmatched = 0;
  for (const prediction of predictions) {
    const found = assigned.get(prediction)!;
    // Blank paragraphs leave no ink, so they are not counted on either side.
    const predictedLines = prediction.linesPerParagraph.reduce(
      (sum, lines, index) => sum + (prediction.paragraphs[index]!.trim() ? lines : 0),
      0
    );
    const authored = prediction.paragraphs.filter((paragraph) => paragraph.trim()).length;
    // Distinct baselines = rendered lines (a line may arrive as several runs).
    const baselines: number[] = [];
    for (const line of [...found].sort((a, b) => a.baseline - b.baseline)) {
      const tol = (line.fontSizePt * 0.3) / POINTS_PER_INCH;
      if (!baselines.some((b) => Math.abs(b - line.baseline) <= tol)) baselines.push(line.baseline);
    }
    const excerpt = excerptOf(prediction.text);
    if (baselines.length === 0) {
      unmatched += 1;
      boxes.push({
        slideIndex: prediction.slideIndex,
        elementIndex: prediction.elementIndex,
        excerpt,
        predictedLines,
        renderedLines: 0,
      });
      continue;
    }
    // Ink extent: ascent ≈ 0.88em above, descent ≈ 0.12em below each run.
    const top = Math.min(
      ...found.map((run) => run.baseline - (run.fontSizePt * 0.88) / POINTS_PER_INCH)
    );
    const bottom = Math.max(
      ...found.map((run) => run.baseline + (run.fontSizePt * 0.12) / POINTS_PER_INCH)
    );
    const renderedLines = baselines.length;
    boxes.push({
      slideIndex: prediction.slideIndex,
      elementIndex: prediction.elementIndex,
      excerpt,
      predictedLines,
      renderedLines,
      renderedTopIn: round(top),
      renderedBottomIn: round(bottom),
    });
    if (prediction.autofit === 'normal') continue;
    const base = issueBase(prediction);
    const renderedHeight = renderedLines * prediction.lineHeightIn;
    if (renderedLines > authored && prediction.wrapSensitive) {
      issues.push({
        kind: 'unexpected_wrap',
        severity: 'warn',
        ...base,
        lines: renderedLines,
        requiredHeightIn: round(renderedHeight),
        source: 'render',
        detail: `rendered on ${renderedLines} line(s) but authored as ${authored} (model predicted ${predictedLines})`,
      });
    }
    if (prediction.autofit === 'shrink') continue;
    const tol = 0.01;
    const boxTop = prediction.box.y;
    const boxBottom = prediction.box.y + prediction.box.h;
    if (bottom > boxBottom + tol || top < boxTop - tol) {
      issues.push({
        kind: 'overflow',
        severity: 'error',
        ...base,
        lines: renderedLines,
        requiredHeightIn: round(bottom - top),
        source: 'render',
        detail: `rendered text spans ${round(top, 2)}–${round(bottom, 2)}in but the box is ${round(boxTop, 2)}–${round(boxBottom, 2)}in (${renderedLines} line(s), authored ${authored})`,
      });
    }
  }
  const summary = summarizeTextFitIssues(issues, predictions.length - unmatched, skippedElements);
  return {
    ...summary,
    status: summary.status === 'pass' && unmatched > 0 ? 'inconclusive' : summary.status,
    unmatchedElements: unmatched,
    boxes,
  };
}
