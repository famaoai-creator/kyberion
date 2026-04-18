export const DEFAULT_VOICE_MAX_CHUNK_CHARS = 800;

const ABBREVIATIONS = new Set([
  'mr',
  'mrs',
  'ms',
  'dr',
  'prof',
  'sr',
  'jr',
  'st',
  'ave',
  'inc',
  'ltd',
  'vs',
  'etc',
  'e.g',
  'i.e',
  'a.m',
  'p.m',
  'u.s',
  'u.k',
]);

const PARA_TAG_RE = /\[[^\]]*\]/g;

export function splitVoiceTextIntoChunks(text: string, maxChars = DEFAULT_VOICE_MAX_CHUNK_CHARS): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= maxChars) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;

  while (remaining.length > 0) {
    remaining = remaining.trimStart();
    if (remaining.length <= maxChars) {
      chunks.push(remaining);
      break;
    }

    const segment = remaining.slice(0, maxChars);
    let splitPos = findLastSentenceEnd(segment);
    if (splitPos < 0) splitPos = findLastClauseBoundary(segment);
    if (splitPos < 0) splitPos = segment.lastIndexOf(' ');
    if (splitPos < 0) splitPos = findSafeHardCut(segment, maxChars);

    const chunk = remaining.slice(0, splitPos + 1).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(splitPos + 1);
  }

  return chunks;
}

export function concatenateVoiceAudioChunks(
  chunks: number[][],
  sampleRate: number,
  crossfadeMs = 50,
): number[] {
  if (chunks.length === 0) return [];
  if (chunks.length === 1) return [...chunks[0]];

  const crossfadeSamples = Math.max(0, Math.floor((sampleRate * crossfadeMs) / 1000));
  let result = [...chunks[0]];

  for (const chunk of chunks.slice(1)) {
    if (chunk.length === 0) continue;
    const overlap = Math.min(crossfadeSamples, result.length, chunk.length);
    if (overlap <= 0) {
      result = result.concat(chunk);
      continue;
    }
    for (let index = 0; index < overlap; index += 1) {
      const fadeOut = 1 - index / Math.max(1, overlap - 1);
      const fadeIn = index / Math.max(1, overlap - 1);
      const resultIndex = result.length - overlap + index;
      result[resultIndex] = result[resultIndex] * fadeOut + chunk[index] * fadeIn;
    }
    result = result.concat(chunk.slice(overlap));
  }

  return result;
}

function findLastSentenceEnd(text: string): number {
  let best = -1;
  const asciiRegex = /[.!?](?:\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = asciiRegex.exec(text)) !== null) {
    const pos = match.index;
    if (text[pos] === '.' && isAbbreviationBoundary(text, pos)) continue;
    if (isInsideBracketTag(text, pos)) continue;
    best = pos;
  }
  const cjkRegex = /[\u3002\uff01\uff1f]/g;
  while ((match = cjkRegex.exec(text)) !== null) {
    if (match.index > best) best = match.index;
  }
  return best;
}

function findLastClauseBoundary(text: string): number {
  let best = -1;
  const regex = /[;:,\u2014](?:\s|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (isInsideBracketTag(text, match.index)) continue;
    best = match.index;
  }
  return best;
}

function isInsideBracketTag(text: string, pos: number): boolean {
  let match: RegExpExecArray | null;
  PARA_TAG_RE.lastIndex = 0;
  while ((match = PARA_TAG_RE.exec(text)) !== null) {
    if (match.index < pos && pos < match.index + match[0].length) return true;
  }
  return false;
}

function findSafeHardCut(segment: string, maxChars: number): number {
  const cut = Math.max(0, maxChars - 1);
  let match: RegExpExecArray | null;
  PARA_TAG_RE.lastIndex = 0;
  while ((match = PARA_TAG_RE.exec(segment)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (start < cut && cut < end) return Math.max(0, start - 1);
  }
  return cut;
}

function isAbbreviationBoundary(text: string, pos: number): boolean {
  let cursor = pos - 1;
  while (cursor >= 0 && /[A-Za-z]/.test(text[cursor])) cursor -= 1;
  const word = text.slice(cursor + 1, pos).toLowerCase();
  if (ABBREVIATIONS.has(word)) return true;
  if (cursor >= 0 && /\d/.test(text[cursor])) return true;
  return false;
}
