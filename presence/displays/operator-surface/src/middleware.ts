import { NextResponse, type NextRequest } from 'next/server';
import {
  extractSurfaceCredential,
  isSurfaceAuthPath,
  peekSessionExpiry,
  resolveLoginRedirect,
} from '@agent/core/surface/surface-session-cookie';
import { LOOPBACK_HEADER, isLoopbackPeer } from './lib/peer';

/**
 * Edge gate. Loopback (real socket peer) stays open. For remote callers this
 * is the UX/presence layer only — unauthenticated page navigations go to
 * /login, unauthenticated API calls get 401. The signature/expiry/member
 * verification happens server-side (`requireOperatorViewer` in the root
 * layout, `requireOperatorViewerAccess` in API guards), so a forged cookie
 * that passes this peek still cannot render a page or mutate.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;
  const loopback = isLoopbackPeer(request);

  // Never trust an inbound copy of the loopback marker; re-derive it.
  const forwarded = new Headers(request.headers);
  forwarded.delete(LOOPBACK_HEADER);
  if (loopback) forwarded.set(LOOPBACK_HEADER, '1');
  const pass = () => NextResponse.next({ request: { headers: forwarded } });

  if (loopback || isSurfaceAuthPath(pathname)) return pass();

  const authorization = request.headers.get('authorization');
  const sessionToken = extractSurfaceCredential({
    cookie: request.headers.get('cookie'),
  }).token;
  const sessionUsable = Boolean(sessionToken) && peekSessionExpiry(sessionToken) === 'valid';
  const hasCredential = Boolean(authorization) || sessionUsable;

  if (!hasCredential) {
    const redirect = resolveLoginRedirect({
      method: request.method,
      pathname,
      search,
      headers: request.headers,
      loopback,
      hasCredential,
    });
    if (redirect) return NextResponse.redirect(new URL(redirect, request.url), 302);
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
    }
  }
  return pass();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
