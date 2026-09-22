/**
 * Built-in providers for the `authz-policy-engine` seam.
 *
 * Importing this module self-registers every provider (the index barrel
 * pulls it in). Providers never throw on the evaluation path — an
 * unevaluable query is declared ineligible in `canAuthorize`, and any
 * residual failure is returned as a deny decision (fail closed).
 *
 *   role-scope        — the current server-role + scope-containment model:
 *                       delegates to authorizeSurfaceOperation with the
 *                       principal's own claims (the pre-seam behavior)
 *   member-membership — member-registry memberships → front-desk human
 *                       roles (owner/approver/viewer) → explicit
 *                       permission sets; the only provider that can grant
 *                       the `decide` effect (surface.decision.write)
 *   policy-file       — declarative JSON rules (deny rules win over allow,
 *                       no match → deny), governed or operator-supplied
 *   allow-all         — permits everything (test purpose only)
 *   deny-all          — denies everything (lockdown / fail-closed probes)
 */

import type { ActorKind } from './actor.js';
import type { OsKnowledgeTier } from './cloudflare-os-control-plane.js';
import { getRegisteredEnvText, isVitestProcess } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { readTextFile } from './foundation/text.js';
import { frontDeskRoleAuthority } from './front-desk-roles.js';
import {
  readMemberProfile,
  resolveAccountableHuman,
  type MemberProfile,
} from './member-registry.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import {
  authorizeSurfaceOperation,
  type SurfaceAuthorizationContext,
  type SurfaceAuthorizationRole,
  type SurfacePermission,
  type SurfaceOperationPolicy,
} from './surface-authorization.js';
import type { ResolvedPrincipal } from './authn-principal-resolver.js';
import {
  registerAuthzProvider,
  type AuthzDecision,
  type AuthzProvider,
  type AuthzQuery,
  type AuthzReasonCode,
  type AuthzResolveDeps,
} from './authz-policy-engine.js';

const ALL_KINDS: ActorKind[] = ['human', 'agent', 'service'];

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function decision(
  query: AuthzQuery,
  provider: string,
  allowed: boolean,
  reasonCode: AuthzReasonCode,
  reason: string,
  policyId?: string
): AuthzDecision {
  return {
    allowed,
    operationId: query.operation.operationId,
    reasonCode,
    reason,
    policyId: policyId ?? `${provider}:${query.operation.operationId}`,
    provider,
  };
}

const EFFECT_PERMISSIONS: Record<string, SurfacePermission> = {
  read: 'surface.headless.read',
  write: 'surface.headless.write',
  decide: 'surface.decision.write',
};

function requiredPermissions(query: AuthzQuery): readonly SurfacePermission[] {
  return query.operation.requiredPermissions ?? [EFFECT_PERMISSIONS[query.operation.effect]];
}

function scopeAllows(allowed: readonly string[] | 'all', requested: string | undefined): boolean {
  return !requested || allowed === 'all' || allowed.includes(requested);
}

function envText(deps: AuthzResolveDeps | undefined, name: string): string | undefined {
  return getRegisteredEnvText(name, deps?.env ? { env: deps.env } : undefined);
}

