/** Normalize an intent overlay path segment without inventing a fallback. */
export function sanitizeIntentPathSegment(value: string): string {
  return value
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
