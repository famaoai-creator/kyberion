import { NextRequest, NextResponse } from 'next/server';

const API_TOKEN = process.env.KYBERION_API_TOKEN;
const LOCALADMIN_TOKEN = process.env.KYBERION_LOCALADMIN_TOKEN;

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, '$1');
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized === '::ffff:7f00:1'
  );
}

function resolveBearerToken(req: Pick<NextRequest, 'headers'>): string {
  const authHeader = req.headers.get('authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

export function authorizeOperatorSurfaceMutation(req: Pick<NextRequest, 'headers' | 'url'>): {
  ok: boolean;
  status: number;
  reason: string;
} {
  const url = new URL(req.url);
  if (isLoopbackHost(url.hostname)) {
    return { ok: true, status: 200, reason: 'local' };
  }

  const token = resolveBearerToken(req);
  if (token && (token === API_TOKEN || token === LOCALADMIN_TOKEN)) {
    return { ok: true, status: 200, reason: 'token' };
  }

  const origin = req.headers.get('origin') || '';
  if (origin) {
    try {
      if (new URL(origin).origin === url.origin) {
        return { ok: true, status: 200, reason: 'same-origin' };
      }
    } catch {
      // fall through to deny
    }
  }

  return {
    ok: false,
    status: 403,
    reason:
      'Forbidden. Use the same origin or provide KYBERION_API_TOKEN / KYBERION_LOCALADMIN_TOKEN.',
  };
}

export function requireOperatorSurfaceMutationAccess(req: NextRequest): NextResponse | null {
  const decision = authorizeOperatorSurfaceMutation(req);
  if (!decision.ok) {
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }
  return null;
}
