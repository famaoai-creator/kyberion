/**
 * Framework-neutral mutation guard for UI surfaces.
 *
 * Extracted from operator-surface's api-guard so every mutating surface
 * (operator-surface /api/inbox, concierge approvals/outcomes, …) shares one
 * decision: allow loopback, allow bearer token (KYBERION_API_TOKEN /
 * KYBERION_LOCALADMIN_TOKEN), allow same-origin, otherwise 403.
 */

export interface SurfaceMutationRequest {
  url: string;
  getHeader(name: string): string | null;
}

export interface SurfaceMutationDecision {
  ok: boolean;
  status: number;
  reason: string;
}

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

function resolveBearerToken(request: SurfaceMutationRequest): string {
  const authHeader = request.getHeader('authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

export function authorizeSurfaceMutation(request: SurfaceMutationRequest): SurfaceMutationDecision {
  const url = new URL(request.url);
  if (isLoopbackHost(url.hostname)) {
    return { ok: true, status: 200, reason: 'local' };
  }

  const apiToken = process.env.KYBERION_API_TOKEN;
  const localadminToken = process.env.KYBERION_LOCALADMIN_TOKEN;
  const token = resolveBearerToken(request);
  if (token && (token === apiToken || token === localadminToken)) {
    return { ok: true, status: 200, reason: 'token' };
  }

  const origin = request.getHeader('origin') || '';
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
