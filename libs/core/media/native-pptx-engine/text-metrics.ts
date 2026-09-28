/**
 * MP-03: deterministic text measurement and layout fit.
 *
 * Slide geometry used to be chosen without ever comparing text against the box
 * it lands in: column splits were ratio guesses (`Math.ceil(lines * 0.55)`) and
 * font sizes were constants, so long or Japanese-heavy bodies overflowed their
 * frames. This module measures first — advance-width tables give a font-metric
 * estimate without rendering — then fits by shrinking within the type ramp's
 * floor, and reports honestly when even the floor does not fit.
 *
 * Determinism is a hard requirement: no font files are read, no canvas is
 * involved, and the same input always yields the same measurement, so PPTX
 * output stays byte-reproducible and the fit is testable hermetically.
 */

/** Character class widths as a multiple of font size (em). */
interface AdvanceWidths {
  /** CJK ideographs, kana, fullwidth forms — square by design. */
  fullwidth: number;
  /** Latin lowercase average. */
  latinLower: number;
  /** Latin uppercase / digits average. */
  latinUpper: number;
  /** Space and thin punctuation. */
  space: number;
  /** Latin narrow glyphs (i, l, j, punctuation). */
  narrow: number;
}

/**
 * Averages measured against Inter / Noto Sans JP at 100pt. Latin values are
 * class averages rather than per-glyph tables: the goal is a fit decision with
 * a safety margin, not typesetting-exact positioning.
 */
const DEFAULT_ADVANCE: AdvanceWidths = {
  fullwidth: 1.0,
  latinLower: 0.52,
  latinUpper: 0.62,
  space: 0.26,
  narrow: 0.28,
};

const NARROW_LATIN = new Set([
  'i',
  'l',
  'j',
  't',
  'f',
  'r',
  '.',
  ',',
  ':',
  ';',
  "'",
  '"',
  '|',
  '!',
]);

/** Line-height as a multiple of font size when the style gives no explicit spacing. */
const DEFAULT_LINE_SPACING_PCT = 120;

/** Points per inch — PPTX geometry is inches, type is points. */
const POINTS_PER_INCH = 72;

