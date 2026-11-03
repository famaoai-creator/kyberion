/**
 * Single source of the operations console's URLs inside Concierge. The
 * console (formerly the Chronos surface) is served under `/ops`, its API under
 * `/api/ops`. Client code builds every request and link through these helpers
 * so the mount point is changed in one place.
 */
export const OPS_API_BASE = '/api/ops';
export const OPS_PAGE_BASE = '/ops';

/** `/agents?x=1` → `/api/ops/agents?x=1`. A path already under the base is returned as-is. */
export function opsApiPath(path: string): string {
  if (path === OPS_API_BASE || path.startsWith(OPS_API_BASE + '/')) return path;
  return OPS_API_BASE + (path.startsWith('/') ? path : '/' + path);
}

/** `?section=x` / `/discussion` → `/ops?section=x` / `/ops/discussion`. */
export function opsPagePath(pathOrSearch = ''): string {
  if (!pathOrSearch || pathOrSearch === '/') return OPS_PAGE_BASE;
  if (pathOrSearch.startsWith('?')) return OPS_PAGE_BASE + pathOrSearch;
  if (pathOrSearch.startsWith('/?')) return OPS_PAGE_BASE + pathOrSearch.slice(1);
  return OPS_PAGE_BASE + (pathOrSearch.startsWith('/') ? pathOrSearch : '/' + pathOrSearch);
}
