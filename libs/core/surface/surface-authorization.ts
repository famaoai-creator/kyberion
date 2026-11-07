/**
 * Shared authorization boundary for HTTP, headless, and A2UI surfaces.
 *
 * Authentication resolves the principal in each surface adapter. This module
 * only evaluates the server-resolved role, permissions, and resource scope.
 * Client supplied scope values must be narrowed before they reach this API.
 */

import type { ResolvedPrincipal } from '../authn/authn-principal-resolver.js';
import { isValidTenantSlug } from '../foundation/scope.js';

export type SurfaceAuthorizationRole = 'readonly' | 'localadmin';
export type SurfaceAuthorizationEffect = 'read' | 'write';
export type SurfacePermission =
  | 'surface.headless.read'
  | 'surface.headless.write'
  /** FD-07: the "approver" human role's decision-only slice of surface.headless.write (front-desk-roles.ts). */
  | 'surface.decision.write';

export interface SurfaceAuthorizationContext {
  role: SurfaceAuthorizationRole;
  permissions?: readonly SurfacePermission[];
  tenantSlugs: readonly string[] | 'all';
  organizationIds: readonly string[] | 'all';
  projectIds: readonly string[] | 'all';
  tierAccess: readonly string[];
  principalId?: string;
  source?: 'token' | 'loopback' | 'anonymous';
  /** The authenticated principal this context was projected from, when the
   * authn seam resolved one — lets the authz policy engine reuse actor /
   * member claims instead of a synthesized principal. */
  principal?: ResolvedPrincipal;
  /** Member id declared by the matched token registration (FD-07). */
  memberId?: string;
  /**
   * Server-resolved only (e.g. the shell's system selection): readers also
   * admit records that carry no tenant. It never widens `tenantSlugs`; a
   * projection from a viewer scope must carry it, or untenanted records
   * silently drop out of every read made through this context.
   */
  includeUntenanted?: boolean;
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

/**
 * Custody kind of a disclosed record — the same system / tenant / person
 * vocabulary as asset derivation custody (P3). `person` records MUST name
 * their person: disclosure can never admit "somebody's" data anonymously.
 */
export type ViewerRecordCustody =
  | { kind: 'system' }
  | { kind: 'tenant'; ref: string }
  | { kind: 'person'; ref: string }
  | { kind: 'invalid' };

function validPersonId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.trim() === id && id !== '*';
}

/**
 * The server-resolved viewer scope fields custody admission reads. Readers
 * whose scope type is a projection filter (e.g. OperatorHomeScopeFilter)
 * carry the already-resolved person id set as `personIds` instead of the
 * principal fields.
 */
export type ViewerCustodyContext = Pick<
  SurfaceAuthorizationContext,
  'tenantSlugs' | 'includeUntenanted' | 'memberId' | 'principalId' | 'principal'
> & {
  /** Person ids resolved server-side upstream and carried by scope projections. */
  personIds?: readonly string[];
};

/**
 * The person identity set of a viewer, taken only from server-resolved
 * context fields (token-bound member id, authenticated principal) or an
 * upstream-resolved `personIds` projection. Person custody admission is
 * exact-match against this set — no id-space translation, fail-closed.
 */
export function viewerPersonIds(
  context: Pick<SurfaceAuthorizationContext, 'memberId' | 'principalId' | 'principal'> & {
    personIds?: readonly string[];
  }
): readonly string[] {
  const ids = [
    ...(Array.isArray(context.personIds) ? context.personIds : []),
    context.memberId,
    context.principal?.actor?.id,
    context.principalId,
  ];
  return [...new Set(ids.filter(validPersonId))];
}

/**
 * Row-level custody admission shared by every reader that takes a viewer
 * scope (P4 generalization of `admitsTenant`):
 * - `tenant`  — `'all'` admits; otherwise membership in `tenantSlugs`.
 * - `system`  — what "untenanted" always meant: `'all'` admits, otherwise
 *   only when the server-resolved scope sets `includeUntenanted`.
 * - `person`  — identity-bound, never scope-bound: admitted only when the
 *   custody ref is one of the viewer's own person ids. `'all'` does NOT
 *   admit another person's records.
 * It never widens the scope: callers still apply tier / organization /
 * project on top.
 */
