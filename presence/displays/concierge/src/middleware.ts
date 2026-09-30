import { NextResponse, type NextRequest } from 'next/server';
import {
  SURFACE_SESSION_COOKIE,
  isSurfaceAuthPath,
  parseCookieHeader,
  peekSessionExpiry,
  resolveLoginRedirect,
} from '@agent/core/surface/surface-session-cookie';
import { isLoopbackPeer } from './lib/loopback-peer';

/** UX-only hint set by /signin after a pasted token is accepted. Grants nothing. */
export const CLIENT_TOKEN_HINT_COOKIE = 'kyberion_client_token';

/**
 * Bounce unauthenticated remote browser page navigations to /login. Never an
 * authorization decision: API routes (unchanged, JSON 401) verify the real
 * credential themselves, and loopback is never redirected.
 */
export function middleware(req: NextRequest): NextResponse {
  const { pathname, search } = req.nextUrl;
  if (isSurfaceAuthPath(pathname) || pathname === '/signin') return NextResponse.next();

  const cookies = parseCookieHeader(req.headers.get('cookie'));
  const session = cookies[SURFACE_SESSION_COOKIE] ?? '';
  const hasCredential =
    Boolean(req.headers.get('authorization')?.trim()) ||
    (session !== '' && peekSessionExpiry(session) === 'valid') ||
    cookies[CLIENT_TOKEN_HINT_COOKIE] === '1';

  const target = resolveLoginRedirect({
    method: req.method,
    pathname,
    search,
    headers: req.headers,
    loopback: isLoopbackPeer(req),
    hasCredential,
  });
  if (!target) return NextResponse.next();
  return NextResponse.redirect(new URL(target, req.url), 302);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
