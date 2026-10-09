/**
 * Pure decisions for `vitest-approval-store-guard.ts` (no I/O, so they can be
 * unit-tested without touching the per-pool store).
 */
import path from 'node:path';

/** Mirrors `VITEST_APPROVAL_STORE_ROOT` in libs/core/governance/approval-store.ts. */
export const VITEST_APPROVAL_STORE_ROOT = 'active/shared/runtime/vitest-approvals';

/** The directory `approvalStoreRoots()` writes to for this worker (same pool-id sanitising). */
export function poolApprovalStoreDir(rootDir: string, env: NodeJS.ProcessEnv): string {
  const base = path.join(rootDir, ...VITEST_APPROVAL_STORE_ROOT.split('/'));
  const pool = env.VITEST_POOL_ID?.replace(/[^\w-]/g, '');
  return pool ? path.join(base, `pool-${pool}`) : base;
}

export interface LeftoverVerdict {
  action: 'none' | 'warn' | 'fail';
  message?: string;
}

/**
 * What to do about the files a test file left in the pool store.
 *
 * - nothing left: nothing to do;
 * - a file on the baseline (known debt, recorded 2026-10-09): stay quiet, the
 *   guard has already cleared the store for the next file;
 * - any other file: warn, and fail under `KYBERION_TEST_LEAK_STRICT=1` (CI),
 *   so a new writer is fixed at source instead of joining the debt.
 */
export function leftoverVerdict(input: {
  testFile: string;
  leftovers: readonly string[];
  baseline: ReadonlySet<string>;
  strict: boolean;
  storeDir: string;
}): LeftoverVerdict {
  if (input.leftovers.length === 0) return { action: 'none' };
  if (input.baseline.has(input.testFile)) return { action: 'none' };
  const shown = input.leftovers.slice(0, 10).join(', ');
  const more = input.leftovers.length > 10 ? ` (+${input.leftovers.length - 10} more)` : '';
  const message =
    `[vitest-approval-store-guard] ${input.testFile} left ${input.leftovers.length} file(s) in the test approval store — ` +
    `a later file in the same pool would read them | next: clear the channels the file writes in afterEach ` +
    `(approvalStoreRoots(); docs/developer/WRITING_TESTS.md "Other gates") | evidence: ${input.storeDir}: ${shown}${more}`;
  return { action: input.strict ? 'fail' : 'warn', message };
}
