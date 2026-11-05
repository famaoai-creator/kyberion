/**
 * The short per-viewer cache behind the per-company fan-out reader
 * (`company-fanout-reader.ts`). Kept free of store imports so every needs-you
 * mutation route can invalidate it without pulling the home reader in.
 *
 * - Each read is kept for `COMPANY_FANOUT_TTL_MS`, keyed by the authenticated
 *   principal and every server-resolved scope field — never shared across
 *   viewers, and never kept for a viewer without a principal.
 * - A decide / approve / review / curate route wraps its handler in
 *   `withCompanyFanoutInvalidation`, so a just-decided item never reappears
 *   from the cache (`tests/company-fanout-invalidation-boundary.test.ts`).
 */
import type { ConciergeViewerContext } from './viewer-context';

/** How long one fan-out home read is reused for the same viewer and scope. */
export const COMPANY_FANOUT_TTL_MS = 5_000;
/** Upper bound on cached reads (oldest dropped first). */
export const COMPANY_FANOUT_CACHE_MAX_ENTRIES = 256;

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

/**
 * One cache per server process. Held on `globalThis` so every route bundle
 * that imports this module sees the same entries — and the same invalidation.
 */
const CACHE_KEY = Symbol.for('kyberion.concierge.company-fanout-cache');
function cache(): Map<string, CacheEntry> {
  const holder = globalThis as unknown as Record<symbol, Map<string, CacheEntry> | undefined>;
  holder[CACHE_KEY] ??= new Map();
  return holder[CACHE_KEY]!;
}

function list(value: readonly string[] | 'all'): readonly string[] | 'all' {
  return value === 'all' ? 'all' : [...value].sort();
}

/** Every field that changes what a read may return; null = do not cache. */
export function companyFanoutCacheKey(
  viewer: ConciergeViewerContext,
  discriminator: string
): string | null {
  if (!viewer.principalId) return null;
  return JSON.stringify([
    discriminator,
    viewer.principalId,
    viewer.source,
    viewer.role,
    viewer.memberId ?? null,
    viewer.registrationLabel ?? null,
    list(viewer.tenantSlugs),
    list(viewer.organizationIds),
    list(viewer.projectIds),
    [...viewer.tierAccess].sort(),
    viewer.includeUntenanted === true,
  ]);
}

/** `read()` for this viewer, reused for `COMPANY_FANOUT_TTL_MS`. */
export function readThroughCompanyFanoutCache<T>(
  viewer: ConciergeViewerContext,
  discriminator: string,
  read: () => T,
  now: number = Date.now()
): T {
  const key = companyFanoutCacheKey(viewer, discriminator);
  if (!key) return read();
  const entries = cache();
  const hit = entries.get(key);
  if (hit && hit.expiresAt > now) return hit.value as T;
  if (hit) entries.delete(key);
  const value = read();
  for (const [entryKey, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(entryKey);
  }
  while (entries.size >= COMPANY_FANOUT_CACHE_MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
  entries.set(key, { expiresAt: now + COMPANY_FANOUT_TTL_MS, value });
  return value;
}

/** Drop every cached fan-out read (a needs-you item changed state). */
export function invalidateCompanyFanoutCache(): void {
  cache().clear();
}

/** Cached entries (tests and diagnostics only). */
export function companyFanoutCacheSize(): number {
  return cache().size;
}

/**
 * Wrap a needs-you mutation handler: the cache is cleared once the mutation
 * has settled (succeeded or failed), so the next read sees the store as it is.
 */
export function withCompanyFanoutInvalidation<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } finally {
      invalidateCompanyFanoutCache();
    }
  };
}
