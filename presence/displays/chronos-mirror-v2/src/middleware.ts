import { NextResponse, type NextRequest } from 'next/server';

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
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
  const directIp = (request as NextRequest & { ip?: string }).ip;
  const forwardedFor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const loopbackAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
  const loopback = directIp
    ? loopbackAddresses.includes(directIp) &&
      (!forwardedFor || loopbackAddresses.includes(forwardedFor))
    : isLoopbackHost(request.nextUrl.hostname) &&
      (!forwardedFor || loopbackAddresses.includes(forwardedFor));
  if (!hasCredential && !loopback) {
    return NextResponse.json({ ok: false, error: 'Unauthorized.' }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = { matcher: ['/api/:path*'] };
