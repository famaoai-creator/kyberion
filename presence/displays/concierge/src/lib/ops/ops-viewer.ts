/**
 * Viewer helpers for the operations console routes (`/api/ops/*`, formerly the
 * Chronos API). There is one viewer model: every helper here works on the
 * Concierge viewer context resolved by `resolveConciergeViewer` (credential,
 * registry, loopback attestation and server tenant are all resolved
 * server-side). These helpers only narrow that viewer — a request-supplied
 * tenant / organization / project / tier can select inside the allowed set,
 * never widen it.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { auditChain } from '@agent/core/governance/audit-chain';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import type { ChronosAccessRole } from '@agent/core/chronos-access-registry';
import {
  narrowSurfaceViewerScope,
  narrowSurfaceViewerTenant,
  narrowSurfaceViewerTier,
  resolveSurfaceViewerTierAccess,
} from '@agent/core/surface/surface-mutation-guard';
import { toWireError } from '@agent/core/wire-error';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { getRegisteredEnvText } from '@agent/core/foundation';
import type { OsKnowledgeTier } from '@agent/core/cloudflare-os-control-plane';
import type { SurfaceAuthorizationContext } from '@agent/core/surface/surface-authorization';
import {
  ConciergeViewerError,
  defaultTierAccess as conciergeDefaultTierAccess,
  resolveConciergeViewer,
  type ConciergeViewerContext,
} from '../viewer-context';

/**
 * The Concierge viewer, with the scope lists optional so a narrowed copy (or
 * a test fixture) that omits them reads as "role default / unrestricted
 * within the tenant set" exactly as the operations console always did.
 */
export type ViewerContext = Omit<
  ConciergeViewerContext,
  'organizationIds' | 'projectIds' | 'tierAccess'
> & {
  organizationIds?: string[] | 'all';
  projectIds?: string[] | 'all';
  tierAccess?: OsKnowledgeTier[];
};

/** The operations console raises the same error type as every Concierge route. */
export { ConciergeViewerError as ViewerContextError };

/** Execution roles of the operations console reads (security-policy grants). */
export const OPS_LOCALADMIN_EXECUTION_ROLE = 'chronos_localadmin' as const;
export const OPS_OPERATOR_EXECUTION_ROLE = 'chronos_operator' as const;
type OpsExecutionRole = typeof OPS_LOCALADMIN_EXECUTION_ROLE | typeof OPS_OPERATOR_EXECUTION_ROLE;

/**
 * Resolve the viewer of an operations request through the Concierge viewer
 * resolution (rate limit applied once per request). Every `/api/ops` route
 * except the health probe calls this before touching data.
 */
export function resolveOpsViewerForRequest(
  req: NextRequest
): { context: ViewerContext; response?: never } | { context?: never; response: NextResponse } {
  return resolveConciergeViewer(req);
}

/** Personal stays masked; public/confidential follow the role default. */
export function defaultTierAccess(role: ChronosAccessRole): OsKnowledgeTier[] {
  return conciergeDefaultTierAccess(role);
}

export function toSurfaceAuthorizationContext(viewer: ViewerContext): SurfaceAuthorizationContext {
  return {
    role: viewer.role,
    tenantSlugs: viewer.tenantSlugs,
    organizationIds: viewer.organizationIds ?? 'all',
    projectIds: viewer.projectIds ?? 'all',
    tierAccess: viewer.tierAccess ?? defaultTierAccess(viewer.role),
    principalId: viewer.principalId,
    source: viewer.source,
    ...(viewer.principal ? { principal: viewer.principal } : {}),
    ...(viewer.memberId ? { memberId: viewer.memberId } : {}),
  };
}

export function resolveViewerTierAccess(
  role: ChronosAccessRole,
  requested?: readonly OsKnowledgeTier[]
): OsKnowledgeTier[] {
  try {
    // A viewer without an explicit tier set receives the masked role default
    // (personal is never exposed here); only an explicit request for a tier
    // outside the masked policy is rejected.
    if (!requested) return defaultTierAccess(role);
    if (requested.includes('personal')) {
      throw new Error(`viewer tier access exceeds the ${role} role policy.`);
    }
    return resolveSurfaceViewerTierAccess(role, requested);
  } catch (error) {
    throw new ConciergeViewerError(
      error instanceof Error && 'status' in error && error.status === 401 ? 401 : 403,
      `Operations viewer tier access exceeds the ${role} role policy.`
    );
  }
}

/** Enforce the resolved viewer tier set for data-bearing routes. */
export function strictViewerTier(
  viewer: ViewerContext,
  requested: OsKnowledgeTier
): OsKnowledgeTier {
  try {
    return narrowSurfaceViewerTier(
      { role: viewer.role, tierAccess: viewer.tierAccess ?? defaultTierAccess(viewer.role) },
      requested
    );
  } catch (error) {
    throw new ConciergeViewerError(
      403,
      error instanceof Error ? error.message : 'viewer tier scope denied'
    );
  }
}

