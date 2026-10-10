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
 * collapse to a single '-' and edge separators are trimmed. Unlike
 * {@link slugify}, case and the `._-` characters are preserved.
 */
export function sanitizeIdSegment(
  value: string,
  options: { maxLength?: number; fallback?: string } = {}
): string {
  let cleaned = String(value ?? '')
    .trim()
    .split(/[^a-zA-Z0-9._-]+/)
    .filter((part) => part.length > 0)
    .join('-');
  if (options.maxLength !== undefined) cleaned = cleaned.slice(0, options.maxLength);
  return cleaned || (options.fallback ?? '');
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