export function admitsCustody(
  context: ViewerCustodyContext,
  custody: ViewerRecordCustody
): boolean {
  if (!custody || typeof custody !== 'object') return false;
  if (custody.kind === 'tenant') {
    if (typeof custody.ref !== 'string' || !isValidTenantSlug(custody.ref)) return false;
    return context.tenantSlugs === 'all' || context.tenantSlugs.includes(custody.ref);
  }
  if (custody.kind === 'system') {
    return context.tenantSlugs === 'all' || context.includeUntenanted === true;
  }
  return (
    custody.kind === 'person' &&
    validPersonId(custody.ref) &&
    viewerPersonIds(context).includes(custody.ref)
  );
}

/**
 * Derive the custody of a record scope: a tenant slug binds the record to
 * that tenant; absent a tenant, a person reference (`owner_nhi`) binds it to
 * that person; anything else is system custody. Records without a person
 * field keep their previous tenant/system behavior.
 */
export function custodyOfScope(
  scope: { tenant_slug?: unknown; owner_nhi?: unknown } | null | undefined
): ViewerRecordCustody {
  if (scope != null && (typeof scope !== 'object' || Array.isArray(scope)))
    return { kind: 'invalid' };
  // Preserve legacy null/empty tenant absence; declared malformed ownership
  // never becomes installation-owned data through a truthiness fallback.
  if (
    scope?.tenant_slug != null &&
    scope.tenant_slug !== '' &&
    (typeof scope.tenant_slug !== 'string' || !isValidTenantSlug(scope.tenant_slug))
  )
    return { kind: 'invalid' };
  if (scope?.owner_nhi != null && !validPersonId(scope.owner_nhi)) return { kind: 'invalid' };
  if (typeof scope?.tenant_slug === 'string' && scope.tenant_slug)
    return { kind: 'tenant', ref: scope.tenant_slug };
  if (validPersonId(scope?.owner_nhi)) return { kind: 'person', ref: scope.owner_nhi };
  return { kind: 'system' };
}

/**
 * Custody admission plus the record's own explicit share list. A
 * person-custody record may carry `allowed_audience` — a brokered
 * disclosure grant written by its owner: audience members are admitted by
 * identity (exact match against the viewer's person ids), never by scope.
 * For tenant/system custody the audience list grants nothing.
 */
export function admitsScopeAudience(
  context: ViewerCustodyContext,
  scope:
    | {
        tenant_slug?: string | null;
        owner_nhi?: string | null;
        allowed_audience?: readonly string[] | null;
      }
    | null
    | undefined
): boolean {
  if (
    scope?.allowed_audience != null &&
    (!Array.isArray(scope.allowed_audience) || !scope.allowed_audience.every(validPersonId))
  )
    return false;
  const custody = custodyOfScope(scope);
  if (admitsCustody(context, custody)) return true;
  if (custody.kind !== 'person') return false;
  const ids = viewerPersonIds(context);
  return (scope?.allowed_audience ?? []).some((id) => ids.includes(id));
}

/**
 * Row-level tenant admission shared by every reader that takes a viewer scope.
 * `'all'` admits every record; a record with no tenant is admitted only when
 * the server-resolved scope sets `includeUntenanted` (the shell's system
 * selection); any other record only when its tenant is in `tenantSlugs`.
 * It never widens the scope: callers still apply tier / organization / project.
 */
export function admitsTenant(
  context: Pick<SurfaceAuthorizationContext, 'tenantSlugs' | 'includeUntenanted'>,
  tenantSlug: string | null | undefined
): boolean {
  return admitsCustody(
    context,
    tenantSlug ? { kind: 'tenant', ref: tenantSlug } : { kind: 'system' }
  );
}

export function permissionsForSurfaceRole(
  role: SurfaceAuthorizationRole
): readonly SurfacePermission[] {
  return ROLE_PERMISSIONS[role];
}

/**
 * FD-07: when a caller passes an explicit `context.permissions`, it REPLACES
 * (never unions with) the role-derived default set. This is what lets the
 * `approver` human role share the `localadmin` server role (for the
 * `requiredRole` gate below) while still being denied
 * `surface.headless.write` — without it, an approver's default `localadmin`
 * permissions would always include full write, no matter what
 * `front-desk-roles.ts` declares. No caller set `context.permissions` before
 * FD-07, so this is behaviorally additive for every existing caller.
 */
function resolveSurfacePermissions(
  context: SurfaceAuthorizationContext
): ReadonlySet<SurfacePermission> {
  return new Set(context.permissions ?? permissionsForSurfaceRole(context.role));
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

  const permissions = resolveSurfacePermissions(context);
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
