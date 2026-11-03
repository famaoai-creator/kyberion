/**
 * memory storage backend — hermetic backend for tests and dry runs.
 *
 * `createMemoryStorageBackend()` returns an isolated sync store; inject it via
 * `createEntryLedger(path, { backend })` (sync or async — entry-ledger
 * normalizes). Importing this module also registers one shared `memory`
 * provider on the seam so `resolveStorageBackend('memory')` works — it is
 * never in the default chain, so production resolution can never
 * land on it.
 *
 * The model is deliberately lenient: parent directories are implicit and
 * append creates the file, matching a key/value object store rather than a
 * strict POSIX filesystem. Boundary enforcement stays with the caller, same
 * as it does against local-fs.
 */

import * as path from 'node:path';
import {
  registerStorageBackend,
  type StorageStat,
  type StorageTextLine,
  type SyncStorageBackend,
} from './storage-backend.js';

export const MEMORY_STORAGE_BACKEND_ID = 'memory';

class MemoryStorageBackend implements SyncStorageBackend {
  readonly id = MEMORY_STORAGE_BACKEND_ID;
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>(['/']);

  private normalize(filePath: string): string {
    return path.posix.normalize(filePath.replace(/\\/g, '/'));
  }

  private parentDirs(dirPath: string): string[] {
    const out: string[] = [];
    let current = path.posix.dirname(dirPath);
    while (current && current !== '.' && !out.includes(current)) {
      out.push(current);
      if (current === '/') break;
      current = path.posix.dirname(current);
    }
    return out;
  }

  private isDir(dirPath: string): boolean {
    if (this.dirs.has(dirPath)) return true;
    const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) return true;
    }
    return false;
  }

  exists(filePath: string): boolean {
    const target = this.normalize(filePath);
    return this.files.has(target) || this.isDir(target);
  }

  stat(filePath: string): StorageStat | null {
    const target = this.normalize(filePath);
    const content = this.files.get(target);
    if (content !== undefined) {
      const size = Buffer.byteLength(content, 'utf8');
      return {
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
        size,
        mtimeMs: 0,
      };
    }
    if (this.isDir(target)) {
      return {
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
        size: 0,
        mtimeMs: 0,
      };
    }
    return null;
  }

  mkdir(dirPath: string): void {
    const target = this.normalize(dirPath);
    this.dirs.add(target);
    for (const parent of this.parentDirs(target)) this.dirs.add(parent);
  }

  append(filePath: string, data: string): void {
    const target = this.normalize(filePath);
    this.files.set(target, (this.files.get(target) ?? '') + data);
  }

  *readLines(filePath: string): Generator<StorageTextLine> {
    const target = this.normalize(filePath);
    const content = this.files.get(target);
    if (content === undefined) {
      throw new Error(`ENOENT: no such file, readLines '${filePath}'`);
    }
    let lineNumber = 0;
    let start = 0;
    while (start < content.length) {
      const newline = content.indexOf('\n', start);
      lineNumber += 1;
      if (newline === -1) {
        yield { text: content.slice(start), lineNumber, terminated: false };
        break;
      }
      yield { text: content.slice(start, newline), lineNumber, terminated: true };
      start = newline + 1;
    }
  }

  list(dirPath: string): string[] {
    const target = this.normalize(dirPath);
    if (!this.isDir(target)) {
      throw new Error(`ENOTDIR: not a directory, list '${dirPath}'`);
    }
    const prefix = target === '/' ? '/' : `${target}/`;
    const names = new Set<string>();
    for (const filePath of this.files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const slash = rest.indexOf('/');
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    for (const dir of this.dirs) {
      if (dir === target || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash !== -1) names.add(rest.slice(0, slash));
      else names.add(rest);
    }
    return [...names].sort();
  }
}

export function createMemoryStorageBackend(): SyncStorageBackend {
  return new MemoryStorageBackend();
}

registerStorageBackend(createMemoryStorageBackend(), {
  provenance: 'builtin',
  source: 'libs/kernel/src/storage/memory-storage-backend.ts',
});
