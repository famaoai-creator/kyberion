/**
 * Contract stub for a Promise-based object-store backend.
 *
 * Proves the async seam can await durability (artificial delay on append)
 * without shipping an AWS/R2 SDK. Production object-store adapters replace
 * the in-memory map with remote puts while keeping this method shape.
 */

import * as path from 'node:path';
import type { AsyncStorageBackend, StorageStat, StorageTextLine } from './storage-backend.js';

export const OBJECT_STORAGE_BACKEND_STUB_ID = 'object-storage-stub';

export interface ObjectStorageStubOptions {
  /** Artificial append latency — demonstrates awaited durability. */
  appendDelayMs?: number;
}

/**
 * In-memory async backend with optional append delay. Not registered on the
 * governed seam — tests construct it explicitly.
 */
export function createObjectStorageBackendStub(
  options: ObjectStorageStubOptions = {}
): AsyncStorageBackend {
  const appendDelayMs = Math.max(0, options.appendDelayMs ?? 1);
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);

  const normalize = (filePath: string): string =>
    path.posix.normalize(filePath.replace(/\\/g, '/'));

  const isDir = (dirPath: string): boolean => {
    if (dirs.has(dirPath)) return true;
    const prefix = dirPath === '/' ? '/' : `${dirPath}/`;
    for (const filePath of files.keys()) {
      if (filePath.startsWith(prefix)) return true;
    }
    return false;
  };

  return {
    id: OBJECT_STORAGE_BACKEND_STUB_ID,
    async exists(filePath) {
      const target = normalize(filePath);
      return files.has(target) || isDir(target);
    },
    async stat(filePath): Promise<StorageStat | null> {
      const target = normalize(filePath);
      const content = files.get(target);
      if (content !== undefined) {
        return {
          isFile: () => true,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          size: Buffer.byteLength(content, 'utf8'),
          mtimeMs: 0,
        };
      }
      if (isDir(target)) {
        return {
          isFile: () => false,
          isDirectory: () => true,
          isSymbolicLink: () => false,
          size: 0,
          mtimeMs: 0,
        };
      }
      return null;
    },
    async mkdir(dirPath) {
      let current = normalize(dirPath);
      dirs.add(current);
      while (current !== '/') {
        current = path.posix.dirname(current);
        dirs.add(current);
      }
    },
    async append(filePath, data) {
      if (appendDelayMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, appendDelayMs));
      }
      const target = normalize(filePath);
      files.set(target, (files.get(target) ?? '') + data);
    },
    async *readLines(filePath): AsyncGenerator<StorageTextLine> {
      const target = normalize(filePath);
      const content = files.get(target);
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
    },
    async list(dirPath) {
      const target = normalize(dirPath);
      if (!isDir(target)) {
        throw new Error(`ENOTDIR: not a directory, list '${dirPath}'`);
      }
      const prefix = target === '/' ? '/' : `${target}/`;
      const names = new Set<string>();
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash === -1 ? rest : rest.slice(0, slash));
      }
      return [...names].sort();
    },
  };
}
