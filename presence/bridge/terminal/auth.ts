import { extractSurfaceBearerToken } from '@agent/core/surface-mutation-guard';

type HeaderValue = string | string[] | undefined;

export interface TerminalRequestLike {
  headers: Record<string, HeaderValue>;
  url?: string;
  socket?: { remoteAddress?: string | null };
}

export interface TerminalAuthorizationDecision {
  ok: boolean;
  status: number;
  reason: string;
}

function firstHeaderValue(value: HeaderValue): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function clientIp(request: TerminalRequestLike, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstHeaderValue(request.headers['x-forwarded-for']);
    if (forwarded?.trim()) return forwarded.split(',')[0].trim();
  }
  return request.socket?.remoteAddress || 'unknown';
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function requestToken(request: TerminalRequestLike): string {
  const bearer = extractSurfaceBearerToken(firstHeaderValue(request.headers.authorization));
  if (bearer) return bearer;
  try {
    return new URL(request.url || '/', 'http://localhost').searchParams.get('token') || '';
  } catch {
    return '';
  }
}

export function authorizeTerminalRequest(
  request: TerminalRequestLike,
  terminalToken: string | undefined,
  trustProxy: boolean
): TerminalAuthorizationDecision {
  if (isLoopback(clientIp(request, trustProxy))) {
    return { ok: true, status: 200, reason: 'local' };
  }

  if (!terminalToken) {
    return {
      ok: false,
      status: 403,
      reason: 'Remote terminal access requires KYBERION_TERMINAL_TOKEN or KYBERION_API_TOKEN.',
    };
  }

  if (requestToken(request) === terminalToken) {
    return { ok: true, status: 200, reason: 'token' };
  }
  return {
    ok: false,
    status: 401,
    reason: 'Unauthorized. Provide Authorization: Bearer <token> or ?token=',
  };
}
