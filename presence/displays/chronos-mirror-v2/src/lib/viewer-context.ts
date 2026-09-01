import { NextResponse, type NextRequest } from 'next/server';
import { auditChain } from '@agent/core/audit-chain';
import { isValidTenantSlug } from '@agent/core/entity-scope';
import {
  readChronosTokenRegistrations,
  type ChronosTokenRegistration,
} from '@agent/core/chronos-access-registry';
import {
  defaultSurfaceViewerTierAccess,
  narrowSurfaceViewerTier,
  narrowSurfaceViewerScope,
  narrowSurfaceViewerTenant,
  resolveSurfaceViewerScope,
  SurfaceViewerScopeError,
  resolveSurfaceViewerTierAccess,
  type SurfaceViewerScope,
} from '@agent/core/surface-mutation-guard';
import { toWireError } from '@agent/core/wire-error';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { getRegisteredEnvBool, getRegisteredEnvText } from '@agent/core/foundation';
import {
  isChronosLoopbackRequest,
  resolveChronosAccessRole,
  resolveChronosToken,
  type ChronosAccessRole,
} from './api-guard';
import type { OsKnowledgeTier } from '@agent/core/cloudflare-os-control-plane';
import type { SurfaceAuthorizationContext } from '@agent/core/surface-authorization';

export interface ViewerContext extends Omit<
  SurfaceViewerScope,
  'organizationIds' | 'projectIds' | 'tierAccess'
> {
  /** Optional for compatibility with pre-organization token fixtures. */
  organizationIds?: string[] | 'all';
  projectIds?: string[] | 'all';
  tierAccess?: OsKnowledgeTier[];
}

export class ViewerContextError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'ViewerContextError';
  }
}

function loadRegistry(): ChronosTokenRegistration[] | null {
  try {
    return readChronosTokenRegistrations();
  } catch {
    throw new ViewerContextError(401, 'Chronos viewer token registry is unavailable.');
  }
}

function resolveServerTenant(): string {
  return (getRegisteredEnvText('KYBERION_TENANT') || '').trim();
}

export function resolveViewerContext(req: NextRequest): ViewerContext {
  const token = resolveChronosToken(req);
  const local = isChronosLoopbackRequest(req);
  const loopbackRole = token ? undefined : resolveChronosAccessRole(req) || undefined;
  try {
    return resolveSurfaceViewerScope({
      token,
      local,
      serverTenant: resolveServerTenant(),
      registrations: token ? loadRegistry() : null,
      apiToken: getRegisteredEnvText('KYBERION_API_TOKEN'),
      localadminToken: getRegisteredEnvText('KYBERION_LOCALADMIN_TOKEN'),
      allowLoopback: Boolean(loopbackRole),
      loopbackRole,
      // Chronos preserves its existing all-tenant loopback compatibility
      // boundary; remote credentials still require server tenant binding.
      allowPersonalTier: false,
    });
  } catch (error) {
    if (!(error instanceof SurfaceViewerScopeError)) throw error;
    let message = error.message;
    if (message === 'Unknown viewer token.') message = 'Unknown Chronos viewer token.';
    if (message.includes('Remote viewer access requires')) {
      message = 'Remote Chronos access requires server-side KYBERION_TENANT scope.';
    }
    if (message === 'A viewer principal is required.') {
      message = 'A Chronos viewer principal is required.';
    }
    if (message.includes('viewer tier scope exceeds')) {
      message = `Chronos viewer tier access exceeds the ${loopbackRole || 'viewer'} role policy.`;
    }
    throw new ViewerContextError(error.status, message);
  }
}

/** Chronos roles currently expose public/confidential; personal remains masked. */
export function defaultTierAccess(role: ChronosAccessRole): OsKnowledgeTier[] {
  return defaultSurfaceViewerTierAccess(role).filter((tier) => tier !== 'personal');
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
  };
}

