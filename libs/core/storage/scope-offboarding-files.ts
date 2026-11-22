import * as path from 'node:path';
import {
  assertSafeRepositoryPath,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeStat,
} from '../secure-io.js';

export function listDirEntries(dir: string): string[] {
  let safeDir: string;
  try {
    safeDir = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  } catch {
    return [];
  }
  if (!safeExistsSync(safeDir)) return [];
  try {
    return safeReaddir(safeDir);
  } catch (error) {
    // Only a directory that vanished is empty. A refused or changed listing
    // is rethrown, so verification reports it instead of claiming clean.
    const code = (error as { code?: unknown } | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw error;
  }
}

/** Recursive copy through secure-io (no shell, cross-platform). */
export function copyTree(source: string, destination: string): void {
  const safeSource = assertSafeRepositoryPath(source);
  const safeDestination = assertSafeRepositoryPath(destination, { allowMissingLeaf: true });
  if (safeStat(safeSource).isDirectory()) {
    if (!safeExistsSync(safeDestination)) safeMkdir(safeDestination, { recursive: true });
    for (const name of listDirEntries(safeSource)) {
      copyTree(path.join(safeSource, name), path.join(safeDestination, name));
    }
    return;
  }
  safeMkdir(path.dirname(safeDestination), { recursive: true });
  safeCopyFileSync(safeSource, safeDestination);
}
