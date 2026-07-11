/**
 * Framework-neutral mutation guard for UI surfaces.
 *
 * Extracted from operator-surface's api-guard so every mutating surface
 * (operator-surface /api/inbox, concierge approvals/outcomes, …) shares one
 * decision: allow bearer token (KYBERION_API_TOKEN /
 * KYBERION_LOCALADMIN_TOKEN), allow same-origin, otherwise 403.
 */

import { timingSafeEqual } from 'node:crypto';

export interface SurfaceMutationRequest {
  url: string;
  getHeader(name: string): string | null;
}

export interface SurfaceMutationDecision {
  ok: boolean;
  status: number;
  reason: string;
}

function resolveBearerToken(request: SurfaceMutationRequest): string {
  const authHeader = request.getHeader('authorization') || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
}

function matchesConfiguredToken(candidate: string, configured: string | undefined): boolean {
  if (!candidate || !configured) return false;
  const candidateBuffer = Buffer.from(candidate);
  const configuredBuffer = Buffer.from(configured);
  return (
    candidateBuffer.length === configuredBuffer.length &&
    timingSafeEqual(candidateBuffer, configuredBuffer)
  );
}

export function authorizeSurfaceMutation(request: SurfaceMutationRequest): SurfaceMutationDecision {
  const url = new URL(request.url);
  const apiToken = process.env.KYBERION_API_TOKEN;
  const localadminToken = process.env.KYBERION_LOCALADMIN_TOKEN;
  const token = resolveBearerToken(request);
  if (matchesConfiguredToken(token, apiToken) || matchesConfiguredToken(token, localadminToken)) {
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
