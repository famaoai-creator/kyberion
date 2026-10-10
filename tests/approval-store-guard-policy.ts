/**
 * Pure decisions for `vitest-approval-store-guard.ts` and `vitest-run-id.ts`
 * (no I/O, so they can be unit-tested without touching the store).
 */
import path from 'node:path';

/** Mirrors `VITEST_APPROVAL_STORE_ROOT` in libs/core/governance/approval-store.ts. */
export const VITEST_APPROVAL_STORE_ROOT = 'active/shared/runtime/vitest-approvals';

/** Per-run nonce env var (set by `tests/vitest-run-id.ts`, read by `approvalStoreRoots()`). */
export const VITEST_RUN_ID_ENV = 'KYBERION_VITEST_RUN_ID';

function segment(value: string | undefined): string {
  return value ? value.replace(/[^\w-]/g, '') : '';
}

function storeBase(rootDir: string): string {
  return path.join(rootDir, ...VITEST_APPROVAL_STORE_ROOT.split('/'));
}

/** The directory of one Vitest run, or null when the run has no nonce. */
export function runApprovalStoreDir(rootDir: string, env: NodeJS.ProcessEnv): string | null {
  const run = segment(env[VITEST_RUN_ID_ENV]);
  return run ? path.join(storeBase(rootDir), `run-${run}`) : null;
}

/**
 * The directory `approvalStoreRoots()` writes to for this worker (same
 * sanitising), or null when there is no pool id. Without a pool id the store
 * is the shared base directory, which the guard must never wipe.
 */
export function poolApprovalStoreDir(rootDir: string, env: NodeJS.ProcessEnv): string | null {
  const pool = segment(env.VITEST_POOL_ID);
  if (!pool) return null;
  return path.join(runApprovalStoreDir(rootDir, env) ?? storeBase(rootDir), `pool-${pool}`);
}

/**
 * The run directories created by main process `pid` (nonce `<pid>-<base36>`,
 * as vitest.config.mts sets it), given a lister of directory names.
 */
export function ownRunApprovalStoreDirs(
  rootDir: string,
  pid: number,
  listDirs: (dir: string) => readonly string[]
): string[] {
  const base = storeBase(rootDir);
  const own = new RegExp(`^run-${pid}-[0-9a-z]+$`);
  return listDirs(base)
    .filter((name) => own.test(name))
    .map((name) => path.join(base, name));
}

export interface LeftoverVerdict {
  action: 'none' | 'note' | 'warn' | 'fail';
  message?: string;
}

/**
 * What to do about the files a test file left in the pool store.
 *
 * - a baselined file that left nothing: note it, so the entry is removed and
 *   the baseline shrinks;
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
  const baselined = input.baseline.has(input.testFile);
  if (input.leftovers.length === 0) {
    if (!baselined) return { action: 'none' };
    return {
      action: 'note',
      message:
        `[vitest-approval-store-guard] ${input.testFile} left nothing in the test approval store but is on the leftover baseline — ` +
        `the entry is stale | next: remove it from tests/fixtures/approval-store-leftover-baseline.json ` +
        `(if every test of the file ran) | evidence: ${input.storeDir} empty after the file`,
    };
  }
  if (baselined) return { action: 'none' };
  const shown = input.leftovers.slice(0, 10).join(', ');
  const more = input.leftovers.length > 10 ? ` (+${input.leftovers.length - 10} more)` : '';
  const message =
    `[vitest-approval-store-guard] ${input.testFile} left ${input.leftovers.length} file(s) in the test approval store — ` +
    `a later file in the same pool would read them | next: clear the channels the file writes in afterEach ` +
    `(approvalStoreRoots(); docs/developer/WRITING_TESTS.md "Other gates") | evidence: ${input.storeDir}: ${shown}${more}`;
  return { action: input.strict ? 'fail' : 'warn', message };
}
