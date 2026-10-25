/** Storage channel for autonomous-operation decisions. */
export const AUTONOMY_APPROVAL_CHANNEL = 'autonomy';

import { isVitestProcess } from '../foundation/env.js';
import { TENANT_APPROVAL_ROOT_PATH } from '../foundation/runtime-state-roots.js';
import { isCodeRepositoryRoot } from '../path-resolver.js';

/**
 * Repo-relative root of the vitest-isolated approval store. Test runs write
 * here instead of the live store so fixture approvals never mix with real
 * operator decisions; the storage retention catalog expires it.
 */
export const VITEST_APPROVAL_STORE_ROOT = 'active/shared/runtime/vitest-approvals';

/**
 * A fixture root (KYBERION_ROOT pointed at a temp tree) is already isolated,
 * so its tenant partitions keep the live layout and the real tenant_scope
 * protected prefixes and role grants apply to them (same rule as
 * path-resolver vitestLivePath). A test that mocks path-resolver without the
 * predicate keeps the isolated root.
 */
function fixtureRoot(): boolean {
  try {
    return !isCodeRepositoryRoot();
  } catch {
    return false;
  }
}

/**
 * Repo-relative roots of the approval store: request records live under
 * `coordination`, the append-only event log under `observability`, and the
 * per-tenant partitions (records, challenges and event log of tenant-scoped
 * approvals, `approval-store-location.ts`) under `tenantApprovals`.
 */
export function approvalStoreRoots(env: Record<string, string | undefined> = process.env): {
  coordination: string;
  observability: string;
  tenantApprovals: string;
} {
  if (isVitestProcess(env)) {
    // Per run (KYBERION_VITEST_RUN_ID, set by tests/vitest-run-id.ts) and per
    // worker: two Vitest runs in one checkout, and parallel files that clear a
    // channel, must not race each other.
    const run = env.KYBERION_VITEST_RUN_ID
      ? `/run-${env.KYBERION_VITEST_RUN_ID.replace(/[^\w-]/g, '')}`
      : '';
    const pool = env.VITEST_POOL_ID ? `/pool-${env.VITEST_POOL_ID.replace(/[^\w-]/g, '')}` : '';
    return {
      coordination: `${VITEST_APPROVAL_STORE_ROOT}${run}${pool}/coordination/channels`,
      observability: `${VITEST_APPROVAL_STORE_ROOT}${run}${pool}/observability/channels`,
      tenantApprovals: fixtureRoot()
        ? TENANT_APPROVAL_ROOT_PATH
        : `${VITEST_APPROVAL_STORE_ROOT}${run}${pool}/tenant-approvals`,
    };
  }
  return {
    coordination: 'active/shared/coordination/channels',
    observability: 'active/shared/observability/channels',
    tenantApprovals: TENANT_APPROVAL_ROOT_PATH,
  };
}

const APPROVAL_CHANNEL_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const APPROVAL_REQUEST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeApprovalChannel(channel: string, label = 'channel'): string {
  const normalized = String(channel || '')
    .trim()
    .toLowerCase();
  if (!normalized || !APPROVAL_CHANNEL_PATTERN.test(normalized)) {
    throw new Error(`[POLICY_VIOLATION] Invalid approval ${label}: ${channel}`);
  }
  return normalized;
}

export function normalizeApprovalRequestId(id: string): string {
  const normalized = String(id || '').trim();
  if (!normalized || !APPROVAL_REQUEST_ID_PATTERN.test(normalized)) {
    throw new Error(`[POLICY_VIOLATION] Invalid approval request id: ${id}`);
  }
  return normalized.toLowerCase();
}

/** System-tree request directory of a storage channel (tenant partitions: approval-store-location.ts). */
export function approvalRequestsLogicalDir(storageChannel: string): string {
  return `${approvalStoreRoots().coordination}/${normalizeApprovalChannel(storageChannel)}/approvals/requests`;
}

/** System-tree path of one request record (tenant partitions: approval-store-location.ts). */
export function approvalRequestLogicalPath(storageChannel: string, id: string): string {
  return `${approvalRequestsLogicalDir(storageChannel)}/${normalizeApprovalRequestId(id)}.json`;
}

/** System-tree event log of a storage channel (tenant partitions: approval-store-location.ts). */
export function approvalEventLogicalPath(storageChannel: string): string {
  return `${approvalStoreRoots().observability}/${normalizeApprovalChannel(storageChannel)}/approvals.jsonl`;
}

/** System-tree passkey challenge directory of a storage channel. */
export function approvalPasskeyChallengesLogicalDir(storageChannel: string): string {
  return `${approvalStoreRoots().coordination}/${normalizeApprovalChannel(storageChannel)}/approvals/passkey-challenges`;
}
