/**
 * Remove live-state paths a test file creates and cannot redirect.
 *
 * Some code under test confines writes to literal repo partitions (for example
 * the browser partition under `active/shared/runtime/browser/`), so the path
 * cannot be remapped into a Vitest sandbox without changing the behaviour
 * being asserted. Call this at module load, before any test runs: it records
 * which of the exact paths do not exist yet, and the returned function removes
 * only those. Paths that already existed (an operator's real state) and every
 * ancestor directory are never touched, so parallel test files sharing a
 * parent stay unaffected; tests/vitest-active-leak-guard.ts counts files only.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeRmSync } from '@agent/core/secure-io';

export function cleanupCreatedLivePaths(repoRelativePaths: readonly string[]): () => void {
  const root = pathResolver.rootDir();
  const created = repoRelativePaths
    .map((relative) => path.join(root, ...relative.split('/').filter(Boolean)))
    .filter((target) => !safeExistsSync(target));
  return () => {
    for (const target of created) {
      if (safeExistsSync(target)) safeRmSync(target, { recursive: true, force: true });
    }
  };
}
