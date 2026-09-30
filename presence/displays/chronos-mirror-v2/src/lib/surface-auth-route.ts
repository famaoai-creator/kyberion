import type { NextRequest } from 'next/server';
import { handleSurfaceAuthRoute } from '@agent/core/surface/surface-auth-routes';
import { isChronosLoopbackRequest } from './api-guard';
import { getRegisteredEnvBool } from '@agent/core/foundation/env';
import { resolveAuthClientKey } from '@agent/core/surface/surface-session-cookie';

export const CHRONOS_SURFACE_ID = 'chronos-mirror-v2';
export const CHRONOS_SURFACE_LABEL = 'Chronos';

/** Adapt a NextRequest to the shared browser-OIDC route handler. */
export async function handleChronosAuthRoute(req: NextRequest): Promise<Response> {
  const result = await handleSurfaceAuthRoute({
    surfaceId: CHRONOS_SURFACE_ID,
    surfaceLabel: CHRONOS_SURFACE_LABEL,
    method: req.method,
    pathname: req.nextUrl.pathname,
    searchParams: req.nextUrl.searchParams,
    cookieHeader: req.headers.get('cookie'),
    acceptLanguage: req.headers.get('accept-language'),
    requestOrigin: req.nextUrl.origin,
    loopback: isChronosLoopbackRequest(req),
    clientKey: resolveAuthClientKey({
      ip: (req as { ip?: string }).ip,
      forwardedFor: req.headers.get('x-forwarded-for'),
      realIp: req.headers.get('x-real-ip'),
      trustProxy: getRegisteredEnvBool('KYBERION_TRUST_PROXY') === true,
    }),
    secFetchSite: req.headers.get('sec-fetch-site'),
  });
  if (!result) return new Response('Not Found', { status: 404 });
  const headers = new Headers(result.headers);
  for (const cookie of result.setCookies) headers.append('set-cookie', cookie);
  return new Response(result.body || null, { status: result.status, headers });
}
