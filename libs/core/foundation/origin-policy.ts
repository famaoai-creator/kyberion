function canonicalOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * Exact-origin match only.
 *
 * Related origins (for example `www.yahoo.co.jp` and `news.yahoo.co.jp`) must
 * be listed explicitly in the procedure catalog. Do not infer trust from string
 * prefixes or shared suffixes.
 */
export function matchesAllowedOrigin(allowedOrigin: string, actualOrigin: string): boolean {
  const allowed = canonicalOrigin(allowedOrigin);
  const actual = canonicalOrigin(actualOrigin);
  return allowed !== null && actual !== null && allowed === actual;
}