export function authorizeViewerTenant(
  viewer: ViewerContext,
  requestedTenant: string | null | undefined
): string | undefined {
  const requested = requestedTenant?.trim() || undefined;
  if (requested && !isValidTenantSlug(requested)) {
    throw new ConciergeViewerError(403, `invalid viewer tenant scope: ${requested}`);
  }
  if (!requested || viewer.tenantSlugs === 'all') return requested;
  if (viewer.tenantSlugs.includes(requested)) return requested;

  const mode = getRegisteredEnvText('KYBERION_VIEWER_SCOPE') || 'warn';
  const reason = `viewer tenant scope denied: ${requested}`;
  if (mode === 'warn') {
    try {
      auditChain.record({
        agentId: viewer.principalId || 'ops-viewer',
        action: 'viewer_scope',
        operation: 'tenant_read',
        result: 'denied',
        reason,
        metadata: { mode, tenant: requested, role: viewer.role },
      });
    } catch {
      // Observability must not turn warn-mode compatibility into a 500.
    }
  }
  // Warn mode is telemetry-only, never an authorization grant: a client can
  // never expand the viewer's server-side scope. Keep the audit, fail closed.
  throw new ConciergeViewerError(403, reason);
}

export function viewerScopeTenantSlugs(
  viewer: ViewerContext,
  requested?: string
): string[] | 'all' {
  const selected = authorizeViewerTenant(viewer, requested);
  if (selected) return [selected];
  return viewer.tenantSlugs;
}

/**
 * Use for data-bearing views. A browser-supplied tenant may narrow an already
 * authorized viewer, but it can never expand that viewer's tenant set.
 */
export function strictViewerScopeTenantSlugs(
  viewer: ViewerContext,
  requested?: string
): string[] | 'all' {
  try {
    return narrowSurfaceViewerTenant(viewer, requested);
  } catch (error) {
    throw new ConciergeViewerError(
      403,
      error instanceof Error ? error.message : 'viewer tenant scope denied'
    );
  }
}

function strictViewerScopeIds(
  kind: 'organization' | 'project',
  allowed: string[] | 'all',
  requested?: string
): string[] | 'all' {
  try {
    return narrowSurfaceViewerScope(
      {
        tenantSlugs: 'all',
        organizationIds: kind === 'organization' ? allowed : 'all',
        projectIds: kind === 'project' ? allowed : 'all',
      },
      kind === 'organization' ? { organizationId: requested } : { projectId: requested }
    )[kind === 'organization' ? 'organizationIds' : 'projectIds'];
  } catch (error) {
    throw new ConciergeViewerError(
      403,
      error instanceof Error ? error.message : `viewer ${kind} scope denied`
    );
  }
}

export function strictViewerScopeOrganizationIds(
  viewer: ViewerContext,
  requested?: string
): string[] | 'all' {
  return strictViewerScopeIds('organization', viewer.organizationIds ?? 'all', requested);
}

export function strictViewerScopeProjectIds(
  viewer: ViewerContext,
  requested?: string
): string[] | 'all' {
  return strictViewerScopeIds('project', viewer.projectIds ?? 'all', requested);
}

function viewerExecutionRole(viewer: ViewerContext): OpsExecutionRole {
  return viewer.role === 'localadmin' ? OPS_LOCALADMIN_EXECUTION_ROLE : OPS_OPERATOR_EXECUTION_ROLE;
}

function viewerExecutionTenant(viewer: ViewerContext): string | undefined {
  return viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
    ? viewer.tenantSlugs[0]
    : undefined;
}

/** Propagate the request-derived tenant into tier-guard identity resolution. */
export function withViewerExecutionContext<T>(viewer: ViewerContext, fn: () => T): T {
  return withExecutionContext(
    viewerExecutionRole(viewer),
    fn,
    undefined,
    viewerExecutionTenant(viewer)
  );
}

export async function withViewerExecutionContextAsync<T>(
  viewer: ViewerContext,
  fn: () => Promise<T> | T
): Promise<T> {
  return withExecutionContextAsync(
    viewerExecutionRole(viewer),
    fn,
    undefined,
    viewerExecutionTenant(viewer)
  );
}

export function viewerErrorResponse(error: unknown, statusOverride?: number): NextResponse {
  const status = statusOverride ?? (error instanceof ConciergeViewerError ? error.status : 403);
  const safe = toWireError(error);
  return NextResponse.json(
    {
      ok: false,
      error: safe.message,
      error_code: safe.code,
      correlation_id: safe.correlation_id,
    },
    { status }
  );
}
