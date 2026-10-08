/**
 * AL-01 / G01: which top-level `active/shared/runtime/` entries exist on disk
 * with no retention-catalog entry. The janitor never deletes these — it
 * reports them so undeclared (silently-forever) retention is visible.
 *
 * Covers directories and the files that sit directly in the runtime root
 * (append-only `*.jsonl` ledgers, `*.json` state). Files were skipped before
 * G01, so a growing ledger with no entry never surfaced anywhere.
 */
import * as nodePath from 'node:path';
import { shared } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReaddir } from './secure-io.js';
import {
  coveredRuntimeSubdirs,
  loadRetentionCatalog,
  type LoadedRetentionCatalog,
} from './storage-retention-catalog.js';

/** Tracked keep-files are infrastructure, not runtime stores. */
const KEEP_FILE_BASENAMES = new Set(['.gitignore', '.gitkeep', '.gitattributes']);

/** Repo-relative, sorted; symlinks are skipped. `kind` narrows to dirs or files. */
export function listUncoveredRuntimeEntries(
  catalog?: LoadedRetentionCatalog,
  kind: 'all' | 'dirs' | 'files' = 'all'
): string[] {
  const covered = coveredRuntimeSubdirs(catalog ?? loadRetentionCatalog());
  const runtimeRoot = shared('runtime');
  if (!safeExistsSync(runtimeRoot)) return [];
  let entries: string[];
  try {
    entries = safeReaddir(runtimeRoot);
  } catch {
    return [];
  }
  const uncovered: string[] = [];
  for (const name of [...entries].sort()) {
    try {
      const stat = safeLstat(nodePath.join(runtimeRoot, name));
      if (stat.isSymbolicLink()) continue;
      const isDir = stat.isDirectory();
      if (!isDir && (!stat.isFile() || KEEP_FILE_BASENAMES.has(name))) continue;
      if ((kind === 'dirs' && !isDir) || (kind === 'files' && isDir)) continue;
    } catch {
      continue;
    }
    if (!covered.has(name)) uncovered.push(`active/shared/runtime/${name}`);
  }
  return uncovered;
}

/** AL-01: uncovered runtime subdirectories only (the original janitor report field). */
export function listUncoveredRuntimeDirs(catalog?: LoadedRetentionCatalog): string[] {
  return listUncoveredRuntimeEntries(catalog, 'dirs');
}

/** G01: uncovered top-level files directly under `active/shared/runtime/`. */
export function listUncoveredRuntimeFiles(catalog?: LoadedRetentionCatalog): string[] {
  return listUncoveredRuntimeEntries(catalog, 'files');
}