export function isFullwidthChar(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, punctuation
    (code >= 0x3041 && code <= 0x33ff) || // Hiragana, Katakana, CJK compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compat forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** Advance width of one character in em units. */
function charWidthEm(ch: string, widths: AdvanceWidths): number {
  if (ch === ' ' || ch === '\t') return widths.space;
  if (isFullwidthChar(ch)) return widths.fullwidth;
  if (NARROW_LATIN.has(ch)) return widths.narrow;
  if (ch >= 'A' && ch <= 'Z') return widths.latinUpper;
  if (ch >= '0' && ch <= '9') return widths.latinUpper;
  return widths.latinLower;
}

/** Width of a string in points at the given font size. */
export function measureTextWidthPt(
  text: string,
  fontSizePt: number,
  widths: AdvanceWidths = DEFAULT_ADVANCE
): number {
  let em = 0;
  for (const ch of text) em += charWidthEm(ch, widths);
  return em * fontSizePt;
}

/**
 * Break one logical line into rendered lines at the given width.
 *
 * Japanese wraps between any two characters; latin wraps at spaces, falling
 * back to mid-word breaks only when a single word exceeds the measure (which
 * is what PowerPoint does too).
 */
export function wrapLine(
  line: string,
  maxWidthPt: number,
  fontSizePt: number,
  widths: AdvanceWidths = DEFAULT_ADVANCE
): string[] {
  if (!line) return [''];
  if (maxWidthPt <= 0) return [line];

  const out: string[] = [];
  let current = '';
  let currentWidth = 0;
  /** Index in `current` of the last point a latin break is allowed. */
  let lastBreak = -1;

  for (const ch of line) {
    const w = charWidthEm(ch, widths) * fontSizePt;
    const fits = currentWidth + w <= maxWidthPt;

    if (!fits && current) {
      // Prefer a space break for latin runs; CJK may break anywhere.
      if (lastBreak > 0 && !isFullwidthChar(ch)) {
        out.push(current.slice(0, lastBreak).trimEnd());
        current = current.slice(lastBreak).trimStart();
        currentWidth = measureTextWidthPt(current, fontSizePt, widths);
      } else {
        out.push(current);
        current = '';
        currentWidth = 0;
      }
      lastBreak = -1;
    }

    current += ch;
    currentWidth += w;
    if (ch === ' ') lastBreak = current.length;
  }

  if (current) out.push(current);
  return out.length > 0 ? out : [''];
}

export interface MeasureOptions {
  fontSizePt: number;
  /** Box width in inches. */
  widthIn: number;
  /** Inner margins in inches, [top, right, bottom, left]. Matches PptxStyle.margin. */
  marginIn?: [number, number, number, number];
  /** Percentage line spacing (155 = 155%). */
  lineSpacingPct?: number;
  /** Extra points before each paragraph. */
  spaceBeforePt?: number;
  /** Extra points after each paragraph. */
  spaceAfterPt?: number;
}

export interface TextMeasurement {
  /** Total rendered lines after wrapping. */
  lineCount: number;
  /** Rendered lines per input paragraph. */
  linesPerParagraph: number[];
  /** Required height in inches, including margins and paragraph spacing. */
  requiredHeightIn: number;
  /** Widest rendered line in inches (excluding margins). */
  widestLineIn: number;
}

/** Measure a block of text (newline-separated paragraphs) inside a box. */
export function measureTextBlock(text: string, options: MeasureOptions): TextMeasurement {
  const margin = options.marginIn ?? [0, 0, 0, 0];
  const [marginTop, marginRight, marginBottom, marginLeft] = margin;
  const contentWidthIn = Math.max(0.01, options.widthIn - marginLeft - marginRight);
  const contentWidthPt = contentWidthIn * POINTS_PER_INCH;
  const lineSpacingPct = options.lineSpacingPct ?? DEFAULT_LINE_SPACING_PCT;
  const lineHeightPt = options.fontSizePt * (lineSpacingPct / 100);

  const paragraphs = text.split('\n');
  const linesPerParagraph: number[] = [];
  let widestPt = 0;

  for (const paragraph of paragraphs) {
    const wrapped = wrapLine(paragraph, contentWidthPt, options.fontSizePt);
    linesPerParagraph.push(wrapped.length);
    for (const rendered of wrapped) {
      widestPt = Math.max(widestPt, measureTextWidthPt(rendered, options.fontSizePt));
    }
  }

  const lineCount = linesPerParagraph.reduce((sum, n) => sum + n, 0);
  const paragraphGapsPt =
    ((options.spaceBeforePt ?? 0) + (options.spaceAfterPt ?? 0)) * paragraphs.length;
  const textHeightIn = (lineCount * lineHeightPt + paragraphGapsPt) / POINTS_PER_INCH;

  return {
    lineCount,
    linesPerParagraph,
    requiredHeightIn: textHeightIn + marginTop + marginBottom,
    widestLineIn: widestPt / POINTS_PER_INCH,
  };
}

export interface LayoutFitRequest {
  text: string;
  /** Box height in inches the text must fit within. */
  heightIn: number;
  /** Starting (designed) font size in points. */
  fontSizePt: number;
  /** Hard floor from the type ramp — never shrink below this. */
  minFontSizePt: number;
  widthIn: number;
  marginIn?: [number, number, number, number];
  lineSpacingPct?: number;
  spaceBeforePt?: number;
  spaceAfterPt?: number;
}

export interface LayoutFitResult {
  /** Font size to render at (may be smaller than requested). */
  fontSizePt: number;
  /** True when the text fits at the returned size. */
  fits: boolean;
  /** How the fit was achieved. */
  strategy: 'as-designed' | 'shrunk' | 'overflow';
  measurement: TextMeasurement;
  /**
   * Paragraph index at which the text stops fitting, when even the floor
   * overflows. Callers split here rather than letting text run off the slide.
   */
  overflowAtParagraph?: number;
  /** Ratio of required to available height at the returned size (>1 = overflow). */
  fillRatio: number;
}

/** Font sizes are chosen in whole points — PowerPoint renders halves, but whole
 * points keep the ladder deterministic and legible across the deck. */
function shrinkLadder(from: number, to: number): number[] {
  const sizes: number[] = [];
  for (let size = Math.floor(from); size >= Math.ceil(to); size -= 1) sizes.push(size);
  return sizes;
}

/**
 * Fit text to a box: try the designed size, then step down to the ramp floor,
 * and if it still overflows report where to split. Never returns a size below
 * `minFontSizePt` — illegible text is a worse failure than a split slide.
 */
export function fitTextToBox(request: LayoutFitRequest): LayoutFitResult {
  const measureAt = (fontSizePt: number): TextMeasurement =>
    measureTextBlock(request.text, {
      fontSizePt,
      widthIn: request.widthIn,
      marginIn: request.marginIn,
      lineSpacingPct: request.lineSpacingPct,
      spaceBeforePt: request.spaceBeforePt,
      spaceAfterPt: request.spaceAfterPt,
    });

  const designed = measureAt(request.fontSizePt);
  if (designed.requiredHeightIn <= request.heightIn) {
    return {
      fontSizePt: request.fontSizePt,
      fits: true,
      strategy: 'as-designed',
      measurement: designed,
      fillRatio: designed.requiredHeightIn / request.heightIn,
    };
  }

  for (const size of shrinkLadder(request.fontSizePt - 1, request.minFontSizePt)) {
    const measurement = measureAt(size);
    if (measurement.requiredHeightIn <= request.heightIn) {
      return {
        fontSizePt: size,
        fits: true,
        strategy: 'shrunk',
        measurement,
        fillRatio: measurement.requiredHeightIn / request.heightIn,
      };
    }
  }

  const floor = Math.max(1, Math.ceil(request.minFontSizePt));
  const atFloor = measureAt(floor);
  return {
    fontSizePt: floor,
    fits: false,
    strategy: 'overflow',
    measurement: atFloor,
    overflowAtParagraph: findOverflowParagraph(atFloor, request, floor),
    fillRatio: atFloor.requiredHeightIn / request.heightIn,
  };
}

/** First paragraph index whose rendered lines cross the box height. */
function findOverflowParagraph(
  measurement: TextMeasurement,
  request: LayoutFitRequest,
  fontSizePt: number
): number {
  const margin = request.marginIn ?? [0, 0, 0, 0];
  const availableIn = Math.max(0, request.heightIn - margin[0] - margin[2]);
  const lineHeightIn =
    (fontSizePt * ((request.lineSpacingPct ?? DEFAULT_LINE_SPACING_PCT) / 100)) / POINTS_PER_INCH;
  const paragraphGapIn =
    ((request.spaceBeforePt ?? 0) + (request.spaceAfterPt ?? 0)) / POINTS_PER_INCH;

  let usedIn = 0;
  for (let i = 0; i < measurement.linesPerParagraph.length; i += 1) {
    usedIn += measurement.linesPerParagraph[i] * lineHeightIn + paragraphGapIn;
    if (usedIn > availableIn) return i;
  }
  return measurement.linesPerParagraph.length;
}

export interface SplitColumnsRequest {
  lines: string[];
  /** Width of each column in inches. */
  columnWidthIn: number;
  /** Optional width for the right column when the two zones are asymmetric. */
  rightColumnWidthIn?: number;
  fontSizePt: number;
  marginIn?: [number, number, number, number];
  lineSpacingPct?: number;
}

/**
 * Split lines across two columns by measured rendered height rather than by
 * item count. A four-line paragraph and a one-line bullet are no longer
 * treated as equal weight, which is what made ratio-based splits look lopsided.
 */
export function splitLinesBalanced(request: SplitColumnsRequest): {
  left: string[];
  right: string[];
} {
  const { lines } = request;
  if (lines.length <= 1) return { left: lines, right: [] };

  let bestSplit = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  const rightWidth = request.rightColumnWidthIn ?? request.columnWidthIn;
  // Keep at least one line on each side: a column the author asked for should
  // never render empty.
  for (let i = 0; i < lines.length - 1; i += 1) {
    const leftHeight = measureTextBlock(lines.slice(0, i + 1).join('\n'), {
      fontSizePt: request.fontSizePt,
      widthIn: request.columnWidthIn,
      marginIn: request.marginIn,
      lineSpacingPct: request.lineSpacingPct,
    }).requiredHeightIn;
    const rightHeight = measureTextBlock(lines.slice(i + 1).join('\n'), {
      fontSizePt: request.fontSizePt,
      widthIn: rightWidth,
      marginIn: request.marginIn,
      lineSpacingPct: request.lineSpacingPct,
    }).requiredHeightIn;
    const score = Math.max(leftHeight, rightHeight);
    if (score < bestScore) {
      bestScore = score;
      bestSplit = i + 1;
    }
  }

  return { left: lines.slice(0, bestSplit), right: lines.slice(bestSplit) };
}
