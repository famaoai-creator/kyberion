import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { auditChain } from '@agent/core/audit-chain';
import { isValidTenantSlug, pathResolver, safeExistsSync } from '@agent/core';
import { withExecutionContext, withExecutionContextAsync } from '@agent/core/authority';
import { secretGuard } from '@agent/core/secret-guard';
import {
  isChronosLoopbackRequest,
  matchesChronosToken,
  resolveChronosAccessRole,
  resolveChronosToken,
  resolveChronosTokenRegistration,
  type ChronosAccessRole,
  type ChronosTokenRegistration,
} from './api-guard';
import type { OsKnowledgeTier } from '@agent/core';

const SCOPE_ID_PATTERN = /^[^\s/]+$/u;

export interface ViewerContext {
  role: ChronosAccessRole;
  tenantSlugs: string[] | 'all';
  /** Optional for compatibility with pre-organization token fixtures. */
  organizationIds?: string[] | 'all';
  projectIds?: string[] | 'all';
  tierAccess?: OsKnowledgeTier[];
  source: 'token' | 'loopback' | 'anonymous';
  principalId?: string;
}

const CHRONOS_ROLE_TIER_ACCESS: Record<ChronosAccessRole, readonly OsKnowledgeTier[]> = {
  readonly: ['public', 'confidential'],
  localadmin: ['public', 'confidential'],
};

export class ViewerContextError extends Error {
  constructor(
    public readonly status: 401 | 403,
    message: string
  ) {
    super(message);
    this.name = 'ViewerContextError';
  }
}

function registryPath(): string {
  return pathResolver.knowledge('personal/connections/chronos-access.json');
}

function loadRegistry(): ChronosTokenRegistration[] | null {
  if (!safeExistsSync(registryPath())) return null;
  try {
    const document = secretGuard.loadConnectionDocument('chronos-access');
    if (!document || !Array.isArray(document.tokens)) {
      throw new Error('chronos access registry must contain tokens');
    }
    return document.tokens.map((entry: unknown) => {
      if (!entry || typeof entry !== 'object') throw new Error('invalid chronos access entry');
      const value = entry as Record<string, unknown>;
      if (
        typeof value.token_hash !== 'string' ||
        (value.role !== 'readonly' && value.role !== 'localadmin') ||
        !Array.isArray(value.tenant_slugs) ||
        !value.tenant_slugs.every(
          (tenant) => typeof tenant === 'string' && isValidTenantSlug(tenant)
        ) ||
        (value.organization_ids !== undefined &&
          (!Array.isArray(value.organization_ids) ||
            !value.organization_ids.every(
              (organization) =>
                typeof organization === 'string' && SCOPE_ID_PATTERN.test(organization)
            ))) ||
        (value.project_ids !== undefined &&
          (!Array.isArray(value.project_ids) ||
            !value.project_ids.every(
              (project) => typeof project === 'string' && SCOPE_ID_PATTERN.test(project)
            ))) ||
        (value.tier_access !== undefined &&
          (!Array.isArray(value.tier_access) ||
            value.tier_access.length === 0 ||
            !value.tier_access.every(
              (tier) => tier === 'public' || tier === 'confidential' || tier === 'personal'
            )))
      ) {
        throw new Error('invalid chronos access entry');
      }
      return {
        token_hash: value.token_hash,
        role: value.role,
        tenant_slugs: value.tenant_slugs.map((tenant) => String(tenant).trim()),
        ...(Array.isArray(value.organization_ids)
          ? {
              organization_ids: value.organization_ids.map((organization) =>
                String(organization).trim()
              ),
            }
          : {}),
        ...(Array.isArray(value.project_ids)
          ? { project_ids: value.project_ids.map((project) => String(project).trim()) }
          : {}),
        ...(Array.isArray(value.tier_access)
          ? {
              tier_access: value.tier_access.filter(
                (tier): tier is OsKnowledgeTier =>
                  tier === 'public' || tier === 'confidential' || tier === 'personal'
              ),
            }
          : {}),
        ...(typeof value.label === 'string' ? { label: value.label } : {}),
      } as ChronosTokenRegistration;
    });
  } catch {
    throw new ViewerContextError(401, 'Chronos viewer token registry is unavailable.');
  }
}

