/**
 * Vitest globalSetup: clean up this Vitest run's approval-store directories.
 *
 * `approvalStoreRoots()` puts the test approval store under
 * `vitest-approvals/run-<KYBERION_VITEST_RUN_ID>/pool-<n>/`, and
 * `vitest-approval-store-guard.ts` wipes only that pool directory. Pool ids
 * restart at 1 in every run, so without the nonce two runs in one checkout (an
 * editor's watch run beside `pnpm test`, or two agents) would share `pool-1`
 * and wipe each other's records mid-test.
 *
 * vitest.config.mts sets the nonce (`<pid>-<base36 time>`) while it loads, in
 * the main process before the workers are forked. globalSetup cannot: its
 * process.env is not the one the forks inherit (measured 2026-10-09, Vitest
 * 5.0.3: workers saw the config's nonce, globalSetup did not). Child processes
 * of a test inherit the nonce through the env allowlists.
 *
 * Teardown therefore removes every `run-<this pid>-*` directory: the nonces
 * this main process created. A nonce inherited from an outer run carries that
 * run's pid, so its directory is left to it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownRunApprovalStoreDirs } from './approval-store-guard-policy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Remove the approval-store run directories main process `pid` created. */
export function removeOwnRunDirs(rootDir: string = ROOT, pid: number = process.pid): void {
  for (const dir of ownRunApprovalStoreDirs(rootDir, pid, listDirs)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Vitest passes its own context to globalSetup; take no parameters.
export default function setup(): () => void {
  return () => removeOwnRunDirs();
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}
