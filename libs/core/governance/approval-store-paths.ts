import { isVitestProcess } from '../foundation/env.js';

/**
 * Repo-relative root of the vitest-isolated approval store. Test runs write
 * here instead of the live store so fixture approvals never mix with real
 * operator decisions; the storage retention catalog expires it.
 */
export const VITEST_APPROVAL_STORE_ROOT = 'active/shared/runtime/vitest-approvals';

/**
 * Repo-relative roots of the approval store: request records live under
 * `coordination`, the append-only event log under `observability`.
 */
export function approvalStoreRoots(env: Record<string, string | undefined> = process.env): {
  coordination: string;
  observability: string;
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
    };
  }
  return {
    coordination: 'active/shared/coordination/channels',
    observability: 'active/shared/observability/channels',
  };
}
