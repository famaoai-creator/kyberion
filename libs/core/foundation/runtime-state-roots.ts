import { createHash } from 'node:crypto';
import { isValidTenantSlug } from './scope.js';

/**
 * Durable tier-partitioned state, distinct from append-only metrics ledgers.
 * State roots mirror knowledge-tier permissions for reads AND writes; they
 * are never added to metrics offboarding/compaction merely by registration.
 */
export const PARTITIONED_RUNTIME_STATE_ROOTS = {
  dot: 'active/shared/runtime/dot',
  pipeline_library_runs: 'active/shared/runtime/pipeline-library-runs',
  /** Evidence and per-action autonomy overrides; never shared across tenants. */
  autonomy_learning: 'active/shared/runtime/autonomy-learning',
  external_operations: 'active/shared/runtime/external-operations',
  hearing: 'active/shared/runtime/hearing',
  discussion_create_requests: 'active/shared/runtime/discussion-create-requests',
  /** PG-03 standing grants (governance/grant-store.ts). */
  grants: 'active/shared/runtime/grants',
  /** CD-06 customer decision invite links (hashes only; customer-decision/invite.ts). */
  customer_decision_invites: 'active/shared/runtime/customer-decision-invites',
  /** Kyberion -> Chrome extension pull mailbox (browser/browser-bridge-mailbox.ts). */
  browser_bridge_mailbox: 'active/shared/runtime/browser-bridge-mailbox',
} as const;

/**
 * D9: root of the hash-chained tenant partitions of the hybrid ledger
 * (libs/core/ledger.ts). An append-only ledger root, registered in
 * storage-layout.ts PARTITIONED_RUNTIME_LEDGER_ROOTS — not a state root.
 */
export const TENANT_LEDGER_ROOT_PATH = 'active/shared/runtime/tenant-ledger';

/**
 * Root of the per-tenant approval store partitions
 * (`libs/core/governance/approval-store-location.ts`):
 * `<personal|confidential>/<tenant>/<channel>/{requests,passkey-challenges}/` and
 * `<channel>/approvals.jsonl`. Registered in storage-layout.ts
 * PARTITIONED_RUNTIME_LEDGER_ROOTS — not a state root (and distinct from the older
 * runtime `approvals` store).
 */
export const TENANT_APPROVAL_ROOT_PATH = 'active/shared/runtime/tenant-approvals';

/**
 * The shared inter-process lock directory (foundation/lock-utils.ts LOCK_ROOT);
 * narrow store roles that take a store lock name it from here.
 */
export const RUNTIME_LOCK_ROOT_PATH = 'active/shared/runtime/locks';

/**
 * Root of the work-coordination append-only ledgers (items/leases JSONL,
 * boards state, observability events) owned by
 * workforce/work-coordination-ledger.ts.
 */
export const WORK_COORDINATION_ROOT_PATH = 'active/shared/runtime/work-coordination';

/** Logical names preserve existing layouts; registration never grants access. */
export const RUNTIME_STATE_PATHS = {
  'pipeline.scheduleRegistry': 'active/shared/runtime/pipeline-schedules.json',
  'dot.wakeLedger': 'active/shared/runtime/dot-wake-ledger.jsonl',
  'dot.actionLedger': 'active/shared/runtime/dot-action-ledger.jsonl',
  'task.workspacesRoot': 'active/shared/runtime/workspaces',
  'dot.lifecycleAudit': 'active/shared/runtime/dot-lifecycle-audit.jsonl',
  'memory.promotionQueue': 'active/shared/runtime/memory/promotion-queue.jsonl',
  'memory.tenantRoot': 'active/shared/runtime/tenants',
  'organization.projectsRoot': 'active/shared/runtime/projects',
  'quota.tenantBuckets': 'active/shared/runtime/tenant-rate-limit-state.json',
} as const;

export type RuntimeStateKey = keyof typeof RUNTIME_STATE_PATHS;
export interface RuntimeStateScope {
  tenant_slug?: string;
  tier?: 'public' | 'confidential' | 'personal';
  owner_nhi?: string;
}

/**
 * Both paths are repository-relative so foreign-worktree readers can resolve
 * the same layout against their own root. Physical placement is not authority.
 * Global Dot ledgers remain global; only the memory queue has scoped layouts.
 */
export function runtimeStatePath(
  key: RuntimeStateKey,
  scope?: RuntimeStateScope
): { logicalPath: string; physicalPath: string } {
  if (!Object.hasOwn(RUNTIME_STATE_PATHS, key)) {
    throw new Error(`[RUNTIME_STATE_KEY_INVALID] ${String(key)}`);
  }
  const logicalPath = RUNTIME_STATE_PATHS[key];
  if (scope?.tier !== undefined && !['public', 'confidential', 'personal'].includes(scope.tier)) {
    throw new Error('[RUNTIME_STATE_TIER_INVALID]');
  }
  if (scope?.tenant_slug !== undefined && !isValidTenantSlug(scope.tenant_slug)) {
    throw new Error('[RUNTIME_STATE_TENANT_INVALID]');
  }
  if (scope?.tier === 'confidential' && !scope.tenant_slug) {
    throw new Error('[RUNTIME_STATE_TENANT_REQUIRED]');
  }
  if (key !== 'memory.promotionQueue') {
    if (scope && (scope.tenant_slug || scope.owner_nhi || scope.tier)) {
      throw new Error(`[RUNTIME_STATE_SCOPE_UNSUPPORTED] ${key}`);
    }
    return { logicalPath, physicalPath: logicalPath };
  }
  if (scope?.tier === 'personal') {
    if (typeof scope.owner_nhi !== 'string' || !scope.owner_nhi.trim()) {
      throw new Error('[MEMORY_SCOPE_UNSUPPORTED] Personal queue requires an explicit owner_nhi');
    }
    const owner = createHash('sha256').update(scope.owner_nhi).digest('hex');
    return {
      logicalPath,
      physicalPath: `active/personal/owners/${owner}/memory/promotion-queue.jsonl`,
    };
  }
  // Non-personal candidates may name an owner for brokered promotion; that
  // attribution never changes their tenant queue's physical ownership.
  if (scope?.tenant_slug) {
    return {
      logicalPath,
      physicalPath: `${RUNTIME_STATE_PATHS['memory.tenantRoot']}/${scope.tenant_slug}/memory/promotion-queue.jsonl`,
    };
  }
  return { logicalPath, physicalPath: logicalPath };
}
