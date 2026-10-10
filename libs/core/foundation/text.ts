import { getFoundationIo, type FoundationReadOptions } from './io.js';
export { isRecord } from './primitives.js';
export type { FoundationReadOptions } from './io.js';

/** Read UTF-8 text through the registered secure foundation I/O boundary. */
export function readTextFile(filePath: string, options: FoundationReadOptions = {}): string {
  return getFoundationIo().readFile(filePath, options);
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

export function normalizeText(value: unknown): string {
  return asString(value).trim().replace(/\s+/gu, ' ');
}

/** Normalize whitespace and bound a user-facing excerpt with an ellipsis. */
export function truncateNormalizedText(value: unknown, max: number): string {
  const text = normalizeText(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new Error(`Invalid clamp range: ${min} > ${max}`);
  return Math.min(max, Math.max(min, value));
}

/**
 * Id-safe path/name segment: runs of characters outside [a-zA-Z0-9._-]
 * collapse to a single separator and edge separators are trimmed. Unlike
 * {@link slugify}, case and the `._-` characters are preserved.
 */
export function sanitizeIdSegment(
  value: string,
  options: { maxLength?: number; fallback?: string; separator?: string } = {}
): string {
  const separator = options.separator ?? '-';
  let cleaned = String(value ?? '')
    .trim()
    .split(/[^a-zA-Z0-9._-]+/)
    .filter((part) => part.length > 0)
    .join(separator);
  if (options.maxLength !== undefined) cleaned = cleaned.slice(0, options.maxLength);
  return cleaned || (options.fallback ?? '');
}

/**
 * Strip a trailing run of `chars` in linear time — anchored `/[…]+$/`
 * replacements are flagged as potentially polynomial on long runs.
 */
export function trimEndChars(value: string, chars: string): string {
  let end = value.length;
  while (end > 0 && chars.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

/** Mirror of {@link trimEndChars} for leading runs. */
export function trimStartChars(value: string, chars: string): string {
  let start = 0;
  while (start < value.length && chars.includes(value[start])) start += 1;
  return value.slice(start);
}

/**
 * Extract the first fenced code block (```lang\n…```) via indexOf scanning —
 * no lazy `[\s\S]*?` matching. Returns null when no complete fence exists.
 */
export function extractFencedBlock(
  text: string
): { lang: string; content: string; start: number; end: number } | null {
  const open = text.indexOf('```');
  if (open < 0) return null;
  const lineEnd = text.indexOf('\n', open + 3);
  if (lineEnd < 0) return null;
  const lang = text.slice(open + 3, lineEnd).trim();
  const close = text.indexOf('```', lineEnd + 1);
  if (close < 0) return null;
  return {
    lang,
    content: text.slice(lineEnd + 1, close),
    start: open,
    end: close + 3,
  };
}

/**
 * Replace every complete ```lang\n…``` block in `text` via indexOf scanning.
 * `replace` receives the fence language (trimmed), the block body, and the
 * whole matched block; return the replacement string (or `block` to keep).
 */
export function replaceFencedBlocks(
  text: string,
  replace: (lang: string, content: string, block: string) => string
): string {
  const out: string[] = [];
  let cursor = 0;
  for (;;) {
    const open = text.indexOf('```', cursor);
    if (open < 0) break;
    const lineEnd = text.indexOf('\n', open + 3);
    if (lineEnd < 0) break;
    const close = text.indexOf('```', lineEnd + 1);
    if (close < 0) break;
    out.push(text.slice(cursor, open));
    out.push(
      replace(
        text.slice(open + 3, lineEnd).trim(),
        text.slice(lineEnd + 1, close),
        text.slice(open, close + 3)
      )
    );
    cursor = close + 3;
  }
  out.push(text.slice(cursor));
  return out.join('');
}

export function slugify(
  value: string,
  options: {
    mode?: 'normalized' | 'whitespace';
    separator?: string;
    maxLength?: number;
    fallback?: string;
  } = {}
): string {
  const separator = options.separator ?? '-';
  const fallback = options.fallback ?? '';
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  if (options.mode === 'whitespace') {
    return String(value ?? '')
      .replace(/\s+/gu, options.separator ?? '_')
      .slice(0, maxLength);
  }
  const escaped = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${escaped}{2,}`, 'g'), separator)
    .replace(new RegExp(`^${escaped}+|${escaped}+$`, 'g'), '')
    .slice(0, maxLength);
  return result || fallback;
}
