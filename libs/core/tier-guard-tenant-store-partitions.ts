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
    sudoAllows: (sudoScope: string[] | undefined) => boolean;
    matches: (pattern: string) => boolean;
  }
): { allowed: boolean; reason?: string } | null {
  const partition = tenantStoreLedgerPartitionOf(relativePath);
  if (!partition) return null;
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