export function resolveViewerTierAccess(
  role: ChronosAccessRole,
  requested?: readonly OsKnowledgeTier[]
): OsKnowledgeTier[] {
  try {
    // Registrations that omit `tier_access` receive the masked role default
    // (personal is never exposed through Chronos); only an explicit request
    // for a tier outside the masked policy is rejected.
    if (!requested) return defaultTierAccess(role);
    if (requested.includes('personal')) {
      throw new Error(`Chronos viewer tier access exceeds the ${role} role policy.`);
    }
    return resolveSurfaceViewerTierAccess(role, requested);
  } catch (error) {
    throw new ViewerContextError(
      error instanceof Error && 'status' in error && error.status === 401 ? 401 : 403,
      `Chronos viewer tier access exceeds the ${role} role policy.`
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
      {
        role: viewer.role,
        tierAccess: viewer.tierAccess ?? defaultTierAccess(viewer.role),
      },
      requested
    );
  } catch (error) {
    throw new ViewerContextError(
      403,
      error instanceof Error ? error.message : 'viewer tier scope denied'
    );
  }
}

export function resolveViewerContextForRequest(
  req: NextRequest
): { context: ViewerContext; response?: never } | { context?: never; response: NextResponse } {
  try {
    return { context: resolveViewerContext(req) };
  } catch (error) {
    const status = error instanceof ViewerContextError ? error.status : 401;
    return {
      response: NextResponse.json(
        { ok: false, error: error instanceof Error ? error.message : 'Unauthorized' },
        { status }
      ),
    };
  }
}

export function authorizeViewerTenant(
  viewer: ViewerContext,
  requestedTenant: string | null | undefined
): string | undefined {
  const requested = requestedTenant?.trim() || undefined;
  if (requested && !isValidTenantSlug(requested)) {
    throw new ViewerContextError(403, `invalid viewer tenant scope: ${requested}`);
  }
  if (!requested || viewer.tenantSlugs === 'all') return requested;
  if (viewer.tenantSlugs.includes(requested)) return requested;

  const mode = getRegisteredEnvText('KYBERION_VIEWER_SCOPE') || 'warn';
  const reason = `viewer tenant scope denied: ${requested}`;
  if (mode === 'enforce') throw new ViewerContextError(403, reason);
  if (mode === 'warn') {
    try {
      auditChain.record({
        agentId: viewer.principalId || 'chronos-viewer',
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
  // Warn mode is telemetry-only, never an authorization grant. Returning the
  // requested tenant here would let a client expand a token's server-side
  // scope during the migration window. Keep the audit, then fail closed.
  throw new ViewerContextError(403, reason);
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
 * Use for data-bearing Chronos views. A browser-supplied tenant may narrow an
 * already authorized viewer, but it can never expand that viewer's tenant set.
 */
export function strictViewerScopeTenantSlugs(
  viewer: ViewerContext,
  requested?: string
): string[] | 'all' {
  try {
    return narrowSurfaceViewerTenant(viewer, requested);
  } catch (error) {
    throw new ViewerContextError(
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
    throw new ViewerContextError(
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

/** Propagate the request-derived tenant into tier-guard identity resolution. */
export function withViewerExecutionContext<T>(viewer: ViewerContext, fn: () => T): T {
  const role = viewer.role === 'localadmin' ? 'chronos_localadmin' : 'chronos_operator';
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  return withExecutionContext(role, fn, undefined, tenant);
}

export async function withViewerExecutionContextAsync<T>(
  viewer: ViewerContext,
  fn: () => Promise<T> | T
): Promise<T> {
  const role = viewer.role === 'localadmin' ? 'chronos_localadmin' : 'chronos_operator';
  const tenant =
    viewer.tenantSlugs !== 'all' && viewer.tenantSlugs.length === 1
      ? viewer.tenantSlugs[0]
      : undefined;
  return withExecutionContextAsync(role, fn, undefined, tenant);
}

export function viewerErrorResponse(error: unknown, statusOverride?: number): NextResponse {
  const status = statusOverride ?? (error instanceof ViewerContextError ? error.status : 403);
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
