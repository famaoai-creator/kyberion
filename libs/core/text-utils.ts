export interface SlugifyOptions {
  mode?: 'normalized' | 'whitespace';
  separator?: string;
  maxLength?: number;
  fallback?: string;
}

export function slugify(value: string, options: SlugifyOptions = {}): string {
  const input = String(value ?? '');

  if (options.mode === 'whitespace') {
    const separator = options.separator ?? '_';
    return input.replace(/\s+/gu, separator).slice(0, options.maxLength ?? 48);
  }

  const separator = options.separator ?? '-';
  const fallback = options.fallback ?? '';
  const maxLength = options.maxLength ?? Number.POSITIVE_INFINITY;
  const escapedSeparator = separator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escapedSeparator}+|${escapedSeparator}+$`, 'g');

  const result = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, separator)
    .replace(new RegExp(`${escapedSeparator}{2,}`, 'g'), separator)
    .replace(regex, '')
    .slice(0, maxLength);

  return result || fallback;
}