function principalToSurfaceContext(
  principal: ResolvedPrincipal,
  overrides?: Partial<SurfaceAuthorizationContext>
): SurfaceAuthorizationContext {
  return {
    role: principal.role,
    tenantSlugs: principal.tenantSlugs,
    organizationIds: principal.organizationIds,
    projectIds: principal.projectIds,
    tierAccess: principal.tierAccess,
    principalId: principal.principalId,
    source:
      principal.source === 'agent' || principal.source === 'oidc' ? 'token' : principal.source,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// role-scope — the current model (surface-authorization.ts)
// ---------------------------------------------------------------------------

const roleScopeProvider: AuthzProvider = {
  id: 'role-scope',
  capabilities: {
    principalKinds: ALL_KINDS,
    effects: ['read', 'write'],
    tenantAware: true,
    memberAware: false,
    requiresConfig: false,
  },
  canAuthorize(query) {
    if (query.operation.effect === 'decide') {
      // `decide` needs a permission the role defaults never grant — it is the
      // member-membership provider's job.
      return { eligible: false, unmet: ['decide effect requires a member-aware provider'] };
    }
    return { eligible: true };
  },
  authorize(query) {
    const operation: SurfaceOperationPolicy = {
      operationId: query.operation.operationId,
      effect: query.operation.effect === 'decide' ? 'write' : query.operation.effect,
      requiredPermissions: requiredPermissions(query),
      ...(query.operation.requiredRole ? { requiredRole: query.operation.requiredRole } : {}),
    };
    const result = authorizeSurfaceOperation({
      context: principalToSurfaceContext(
        query.principal,
        query.permissions ? { permissions: query.permissions } : undefined
      ),
      operation,
      resource: query.resource,
    });
    return decision(
      query,
      'role-scope',
      result.allowed,
      result.reasonCode,
      result.reason,
      result.policyId
    );
  },
};

// ---------------------------------------------------------------------------
// member-membership — member-registry → front-desk role → explicit permissions
// ---------------------------------------------------------------------------

function resolveMember(
  principal: ResolvedPrincipal,
  deps?: AuthzResolveDeps
): MemberProfile | null {
  const options = deps?.memberRegistry ?? {};
  try {
    if (principal.memberId) return readMemberProfile(principal.memberId, options);
    if (principal.actor.kind === 'human')
      return resolveAccountableHuman(principal.actor.id, options);
  } catch {
    return null;
  }
  return null;
}

const memberMembershipProvider: AuthzProvider = {
  id: 'member-membership',
  capabilities: {
    principalKinds: ['human'],
    effects: ['read', 'write', 'decide'],
    tenantAware: true,
    memberAware: true,
    requiresConfig: false,
  },
  canAuthorize(query) {
    if (query.principal.actor.kind !== 'human') {
      return { eligible: false, unmet: ['principal is not a human member'] };
    }
    return { eligible: true };
  },
  authorize(query, deps) {
    const member = resolveMember(query.principal, deps);
    if (!member) {
      return decision(
        query,
        'member-membership',
        false,
        'member_not_found',
        `principal '${query.principal.principalId}' does not resolve to a member`
      );
    }
    if (member.status !== 'active') {
      return decision(
        query,
        'member-membership',
        false,
        'member_inactive',
        `member '${member.member_id}' is ${member.status}`
      );
    }

    const tenant = query.resource?.tenantSlug;
    const matching = tenant
      ? member.memberships.filter((membership) => membership.tenant_slug === tenant)
      : member.memberships;
    if (tenant && matching.length === 0) {
      return decision(
        query,
        'member-membership',
        false,
        'tenant_scope_denied',
        `member '${member.member_id}' holds no membership for tenant '${tenant}'`
      );
    }
    if (matching.length === 0) {
      return decision(
        query,
        'member-membership',
        false,
        'member_not_found',
        `member '${member.member_id}' holds no memberships`
      );
    }

    // Union the permission sets of the matching memberships; the server role
    // follows the strongest one (requiredRole gate compatibility).
    const permissions = new Set<SurfacePermission>();
    let serverRole: SurfaceAuthorizationRole = 'readonly';
    const memberTenants: string[] = [];
    for (const membership of matching) {
      const authority = frontDeskRoleAuthority(membership.role);
      for (const permission of authority.permissions) permissions.add(permission);
      if (authority.serverRole === 'localadmin') serverRole = 'localadmin';
      memberTenants.push(membership.tenant_slug);
    }

    // Match role-scope semantics: the operation must declare the canonical
    // permission for its effect — otherwise a caller could downgrade a
    // `decide` operation to a read-level permission set.
    const declared = requiredPermissions(query);
    const effectPermission = EFFECT_PERMISSIONS[query.operation.effect];
    if (!declared.includes(effectPermission)) {
      return decision(
        query,
        'member-membership',
        false,
        'policy_missing',
        `operation ${query.operation.operationId} does not declare the permission for its ${query.operation.effect} effect`
      );
    }
    const missing = declared.find((permission) => !permissions.has(permission));
    if (missing) {
      return decision(
        query,
        'member-membership',
        false,
        'permission_denied',
        `permission ${missing} is required for ${query.operation.operationId}`
      );
    }
    if (query.operation.requiredRole === 'localadmin' && serverRole !== 'localadmin') {
      return decision(
        query,
        'member-membership',
        false,
        'role_denied',
        `member '${member.member_id}' roles cannot perform ${query.operation.operationId}`
      );
    }

    // Scope: the member's own memberships bound tenants; org/project/tier stay
    // on the principal's authenticated claims.
    const principalTenants = query.principal.tenantSlugs;
    const allowedTenants =
      principalTenants === 'all'
        ? memberTenants
        : memberTenants.filter((slug) => principalTenants.includes(slug));
    const resource = query.resource ?? {};
    if (!scopeAllows(allowedTenants, resource.tenantSlug)) {
      return decision(
        query,
        'member-membership',
        false,
        'tenant_scope_denied',
        `tenant scope denied for ${query.operation.operationId}`
      );
    }
    if (!scopeAllows(query.principal.organizationIds, resource.organizationId)) {
      return decision(
        query,
        'member-membership',
        false,
        'organization_scope_denied',
        `organization scope denied for ${query.operation.operationId}`
      );
    }
    if (!scopeAllows(query.principal.projectIds, resource.projectId)) {
      return decision(
        query,
        'member-membership',
        false,
        'project_scope_denied',
        `project scope denied for ${query.operation.operationId}`
      );
    }
    if (resource.tier && !query.principal.tierAccess.includes(resource.tier as OsKnowledgeTier)) {
      return decision(
        query,
        'member-membership',
        false,
        'tier_scope_denied',
        `tier scope denied for ${query.operation.operationId}`
      );
    }
    return decision(query, 'member-membership', true, 'allowed', 'authorized');
  },
};

// ---------------------------------------------------------------------------
// policy-file — declarative governed JSON rules
// ---------------------------------------------------------------------------

export interface AuthzPolicyRule {
  rule_id: string;
  decision: 'allow' | 'deny';
  /** Glob-ish actor patterns: 'user:*', 'kyberion://agent/default/*', exact ids. */
  principals?: string[];
  principal_kinds?: ActorKind[];
  operations?: string[];
  effects?: Array<'read' | 'write' | 'decide'>;
  resources?: {
    tenant?: string;
    organization?: string;
    project?: string;
    tier?: string;
  };
}

export interface AuthzPolicyFile {
  version: '1.0.0';
  /** Applied when no rule matches; only 'deny' is currently meaningful. */
  default_decision?: 'deny';
  rules: AuthzPolicyRule[];
}

const AUTHZ_POLICY_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/authz-policy.schema.json'
);

export function authzPolicyPath(deps?: AuthzResolveDeps): string {
  const explicit = deps?.policyPath?.trim() || envText(deps, 'KYBERION_AUTHZ_POLICY_PATH')?.trim();
  return assertSafeRepositoryPath(
    explicit || pathResolver.knowledge('product/governance/authz-policy.json'),
    { allowMissingLeaf: true }
  );
}

function loadAuthzPolicy(deps?: AuthzResolveDeps): AuthzPolicyFile | null {
  let filePath: string;
  try {
    filePath = authzPolicyPath(deps);
  } catch {
    return null;
  }
  if (!safeExistsSync(filePath)) return null;
  try {
    const parsed = parseSafeJsonInput(readTextFile(filePath), `authz policy '${filePath}'`);
    return defineCatalog<AuthzPolicyFile>({
      id: 'authz-policy',
      path: filePath,
      schema: AUTHZ_POLICY_SCHEMA_PATH,
    }).validate(parsed, filePath);
  } catch {
    return null;
  }
}

function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

function matchAnyPattern(patterns: string[] | undefined, value: string): boolean {
  if (!patterns?.length) return true;
  return patterns.some((pattern) => matchPattern(pattern, value));
}

function ruleMatches(rule: AuthzPolicyRule, query: AuthzQuery): boolean {
  const principal = query.principal;
  if (rule.principal_kinds?.length && !rule.principal_kinds.includes(principal.actor.kind)) {
    return false;
  }
  if (
    rule.principals?.length &&
    !rule.principals.some(
      (pattern) =>
        matchPattern(pattern, principal.actor.id) || matchPattern(pattern, principal.principalId)
    )
  ) {
    return false;
  }
  if (!matchAnyPattern(rule.operations, query.operation.operationId)) return false;
  if (rule.effects?.length && !rule.effects.includes(query.operation.effect)) return false;
  const resource = query.resource ?? {};
  const declared = rule.resources;
  if (declared) {
    if (declared.tenant && declared.tenant !== resource.tenantSlug) return false;
    if (declared.organization && declared.organization !== resource.organizationId) return false;
    if (declared.project && declared.project !== resource.projectId) return false;
    if (declared.tier && declared.tier !== resource.tier) return false;
  }
  return true;
}

const policyFileProvider: AuthzProvider = {
  id: 'policy-file',
  capabilities: {
    principalKinds: ALL_KINDS,
    effects: ['read', 'write', 'decide'],
    tenantAware: true,
    memberAware: false,
    requiresConfig: true,
  },
  canAuthorize(_query, deps) {
    if (!loadAuthzPolicy(deps)) {
      return { eligible: false, unmet: ['no valid authz policy file'] };
    }
    return { eligible: true };
  },
  authorize(query, deps) {
    const policy = loadAuthzPolicy(deps);
    if (!policy) {
      return decision(query, 'policy-file', false, 'provider_error', 'authz policy unavailable');
    }
    const matched = policy.rules.filter((rule) => ruleMatches(rule, query));
    const deny = matched.find((rule) => rule.decision === 'deny');
    if (deny) {
      return decision(
        query,
        'policy-file',
        false,
        'policy_rule_denied',
        `denied by policy rule '${deny.rule_id}'`,
        `policy:${deny.rule_id}`
      );
    }
    const allow = matched.find((rule) => rule.decision === 'allow');
    if (allow) {
      return decision(
        query,
        'policy-file',
        true,
        'allowed',
        `allowed by policy rule '${allow.rule_id}'`,
        `policy:${allow.rule_id}`
      );
    }
    return decision(
      query,
      'policy-file',
      false,
      'no_matching_rule',
      `no policy rule matched ${query.operation.operationId} (default deny)`
    );
  },
};

// ---------------------------------------------------------------------------
// allow-all / deny-all — test & lockdown providers
// ---------------------------------------------------------------------------

const allowAllProvider: AuthzProvider = {
  id: 'allow-all',
  capabilities: {
    principalKinds: ALL_KINDS,
    effects: ['read', 'write', 'decide'],
    tenantAware: false,
    memberAware: false,
    requiresConfig: false,
  },
  canAuthorize: (_query, deps) =>
    // Test-only provider: eligible exclusively under the Vitest harness.
    // Without this gate an eligible-set collapse (e.g. 'membership' purpose
    // with a non-human principal) could rank allow-all above deny-all on an
    // alphabetical zero-score tie — a silent fail-open.
    isVitestProcess(deps?.env)
      ? { eligible: true }
      : { eligible: false, unmet: ['allow-all is test-only (requires the Vitest runtime)'] },
  authorize: (query) => decision(query, 'allow-all', true, 'allowed', 'permitted by allow-all'),
};

const denyAllProvider: AuthzProvider = {
  id: 'deny-all',
  capabilities: {
    principalKinds: ALL_KINDS,
    effects: ['read', 'write', 'decide'],
    tenantAware: false,
    memberAware: false,
    requiresConfig: false,
  },
  canAuthorize: () => ({ eligible: true }),
  authorize: (query) =>
    decision(query, 'deny-all', false, 'policy_rule_denied', 'denied by deny-all (lockdown)'),
};

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

let registered = false;

/** Idempotent — safe to call from composition roots and tests. */
export function registerBuiltinAuthzProviders(): void {
  if (registered) return;
  registered = true;
  for (const provider of [
    roleScopeProvider,
    memberMembershipProvider,
    policyFileProvider,
    allowAllProvider,
    denyAllProvider,
  ]) {
    registerAuthzProvider(provider);
  }
}

registerBuiltinAuthzProviders();

export const BUILTIN_AUTHZ_PROVIDER_IDS = [
  'role-scope',
  'member-membership',
  'policy-file',
  'allow-all',
  'deny-all',
] as const;
