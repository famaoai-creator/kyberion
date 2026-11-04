import { NextResponse, type NextRequest } from 'next/server';
import { resolveSurfaceBrowserUrl, resolveSurfaceUrl } from '@agent/core/surface/surface-url';

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

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Hostname of a `Host` header value (`localhost:3000`, `[::1]:3000`), lowercased. */
export function hostHeaderHostname(host: string | null | undefined): string | null {
  const value = String(host || '')
    .trim()
    .toLowerCase();
  if (!value) return null;
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Session cookies are host-scoped, so a browser that reached Chronos on
 * `localhost:3000` must land on `localhost:<concierge port>`, not on the
 * registry default `127.0.0.1:<port>`. Only the loopback hostname is ever taken
 * from the request, and only when no public / override origin was declared
 * (browser origin === registry service origin, itself loopback). Any other Host
 * is ignored, so the redirect target can never point off-box (open-redirect
 * safety).
 */
export function conciergeOriginForRequest(
  browserOrigin: string,
  serviceOrigin: string,
  requestHost: string | null | undefined
): string {
  const browser = new URL(browserOrigin);
  if (browser.origin !== new URL(serviceOrigin).origin) return browserOrigin;
  if (!LOOPBACK_HOSTNAMES.has(browser.hostname)) return browserOrigin;
  const incoming = hostHeaderHostname(requestHost);
  if (!incoming || !LOOPBACK_HOSTNAMES.has(incoming) || incoming === browser.hostname) {
    return browserOrigin;
  }
  browser.hostname = incoming;
  return browser.origin;
}

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  if (pathname === CHRONOS_HEALTH_PATH) return NextResponse.next();
  let origin: string;
  try {
    origin = conciergeOriginForRequest(
      resolveSurfaceBrowserUrl('concierge'),
      resolveSurfaceUrl('concierge'),
      request.headers.get('host')
    );
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
