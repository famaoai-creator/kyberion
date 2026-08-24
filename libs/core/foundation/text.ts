export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : value == null ? fallback : String(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeText(value: unknown): string {
  return asString(value).trim().replace(/\s+/gu, ' ');
}

export function clamp(value: number, min: number, max: number): number {
  if (min > max) throw new Error(`Invalid clamp range: ${min} > ${max}`);
  return Math.min(max, Math.max(min, value));
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
