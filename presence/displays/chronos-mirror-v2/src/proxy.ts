import { NextResponse, type NextRequest } from 'next/server';
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';

/**
 * Chronos compatibility app (MSN-KYBERION-SERVER-20261104). The operations
 * console moved into Concierge: pages are served at `/ops`, the API at
 * `/api/ops`. This process keeps its port only so old bookmarks and scripts
 * land on the new origin:
 *
 *   /api/healthz        → served locally (surface health probe)
 *   /api/<path>         → 308 <concierge>/api/ops/<path>
 *   /discussion         → 308 <concierge>/ops/discussion
 *   any other path      → 308 <concierge>/ops
 *
 * The query string (`?section=…`, tenant/organization/project scope, …) is
 * preserved. 308 keeps the method and body, so an old POST is replayed against
 * Concierge, which applies its own viewer and mutation gates. Nothing is
 * authorized here.
 */
export const CHRONOS_HEALTH_PATH = '/api/healthz';

export function chronosRedirectPath(pathname: string): string | null {
  if (pathname === CHRONOS_HEALTH_PATH) return null;
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return '/api/ops' + pathname.slice('/api'.length);
  }
  if (pathname === '/discussion' || pathname.startsWith('/discussion/')) return '/ops/discussion';
  return '/ops';
}

export function chronosRedirectTarget(
  pathname: string,
  search: string,
  conciergeOrigin: string
): string | null {
  const path = chronosRedirectPath(pathname);
  if (path === null) return null;
  return new URL(path + (search || ''), conciergeOrigin).toString();
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (pathname === CHRONOS_HEALTH_PATH) return NextResponse.next();
  let origin: string;
  try {
    origin = resolveSurfaceBrowserUrl('concierge');
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: 'The operations console moved to Concierge, whose URL is not configured.',
      },
      { status: 503 }
    );
  }
  const target = chronosRedirectTarget(pathname, search, origin);
  return target ? NextResponse.redirect(target, 308) : NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
