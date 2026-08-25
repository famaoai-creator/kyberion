/**
 * Shared authorization boundary for HTTP, headless, and A2UI surfaces.
 *
 * Authentication resolves the principal in each surface adapter. This module
 * only evaluates the server-resolved role, permissions, and resource scope.
 * Client supplied scope values must be narrowed before they reach this API.
 */

export type SurfaceAuthorizationRole = 'readonly' | 'localadmin';
export type SurfaceAuthorizationEffect = 'read' | 'write';
export type SurfacePermission = 'surface.headless.read' | 'surface.headless.write';

export interface SurfaceAuthorizationContext {
  role: SurfaceAuthorizationRole;
  permissions?: readonly SurfacePermission[];
  tenantSlugs: readonly string[] | 'all';
  organizationIds: readonly string[] | 'all';
  projectIds: readonly string[] | 'all';
  tierAccess: readonly string[];
  principalId?: string;
  source?: 'token' | 'loopback' | 'anonymous';
}

export interface SurfaceAuthorizationResource {
  tenantSlug?: string;
  organizationId?: string;
  projectId?: string;
  tier?: string;
}

export interface SurfaceOperationPolicy {
  operationId: string;
  effect: SurfaceAuthorizationEffect;
  requiredRole?: SurfaceAuthorizationRole;
  requiredPermissions: readonly SurfacePermission[];
}

export type SurfaceAuthorizationReasonCode =
  | 'allowed'
  | 'policy_missing'
  | 'role_denied'
  | 'permission_denied'
  | 'tenant_scope_denied'
  | 'organization_scope_denied'
  | 'project_scope_denied'
  | 'tier_scope_denied';

export interface SurfaceAuthorizationDecision {
  allowed: boolean;
  operationId: string;
  reasonCode: SurfaceAuthorizationReasonCode;
  reason: string;
  policyId: string;
}

export class SurfaceAuthorizationError extends Error {
  readonly status = 403 as const;

  constructor(
    public readonly decision: SurfaceAuthorizationDecision,
    message = decision.reason
  ) {
    super(message);
    this.name = 'SurfaceAuthorizationError';
  }
}

const ROLE_PERMISSIONS: Record<SurfaceAuthorizationRole, readonly SurfacePermission[]> = {
  readonly: ['surface.headless.read'],
  localadmin: ['surface.headless.read', 'surface.headless.write'],
};

function scopeContains(allowed: readonly string[] | 'all', requested: string | undefined): boolean {
  return !requested || allowed === 'all' || allowed.includes(requested);
}

function denied(
  operation: SurfaceOperationPolicy,
  reasonCode: Exclude<SurfaceAuthorizationReasonCode, 'allowed'>,
  reason: string
): SurfaceAuthorizationDecision {
  return {
    allowed: false,
    operationId: operation.operationId,
    reasonCode,
    reason,
    policyId: `surface:${operation.operationId}`,
  };
}

export function permissionsForSurfaceRole(
  role: SurfaceAuthorizationRole
): readonly SurfacePermission[] {
  return ROLE_PERMISSIONS[role];
}

export function authorizeSurfaceOperation(input: {
  context: SurfaceAuthorizationContext;
  operation: SurfaceOperationPolicy;
  resource?: SurfaceAuthorizationResource;
}): SurfaceAuthorizationDecision {
  const { context, operation, resource } = input;
  if (!operation.requiredPermissions.length) {
    return denied(
      operation,
      'policy_missing',
      `operation ${operation.operationId} has no required permission policy`
    );
  }

  const effectPermission: SurfacePermission =
    operation.effect === 'read' ? 'surface.headless.read' : 'surface.headless.write';
  if (!operation.requiredPermissions.includes(effectPermission)) {
    return denied(
      operation,
      'policy_missing',
      `operation ${operation.operationId} does not declare the permission for its ${operation.effect} effect`
    );
  }

  if (operation.requiredRole === 'localadmin' && context.role !== 'localadmin') {
    return denied(
      operation,
      'role_denied',
      `role ${context.role} cannot perform ${operation.operationId}`
    );
  }

  const permissions = new Set<SurfacePermission>([
    ...permissionsForSurfaceRole(context.role),
    ...(context.permissions || []),
  ]);
  const missingPermission = operation.requiredPermissions.find(
    (permission) => !permissions.has(permission)
  );
  if (missingPermission) {
    return denied(
      operation,
      'permission_denied',
      `permission ${missingPermission} is required for ${operation.operationId}`
    );
  }

  if (!scopeContains(context.tenantSlugs, resource?.tenantSlug)) {
    return denied(
      operation,
      'tenant_scope_denied',
      `tenant scope denied for ${operation.operationId}`
    );
  }
  if (!scopeContains(context.organizationIds, resource?.organizationId)) {
    return denied(
      operation,
      'organization_scope_denied',
      `organization scope denied for ${operation.operationId}`
    );
  }
  if (!scopeContains(context.projectIds, resource?.projectId)) {
    return denied(
      operation,
      'project_scope_denied',
      `project scope denied for ${operation.operationId}`
    );
  }
  if (resource?.tier && !context.tierAccess.includes(resource.tier)) {
    return denied(operation, 'tier_scope_denied', `tier scope denied for ${operation.operationId}`);
  }

  return {
    allowed: true,
    operationId: operation.operationId,
    reasonCode: 'allowed',
    reason: 'authorized',
    policyId: `surface:${operation.operationId}`,
  };
}

export function assertSurfaceOperation(input: {
  context: SurfaceAuthorizationContext;
  operation: SurfaceOperationPolicy;
  resource?: SurfaceAuthorizationResource;
}): SurfaceAuthorizationDecision {
  const decision = authorizeSurfaceOperation(input);
  if (!decision.allowed) throw new SurfaceAuthorizationError(decision);
  return decision;
}
