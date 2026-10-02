import * as nodePath from 'node:path';
import { safeExistsSync, safeLstat, safeReaddir } from './secure-io.js';

/**
 * Filesystem walks shared by the storage janitor sweeps. Symlinks are never
 * followed and unreadable entries are skipped, so a sweep can only ever see
 * real files inside the directory it was pointed at.
 */

/** Regular files under `dir` (recursive); symlinks skipped. */
export function collectFiles(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  const results: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = safeReaddir(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const fullPath = nodePath.join(current, name);
      try {
        const stat = safeLstat(fullPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          walk(fullPath);
        } else {
          results.push(fullPath);
        }
      } catch {
        // skip unreadable entries
      }
    }
  };
  walk(dir);
  return results;
}

/** Directories under `dir` in post-order (deepest first); symlinks skipped. */
export function collectDirsPostOrder(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  const results: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = safeReaddir(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const fullPath = nodePath.join(current, name);
      try {
        const stat = safeLstat(fullPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          walk(fullPath);
          results.push(fullPath);
        }
      } catch {
        // skip unreadable entries
      }
    }
  };
  walk(dir);
  return results;
}
