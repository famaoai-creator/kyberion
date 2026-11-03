/**
 * local-fs storage backend — the governed default.
 *
 * Every operation delegates to the secure-io primitives callers used before
 * the seam existed, so tier, tenant, symlink and audit checks are unchanged.
 * Importing this module installs `local-fs` on the storage-backend seam.
 */

import {
  safeAppendFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
} from '../secure-io.js';
import { streamTextLines } from '../jsonl-read.js';
import {
  LOCAL_STORAGE_BACKEND_ID,
  registerStorageBackend,
  type StorageBackend,
} from './storage-backend.js';

export const localStorageBackend: StorageBackend = {
  id: LOCAL_STORAGE_BACKEND_ID,
  exists(filePath) {
    return safeExistsSync(filePath);
  },
  stat(filePath) {
    return safeExistsSync(filePath) ? safeLstat(filePath) : null;
  },
  mkdir(dirPath) {
    safeMkdir(dirPath, { recursive: true });
  },
  append(filePath, data) {
    safeAppendFileSync(filePath, data, 'utf8');
  },
  readLines(filePath) {
    return streamTextLines(filePath);
  },
  list(dirPath) {
    return safeReaddir(dirPath);
  },
};

registerStorageBackend(localStorageBackend, {
  provenance: 'builtin',
  source: 'libs/core/storage/local-storage-backend.ts',
});
