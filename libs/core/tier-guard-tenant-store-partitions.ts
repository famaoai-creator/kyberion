/**
 * Write rule for dedicated-store tenant partitions (storage-layout.ts
 * TENANT_STORE_LEDGER_ROOTS: the tenant ledger and the tenant approval store).
 *
 * These partitions are authority evidence — hash-chained audit entries,
 * approval decisions a gate trusts — so neither the broad runtime default
 * (`default_allow: active/shared/runtime/`) nor another role's broad grant may
 * write them, bound or unbound. Only scoped SUDO, the persona's own grant, or
 * the store role's own grant (resolved through its bound tenant) apply. The
 * tenant scope check runs before this in tier-guard.validateWritePermission.
 */
import { tenantStoreLedgerPartitionOf } from './storage-layout.js';
import { isRecord } from './foundation/primitives.js';
import { isValidTenantSlug } from './entity-scope.js';

interface TenantScopePolicy {
  tenant_scope?: {
    slug_pattern?: unknown;
    protected_prefixes?: string[];
    shared_prefixes?: string[];
    system_registry_reads?: unknown[];
    require_tenant_binding?: unknown;
    broker_requirements?: {
      require_approved_by?: unknown;
      require_approved_at?: unknown;
      require_expires_at?: unknown;
    };
  };
}

/** Pure policy normalization; the caller resolves the current environment flag. */
export function tenantScopeConfig(policy: TenantScopePolicy, requireTenantBinding: boolean) {
  const cfg = policy?.tenant_scope || {};
  const slugPatternRaw =
    typeof cfg.slug_pattern === 'string' ? cfg.slug_pattern : '^[a-z][a-z0-9-]{1,30}$';
  let slugPattern = /^[a-z][a-z0-9-]{1,30}$/;
  try {
    slugPattern = new RegExp(slugPatternRaw);
  } catch (_) {
    /* fallback */
  }
  return {
    protectedPrefixes: Array.isArray(cfg.protected_prefixes)
      ? cfg.protected_prefixes
      : ['knowledge/confidential/'],
    sharedPrefixes: Array.isArray(cfg.shared_prefixes)
      ? cfg.shared_prefixes
      : ['knowledge/confidential/heuristics/', 'knowledge/confidential/relationships/'],
    systemRegistryReads: Array.isArray(cfg.system_registry_reads)
      ? cfg.system_registry_reads.filter(
          (entry: unknown): entry is { path: string; roles: string[] } =>
            Boolean(entry) &&
            typeof (entry as { path?: unknown }).path === 'string' &&
            Array.isArray((entry as { roles?: unknown }).roles) &&
            (entry as { roles: unknown[] }).roles.every((role) => typeof role === 'string')
        )
      : [
          {
            path: 'knowledge/confidential/tenants/index.json',
            roles: ['check_tenant_registry_consistency'],
          },
        ],
    // Unpartitioned legacy roots still follow the existing tier/persona rules.
    requireTenantBinding: cfg.require_tenant_binding === true || requireTenantBinding,
    slugPattern,
    brokerRequirements: {
      requireApprovedBy: cfg?.broker_requirements?.require_approved_by !== false,
      requireApprovedAt: cfg?.broker_requirements?.require_approved_at !== false,
      requireExpiresAt: cfg?.broker_requirements?.require_expires_at !== false,
    },
  };
}

export function normalizeRegisteredTenantProfile(value: unknown): {
  tenant_slug: string;
  status: string;
} | null {
  if (!isRecord(value)) return null;
  if (typeof value.tenant_slug !== 'string' || typeof value.status !== 'string') return null;
  return { tenant_slug: value.tenant_slug, status: value.status };
}

export interface TenantGroupProfile {
  tenant_group_id: string;
  status?: string;
  member_tenants?: string[];
  shared_prefixes?: string[];
}

export function extractTenantGroupFromSharedPath(relativePath: string): string | null {
  const match = relativePath.match(
    /^knowledge\/confidential\/shared\/([a-z][a-z0-9-]{1,30})(?:\/|$)/
  );
  return match?.[1] ?? null;
}

export function isValidTenantGroupProfile(
  groupId: string,
  profile: unknown
): profile is TenantGroupProfile {
  if (!isRecord(profile)) return false;
  const memberTenants = profile.member_tenants;
  const sharedPrefixes = profile.shared_prefixes;
  return (
    profile.tenant_group_id === groupId &&
    typeof profile.tenant_group_id === 'string' &&
    (profile.status === 'active' ||
      profile.status === 'suspended' ||
      profile.status === 'archived') &&
    Array.isArray(memberTenants) &&
    memberTenants.length > 0 &&
    memberTenants.every((tenant) => typeof tenant === 'string' && isValidTenantSlug(tenant)) &&
    Array.isArray(sharedPrefixes) &&
    sharedPrefixes.length > 0 &&
    sharedPrefixes.every(
      (prefix) =>
        typeof prefix === 'string' &&
        new RegExp(`^knowledge/confidential/shared/${groupId.replace(/[^\w-]/gu, '')}/`).test(
          prefix
        )
    )
  );
}

interface PartitionWritePolicy {
  authority_role_permissions?: Record<string, { allow_write?: unknown[] } | undefined>;
  persona_permissions?: Record<string, { allow_write?: unknown[] } | undefined>;
}

interface PartitionWriteIdentity {
  persona: string;
  role?: string;
  authorities: readonly string[];
  sudoScope?: string[];
}

/**
 * The write decision for `relativePath` when it lies in a dedicated-store
 * tenant partition, or null when it does not (the ordinary rules apply).
 * `deps` are tier-guard's own path matchers.
 */
export function tenantStorePartitionWriteDecision(
  policy: PartitionWritePolicy,
  relativePath: string,
  identity: PartitionWriteIdentity,
  deps: {
    operation: 'write' | 'append' | 'mkdir';
    sudoAllows: (sudoScope: string[] | undefined) => boolean;
    matches: (pattern: string) => boolean;
  }
): { allowed: boolean; reason?: string } | null {
  const partition = tenantStoreLedgerPartitionOf(relativePath);
  if (!partition) return null;
  // Creating the bare tier directory (the parent of every tenant partition)
  // follows the ordinary rules; any file at or under it does not.
  if (!partition.tenant && deps.operation === 'mkdir') return null;
  const { persona, role, authorities, sudoScope } = identity;
  if (authorities.includes('SUDO') && deps.sudoAllows(sudoScope)) return { allowed: true };
  const grants = [
    ...(role === partition.storeRole
      ? (policy.authority_role_permissions?.[role]?.allow_write ?? [])
      : []),
    ...(policy.persona_permissions?.[persona]?.allow_write ?? []),
  ];
  if (grants.some((pattern) => typeof pattern === 'string' && deps.matches(pattern)))
    return { allowed: true };
  return {
    allowed: false,
    reason: `[POLICY_VIOLATION] '${relativePath}' is a tenant store partition: only '${partition.storeRole}' bound to its tenant (or SUDO) may write it, not persona '${persona}' with role '${role || 'unknown'}'.`,
  };
}