function resolveRegisteredEntry(token: string): ChronosTokenRegistration | null {
  const registry = loadRegistry();
  if (!registry) return resolveChronosTokenRegistration(token);
  const digest = createHash('sha256').update(token).digest('hex');
  return registry.find((entry) => matchesChronosToken(digest, entry.token_hash)) || null;
}

export function resolveViewerContext(req: NextRequest): ViewerContext {
  const token = resolveChronosToken(req);
  if (token) {
    const registration = resolveRegisteredEntry(token);
    if (registration) {
      return {
        role: registration.role,
        tenantSlugs: registration.tenant_slugs,
        organizationIds: registration.organization_ids ?? 'all',
        projectIds: registration.project_ids ?? 'all',
        tierAccess: resolveViewerTierAccess(registration.role, registration.tier_access),
        source: 'token',
        principalId: registration.label,
      };
    }
    const role = resolveChronosAccessRole(req);
    if (role) {
      return {
        role,
        tenantSlugs: 'all',
        organizationIds: 'all',
        projectIds: 'all',
        tierAccess: defaultTierAccess(role),
        source: 'token',
      };
    }
    throw new ViewerContextError(401, 'Unknown Chronos viewer token.');
  }

  const role = resolveChronosAccessRole(req);
  if (role && isChronosLoopbackRequest(req)) {
    return {
      role,
      tenantSlugs: 'all',
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: defaultTierAccess(role),
      source: 'loopback',
    };
  }
  throw new ViewerContextError(401, 'A Chronos viewer principal is required.');
}

/** Chronos roles currently expose public/confidential; personal remains masked. */
export function defaultTierAccess(role: ChronosAccessRole): OsKnowledgeTier[] {
  return [...CHRONOS_ROLE_TIER_ACCESS[role]];
}

export function resolveViewerTierAccess(
  role: ChronosAccessRole,
  requested?: readonly OsKnowledgeTier[]
): OsKnowledgeTier[] {
  const roleAccess = CHRONOS_ROLE_TIER_ACCESS[role];
  if (!requested) return [...roleAccess];
  const normalized = [...new Set(requested)];
  if (normalized.length === 0 || normalized.some((tier) => !roleAccess.includes(tier))) {
    throw new ViewerContextError(
      403,
      `Chronos viewer tier access exceeds the ${role} role policy.`
    );
  }
  return normalized;
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

  const mode = process.env.KYBERION_VIEWER_SCOPE || 'warn';
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
  return requested;
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
  const normalized = requested?.trim() || undefined;
  if (normalized && !isValidTenantSlug(normalized)) {
    throw new ViewerContextError(403, `invalid viewer tenant scope: ${normalized}`);
  }
  if (normalized && viewer.tenantSlugs !== 'all' && !viewer.tenantSlugs.includes(normalized)) {
    throw new ViewerContextError(403, `viewer tenant scope denied: ${normalized}`);
  }
  if (normalized) return [normalized];
  return viewer.tenantSlugs;
}

function strictViewerScopeIds(
  kind: 'organization' | 'project',
  allowed: string[] | 'all',
  requested?: string
): string[] | 'all' {
  const normalized = requested?.trim() || undefined;
  if (normalized && !SCOPE_ID_PATTERN.test(normalized)) {
    throw new ViewerContextError(403, `invalid viewer ${kind} scope: ${normalized}`);
  }
  if (normalized && allowed !== 'all' && !allowed.includes(normalized)) {
    throw new ViewerContextError(403, `viewer ${kind} scope denied: ${normalized}`);
  }
  if (normalized) return [normalized];
  return allowed;
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

export function viewerErrorResponse(error: unknown): NextResponse {
  const status = error instanceof ViewerContextError ? error.status : 403;
  return NextResponse.json(
    { ok: false, error: error instanceof Error ? error.message : 'Forbidden' },
    { status }
  );
}
