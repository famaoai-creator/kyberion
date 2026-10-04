/**
 * Japanese line-break rules for deterministic slide text layout.
 *
 * Japanese has no spaces, so "break anywhere" puts 。、」 at the start of a line
 * and strands single kana on the next line. Two rule sets fix that:
 *   - kinsoku (禁則): characters that may not start / end a line;
 *   - phrase boundaries: prefer breaking where a hiragana run (particles,
 *     okurigana) hands over to kanji / katakana / Latin, and after 、。 —
 *     a deterministic approximation of bunsetsu breaking (no dictionary, so
 *     output stays byte-reproducible across runtimes).
 */

/** May not start a line (closing brackets, small kana, punctuation, prolonged mark). */
const NO_LINE_START = new Set(
  Array.from(
    // i18n-exempt: Japanese line-breaking rule data (kinsoku / particles), not user-facing copy
    '、。，．・：；？！゛゜ー―～…‥）〕］｝〉》」』】〙〗’”%‰℃ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶ々ゝゞヽヾ)]},.!?:;'
  )
);

/** May not end a line (opening brackets). */
// i18n-exempt: Japanese line-breaking rule data (kinsoku / particles), not user-facing copy
const NO_LINE_END = new Set(Array.from('（〔［｛〈《「『【〘〖‘“([{'));

// i18n-exempt: Japanese line-breaking rule data (kinsoku / particles), not user-facing copy
const isHiragana = (ch: string) => ch >= 'ぁ' && ch <= 'ゟ';
// i18n-exempt: Japanese line-breaking rule data (kinsoku / particles), not user-facing copy
const HONORIFIC_PREFIX = new Set(['お', 'ご']);
/** Common particles: a prefix right after one starts a new word (変革の|ご提案). */
// i18n-exempt: Japanese line-breaking rule data (kinsoku / particles), not user-facing copy
const PARTICLES = new Set(Array.from('はがをにでとのへもやか'));
const isParticle = (ch: string) => PARTICLES.has(ch);
// i18n-exempt: Japanese line-breaking rule data (kinsoku / particles), not user-facing copy
const isPunctBreak = (ch: string) => ch === '、' || ch === '。' || ch === '，' || ch === '．';

/** True when a line may break between `before` and `after` (kinsoku only). */
export function kinsokuAllowsBreak(before: string, after: string): boolean {
  if (!before || !after) return true;
  return !NO_LINE_START.has(after) && !NO_LINE_END.has(before);
}

/**
 * Indices (into the code-point array) where a phrase-level break is preferred:
 * a break *before* chars[i]. Always kinsoku-safe.
 */
export function phraseBreakOpportunities(text: string): number[] {
  const chars = Array.from(text);
  const out: number[] = [];
  for (let i = 1; i < chars.length; i += 1) {
    const before = chars[i - 1]!;
    const after = chars[i]!;
    if (!kinsokuAllowsBreak(before, after)) continue;
    if (after === ' ' || before === ' ') {
      out.push(i);
      continue;
    }
    if (isPunctBreak(before)) {
      out.push(i);
      continue;
    }
    // Particle / okurigana run ends and a content word starts — except the
    // honorific prefixes お/ご, which belong to the word after them (ご提案).
    // Particle then an honorific-prefixed word: break before the prefix (の|ご提案).
    const next = chars[i + 1] ?? '';
    if (isParticle(before) && HONORIFIC_PREFIX.has(after) && next && !isHiragana(next)) {
      out.push(i);
      continue;
    }
    const prev = i >= 2 ? chars[i - 2]! : '';
    const honorificPrefix = HONORIFIC_PREFIX.has(before) && (!isHiragana(prev) || isParticle(prev));
    if (isHiragana(before) && !isHiragana(after) && !NO_LINE_START.has(after) && !honorificPrefix) {
      out.push(i);
    }
  }
  return out;
}

/**
 * Choose where to cut `chars[0..limit)` so the line ends on a phrase boundary
 * when one exists in the back half of the line, otherwise on the last
 * kinsoku-safe position. Returns the cut index (exclusive end of the line).
 */
export function chooseJaLineCut(chars: string[], limit: number): number {
  if (limit >= chars.length) return chars.length;
  const text = chars.join('');
  const phrase = phraseBreakOpportunities(text).filter((i) => i <= limit && i > 0);
  const best = phrase.length ? phrase[phrase.length - 1]! : -1;
  if (best >= Math.ceil(limit * 0.5)) return best;
  for (let cut = limit; cut > 0; cut -= 1) {
    if (kinsokuAllowsBreak(chars[cut - 1]!, chars[cut]!)) return cut;
  }
  return limit;
}

/**
 * Insert explicit line breaks into a short heading so its lines are balanced
 * and every break falls on a phrase boundary (no orphaned 「ん」 or leading 、).
 * `measure` returns the rendered width (pt) of a string; `maxWidthPt` is the box.
 * Headings that fit on one line, or with no usable boundary, are returned as-is.
 */
export function balanceJaHeading(
  text: string,
  maxWidthPt: number,
  measure: (value: string) => number
): string {
  const trimmed = String(text || '').trim();
  if (!trimmed || trimmed.includes('\n') || maxWidthPt <= 0) return trimmed;
  const total = measure(trimmed);
  if (total <= maxWidthPt) return trimmed;
  const lineCount = Math.ceil(total / maxWidthPt);
  if (lineCount > 3) return trimmed; // body-length text: leave wrapping to the renderer
  const chars = Array.from(trimmed);
  const breaks = phraseBreakOpportunities(trimmed);
  if (breaks.length === 0) return trimmed;

  const lines: string[] = [];
  let start = 0;
  for (let line = 1; line < lineCount; line += 1) {
    const remaining = chars.slice(start).join('');
    const target = measure(remaining) / (lineCount - line + 1);
    let bestCut = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const cut of breaks) {
      if (cut <= start) continue;
      const width = measure(chars.slice(start, cut).join(''));
      if (width > maxWidthPt) break;
      const score = Math.abs(width - target);
      if (score < bestScore) {
        bestScore = score;
        bestCut = cut;
      }
    }
    if (bestCut < 0) return trimmed;
    lines.push(chars.slice(start, bestCut).join('').trimEnd());
    start = bestCut;
  }
  const last = chars.slice(start).join('').trimStart();
  if (measure(last) > maxWidthPt) return trimmed;
  lines.push(last);
  return lines.join('\n');
}
