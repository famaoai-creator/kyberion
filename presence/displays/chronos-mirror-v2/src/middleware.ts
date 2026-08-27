import { NextResponse, type NextRequest } from 'next/server';

const LOOPBACK_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Mirror of `getRegisteredEnvBool` truthiness for the edge runtime. Middleware
 * cannot import the node-side env registry accessors, so the accepted forms are
 * duplicated here and must stay in sync with `libs/core/foundation/env.ts`.
 */
function isTrustProxyEnabled(): boolean {
  const raw = process.env.KYBERION_TRUST_PROXY;
  return typeof raw === 'string' && /^(1|true|yes|on)$/i.test(raw);
}

/**
 * Resolve the caller peer. Forwarded headers are caller-controlled unless a
 * trusted reverse proxy overwrites them, so they are only consulted when
 * `KYBERION_TRUST_PROXY` is explicitly enabled — matching `lib/api-guard.ts`.
 */
function resolvePeerIp(request: NextRequest): string | undefined {
  const directIp = (request as NextRequest & { ip?: string }).ip;
  if (directIp) return directIp;
  if (!isTrustProxyEnabled()) return undefined;
  return (
    request.headers.get('x-real-ip')?.trim() ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    undefined
  );
}

/**
 * Keep the API surface closed before a route module is evaluated. The route
 * guard performs the full token/registry/role decision; this node-free
 * boundary prevents accidental unguarded API routes and leaves /healthz as
 * the sole explicit public probe.
 */
export function middleware(request: NextRequest): NextResponse {
  if (request.nextUrl.pathname === '/api/healthz') return NextResponse.next();
  const hasCredential = Boolean(
    request.headers.get('authorization') || request.cookies.get('kyberion_token')?.value
  );
  const peerIp = resolvePeerIp(request);
  const loopback = Boolean(peerIp && LOOPBACK_ADDRESSES.includes(peerIp));
  if (!hasCredential && !loopback) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*'] };
