/**
 * Viewer helpers for the operations console routes (`/api/ops/*`, formerly the
 * Chronos API). There is one viewer model: every helper here works on the
 * Concierge viewer context resolved by `resolveConciergeViewer` (credential,
 * registry, loopback attestation and server tenant are all resolved
 * server-side). These helpers only narrow that viewer — a request-supplied
 * tenant / organization / project / tier can select inside the allowed set,
 * never widen it.
 *
 * `../viewer-context` owns the viewer → authorization-context projection, the
 * tier resolution and the error response; the names exported here delegate to
 * it so the console's call sites keep their imports.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { auditChain } from '@agent/core/governance/audit-chain';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import {
  narrowSurfaceViewerScope,
  narrowSurfaceViewerTenant,
  narrowSurfaceViewerTier,
} from '@agent/core/surface/surface-mutation-guard';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { getRegisteredEnvText } from '@agent/core/foundation';
import type { OsKnowledgeTier } from '@agent/core/cloudflare-os-control-plane';
import {
  authorizeSurfaceOperation,
  type SurfaceAuthorizationContext,
} from '@agent/core/surface/surface-authorization';
import {
  ConciergeViewerError,
  conciergeErrorResponse,
  defaultTierAccess,
  maskPersonalTier,
  resolveConciergeViewer,
  resolveTierAccess,
  toSurfaceAuthorizationContext as toConciergeAuthorizationContext,
  viewerErrorStatus,
  type ConciergeViewerContext,
} from '../viewer-context';
import { VIEWER_EXECUTION_ROLES, opsExecutionRole } from '../viewer-execution-role';

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

/**
 * Execution roles of the operations console reads (security-policy grants).
 * Declared next to the Concierge pair in `../viewer-execution-role`.
 */
export const OPS_LOCALADMIN_EXECUTION_ROLE = VIEWER_EXECUTION_ROLES.ops.localadmin;
export const OPS_OPERATOR_EXECUTION_ROLE = VIEWER_EXECUTION_ROLES.ops.readonly;

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
export { defaultTierAccess };

/**
 * The one place the console's optional scope lists get their value: an
 * omitted organization / project list means unrestricted within the tenant
 * set, an omitted tier list means the (personal-masked) role default. The
 * helpers in this module, the candidate visibility rules and
 * `distill-candidate-scope` read those fields through here. Not yet moved:
 * `workspace-scope.ts`, `headless-projections.ts` and
 * `api/ops/intelligence/actions.ts` state their own fallback, each with a
 * different tier default.
 */
export function withOpsViewerDefaults(viewer: ViewerContext): ConciergeViewerContext {
  return {
    ...viewer,
    organizationIds: viewer.organizationIds ?? 'all',
    projectIds: viewer.projectIds ?? 'all',
    tierAccess: viewer.tierAccess ?? defaultTierAccess(viewer.role),
  };
}

/** The Concierge projection (personal tier masked, no scope field dropped). */
export function toSurfaceAuthorizationContext(viewer: ViewerContext): SurfaceAuthorizationContext {
  return toConciergeAuthorizationContext(withOpsViewerDefaults(viewer));
}

/** Tier and effective read permissions are independent of row custody admission. */
export function viewerCanReadTier(viewer: ViewerContext, tier: unknown): boolean {
  if (tier !== 'public' && tier !== 'confidential' && tier !== 'personal') return false;
  return authorizeSurfaceOperation({
    context: toSurfaceAuthorizationContext(viewer),
    operation: {
      operationId: 'ops.reader.read',
      effect: 'read',
      requiredPermissions: ['surface.headless.read'],
    },
    resource: { tier },
  }).allowed;
}

/** A registration may narrow the role's tiers, never widen them or reach `personal`. */
export { resolveTierAccess as resolveViewerTierAccess };

/** Enforce the resolved viewer tier set for data-bearing routes. */
export function strictViewerTier(
  viewer: ViewerContext,
  requested: OsKnowledgeTier
): OsKnowledgeTier {
  try {
    return narrowSurfaceViewerTier(
      { role: viewer.role, tierAccess: maskPersonalTier(withOpsViewerDefaults(viewer).tierAccess) },
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
  return strictViewerScopeIds(
    'organization',
    withOpsViewerDefaults(viewer).organizationIds,
    requested
  );
}

export function strictViewerScopeProjectIds(
  viewer: ViewerContext,
  requested?: string
): string[] | 'all' {
  return strictViewerScopeIds('project', withOpsViewerDefaults(viewer).projectIds, requested);
}

function viewerExecutionTenant(viewer: ViewerContext): string | undefined {
  return viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
    ? viewer.tenantSlugs[0]
    : undefined;
}

/** Propagate the request-derived tenant into tier-guard identity resolution. */
export function withViewerExecutionContext<T>(viewer: ViewerContext, fn: () => T): T {
  return withExecutionContext(
    opsExecutionRole(viewer.role),
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
    opsExecutionRole(viewer.role),
    fn,
    undefined,
    viewerExecutionTenant(viewer)
  );
}

/**
 * The Concierge error response with the console's two differences: an error
 * that carries no authorization status answers 403 here (500 on other
 * Concierge routes), and the wire code is classified from the error object
 * itself, not from the response status — both as the console always did.
 */
export function viewerErrorResponse(error: unknown, statusOverride?: number): NextResponse {
  return conciergeErrorResponse(
    error,
    statusOverride ?? viewerErrorStatus(error) ?? 403,
    'error-object'
  );
}
