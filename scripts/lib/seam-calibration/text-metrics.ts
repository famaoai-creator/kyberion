/**
 * Text comparison shared by calibration adapters (OCR, STT).
 *
 * Providers differ in spacing (tesseract inserts spaces between Japanese
 * characters; Japanese transcripts have none), punctuation and full/half-width
 * forms; none of that is a recognition error, so texts are compared as NFKC,
 * lower-cased code points without whitespace and punctuation.
 */

export function normalizeTextForCer(text: string): string[] {
  return Array.from(
    String(text ?? '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}]/gu, '')
  );
}

/**
 * Character Error Rate over normalised texts: Levenshtein distance divided by
 * the reference length, capped at 1 (0 = identical, 1 = no better than empty).
 */
export function characterErrorRate(hypothesis: string, reference: string): number {
  const hyp = normalizeTextForCer(hypothesis);
  const ref = normalizeTextForCer(reference);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  if (hyp.length === 0) return 1;
  let previous = Array.from({ length: ref.length + 1 }, (_, j) => j);
  for (let i = 1; i <= hyp.length; i += 1) {
    const current = new Array<number>(ref.length + 1);
    current[0] = i;
    for (let j = 1; j <= ref.length; j += 1) {
      const cost = hyp[i - 1] === ref[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
    }
    previous = current;
  }
  return Math.min(1, previous[ref.length]! / ref.length);
}
