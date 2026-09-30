import type { NextRequest } from 'next/server';
import { handleSurfaceAuthRoute } from '@agent/core/surface/surface-auth-routes';
import { isLoopbackRequest } from './peer';
import { getRegisteredEnvBool } from '@agent/core/foundation/env';
import { resolveAuthClientKey } from '@agent/core/surface/surface-session-cookie';

export const OPERATOR_SURFACE_ID = 'operator-surface';
export const OPERATOR_SURFACE_LABEL = 'Operator';

/** Adapt a Next route request onto the shared login-flow handler. */
export async function handleOperatorAuthRoute(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const result = await handleSurfaceAuthRoute({
    surfaceId: OPERATOR_SURFACE_ID,
    surfaceLabel: OPERATOR_SURFACE_LABEL,
    method: req.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    cookieHeader: req.headers.get('cookie'),
    acceptLanguage: req.headers.get('accept-language'),
    requestOrigin: url.origin,
    loopback: isLoopbackRequest(req),
    clientKey: resolveAuthClientKey({
      ip: (req as { ip?: string }).ip,
      forwardedFor: req.headers.get('x-forwarded-for'),
      realIp: req.headers.get('x-real-ip'),
      trustProxy: getRegisteredEnvBool('KYBERION_TRUST_PROXY') === true,
    }),
    secFetchSite: req.headers.get('sec-fetch-site'),
  });
  if (!result) return new Response('Not found', { status: 404 });
  const headers = new Headers(result.headers);
  for (const cookie of result.setCookies) headers.append('Set-Cookie', cookie);
  return new Response(result.body || null, { status: result.status, headers });
}
