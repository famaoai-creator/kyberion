export interface AudioTextComparison {
  expected_normalized: string;
  actual_normalized: string;
  normalized_exact_match: boolean;
  character_error_rate: number;
  word_error_rate: number;
  similarity: number;
  missing_spans: string[];
  unexpected_spans: string[];
}

const FILLERS = /(?:えーと|えっと|あのー|そのー|um+|uh+|まあ)/giu;
const PUNCTUATION = /[\p{P}\p{S}]/gu;

export function normalizeAudioText(text: string): string {
  return String(text || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(FILLERS, '')
    .replace(PUNCTUATION, '')
    .replace(/\s+/gu, '')
    .trim();
}

function levenshtein(left: readonly string[], right: readonly string[]): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j];
  }
  return previous[right.length];
}

function tokens(text: string): string[] {
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) {
    return Array.from(text).filter((token) => token.trim().length > 0);
  }
  return text.split(/\s+/u).filter(Boolean);
}

function spans(
  expected: readonly string[],
  actual: readonly string[]
): {
  missing: string[];
  unexpected: string[];
} {
  const remaining = new Map<string, number>();
  for (const token of actual) remaining.set(token, (remaining.get(token) || 0) + 1);
  const missing: string[] = [];
  for (const token of expected) {
    const count = remaining.get(token) || 0;
    if (count > 0) remaining.set(token, count - 1);
    else missing.push(token);
  }
  const unexpected: string[] = [];
  for (const [token, count] of remaining) {
    for (let index = 0; index < count; index += 1) unexpected.push(token);
  }
  return { missing, unexpected };
}

export function compareAudioText(expected: string, actual: string): AudioTextComparison {
  const expectedNormalized = normalizeAudioText(expected);
  const actualNormalized = normalizeAudioText(actual);
  const expectedChars = Array.from(expectedNormalized);
  const actualChars = Array.from(actualNormalized);
  const expectedTokens = tokens(expectedNormalized);
  const actualTokens = tokens(actualNormalized);
  const characterErrorRate =
    expectedChars.length === 0
      ? actualChars.length > 0
        ? 1
        : 0
      : levenshtein(expectedChars, actualChars) / expectedChars.length;
  const wordErrorRate =
    expectedTokens.length === 0
      ? actualTokens.length > 0
        ? 1
        : 0
      : levenshtein(expectedTokens, actualTokens) / expectedTokens.length;
  const similarity = Math.max(0, Math.min(1, 1 - (characterErrorRate * 0.7 + wordErrorRate * 0.3)));
  const differences = spans(expectedTokens, actualTokens);
  return {
    expected_normalized: expectedNormalized,
    actual_normalized: actualNormalized,
    normalized_exact_match:
      expectedNormalized === actualNormalized && expectedNormalized.length > 0,
    character_error_rate: characterErrorRate,
    word_error_rate: wordErrorRate,
    similarity,
    missing_spans: differences.missing,
    unexpected_spans: differences.unexpected,
  };
}
