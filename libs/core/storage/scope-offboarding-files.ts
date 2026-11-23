import * as path from 'node:path';
import { readJson } from '../foundation/json.js';
import { parseSafeJsonObjectValue } from '../foundation/safe-json.js';
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

/** One JSON object record, or null when absent, not a regular file, or unreadable. */
export function readJsonRecord(filePath: string): Record<string, unknown> | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath)) return null;
    if (!safeStat(safePath).isFile()) return null;
    return parseSafeJsonObjectValue(readJson<unknown>(safePath), `scope record ${filePath}`);
  } catch {
    return null;
  }
}

/** The safe repository path, or undefined when it escapes the root or crosses a symlink. */
export function safeOptionalRepositoryPath(filePath: string): string | undefined {
  try {
    return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  } catch {
    return undefined;
  }
}
