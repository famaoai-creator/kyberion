/**
 * Framework-neutral mutation guard for UI surfaces.
 *
 * Extracted from operator-surface's api-guard so every mutating surface
 * (operator-surface /api/inbox, concierge approvals/outcomes, …) shares one
 * decision: allow bearer token (KYBERION_API_TOKEN /
 * KYBERION_LOCALADMIN_TOKEN), allow same-origin, otherwise 403.
 */

import { timingSafeEqual } from 'node:crypto';
import { isValidChronosScopeId, type ChronosAccessRole } from './chronos-access-registry.js';
import { isValidTenantSlug } from './entity-scope.js';
import type { OsKnowledgeTier } from './cloudflare-os-control-plane.js';

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

/** Framework-neutral viewer scope shared by HTTP surfaces. */
export interface SurfaceViewerScope {
  role: ChronosAccessRole;
  tenantSlugs: string[] | 'all';
  organizationIds: string[] | 'all';
  projectIds: string[] | 'all';
  tierAccess: OsKnowledgeTier[];
  source: 'token' | 'loopback' | 'anonymous';
  principalId?: string;
}

export class SurfaceViewerScopeError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'SurfaceViewerScopeError';
  }
}

const ROLE_TIER_ACCESS: Record<ChronosAccessRole, readonly OsKnowledgeTier[]> = {
  readonly: ['public', 'confidential'],
  localadmin: ['personal', 'confidential', 'public'],
};

export function defaultSurfaceViewerTierAccess(role: ChronosAccessRole): OsKnowledgeTier[] {
  return [...ROLE_TIER_ACCESS[role]];
}

/** A registration can narrow a role, but never widen its tier policy. */
export function resolveSurfaceViewerTierAccess(
  role: ChronosAccessRole,
  requested?: readonly OsKnowledgeTier[]
): OsKnowledgeTier[] {
  const allowed = ROLE_TIER_ACCESS[role];
  if (!requested) return [...allowed];
  const normalized = [...new Set(requested)];
  if (!normalized.length || normalized.some((tier) => !allowed.includes(tier))) {
    throw new SurfaceViewerScopeError(403, `viewer tier scope exceeds the ${role} role policy.`);
  }
  return normalized;
}

export function narrowSurfaceViewerTier(
  viewer: Pick<SurfaceViewerScope, 'role' | 'tierAccess'>,
  requested: OsKnowledgeTier
): OsKnowledgeTier {
  const allowed = viewer.tierAccess.length
    ? viewer.tierAccess
    : defaultSurfaceViewerTierAccess(viewer.role);
  if (!allowed.includes(requested)) {
    throw new SurfaceViewerScopeError(403, `viewer tier scope denied: ${requested}`);
  }
  return requested;
}

function narrowViewerScope(
  kind: 'tenant' | 'organization' | 'project',
  allowed: string[] | 'all',
  requested?: string | null
): string[] | 'all' {
  const value = requested?.trim() || undefined;
  const valid =
    kind === 'tenant'
      ? value === undefined || isValidTenantSlug(value)
      : value === undefined || isValidChronosScopeId(value);
  if (!valid) throw new SurfaceViewerScopeError(403, `invalid viewer ${kind} scope: ${value}`);
  if (value && allowed !== 'all' && !allowed.includes(value)) {
    throw new SurfaceViewerScopeError(403, `viewer ${kind} scope denied: ${value}`);
  }
  return value ? [value] : allowed;
}

export function narrowSurfaceViewerScope(
  viewer: Pick<SurfaceViewerScope, 'tenantSlugs' | 'organizationIds' | 'projectIds'>,
  requested: {
    tenant?: string | null;
    organizationId?: string | null;
    projectId?: string | null;
  }
) {
  return {
    tenantSlugs: narrowViewerScope('tenant', viewer.tenantSlugs, requested.tenant),
    organizationIds: narrowViewerScope(
      'organization',
      viewer.organizationIds,
      requested.organizationId
    ),
    projectIds: narrowViewerScope('project', viewer.projectIds, requested.projectId),
  };
}

export function narrowSurfaceViewerTenant(
  viewer: Pick<SurfaceViewerScope, 'tenantSlugs'>,
  requested?: string | null
): string[] | 'all' {
  return narrowViewerScope('tenant', viewer.tenantSlugs, requested);
}
