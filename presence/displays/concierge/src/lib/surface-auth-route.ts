import type { NextRequest } from 'next/server';
import { handleSurfaceAuthRoute } from '@agent/core/surface/surface-auth-routes';
import { isLoopbackPeer } from './loopback-peer';
import { getRegisteredEnvBool } from '@agent/core/foundation/env';
import { resolveAuthClientKey } from '@agent/core/surface/surface-session-cookie';
import { FIRST_RUN_SETUP_HREF, firstRunOpen } from './first-run-server';
import { resolveLoginLocale } from '@agent/core/surface/surface-login-pages';
import { FRONT_DESK_SIGNOUT_HEADERS, renderFrontDeskSignoutPage } from './front-desk-signout';

export const CONCIERGE_SURFACE_ID = 'concierge';
export const CONCIERGE_SURFACE_LABEL = 'Concierge';
export const CONCIERGE_TOKEN_SIGNIN_HREF = '/signin';

/** Adapt a NextRequest to the shared browser-OIDC route handler. */
export async function handleConciergeAuthRoute(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const result = await handleSurfaceAuthRoute({
    surfaceId: CONCIERGE_SURFACE_ID,
    surfaceLabel: CONCIERGE_SURFACE_LABEL,
    method: req.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    cookieHeader: req.headers.get('cookie'),
    acceptLanguage: req.headers.get('accept-language'),
    requestOrigin: url.origin,
    loopback: isLoopbackPeer(req),
    clientKey: resolveAuthClientKey({
      ip: (req as { ip?: string }).ip,
      forwardedFor: req.headers.get('x-forwarded-for'),
      realIp: req.headers.get('x-real-ip'),
      trustProxy: getRegisteredEnvBool('KYBERION_TRUST_PROXY') === true,
    }),
    secFetchSite: req.headers.get('sec-fetch-site'),
    referrerOrigin: req.headers.get('origin') ?? req.headers.get('referer'),
    tokenSignInHref: CONCIERGE_TOKEN_SIGNIN_HREF,
    ...(url.pathname === '/login' && firstRunOpen()
      ? { firstRunSetupHref: FIRST_RUN_SETUP_HREF }
      : {}),
  });
  if (!result) return new Response('Not found', { status: 404 });
  // Only the shared handler may authorize logout. Denials, unsupported methods,
  // and every other auth route retain their original response unchanged.
  const cleanup =
    url.pathname === '/logout' &&
    result.status === 302 &&
    result.headers.Location === '/login?signedout=1';
  const headers = new Headers(cleanup ? FRONT_DESK_SIGNOUT_HEADERS : result.headers);
  for (const cookie of result.setCookies) headers.append('Set-Cookie', cookie);
  if (cleanup) {
    const locale = resolveLoginLocale(
      url.searchParams.get('lang'),
      req.headers.get('accept-language')
    );
    return new Response(renderFrontDeskSignoutPage(locale), { status: 200, headers });
  }
  return new Response(result.body || null, { status: result.status, headers });
}
