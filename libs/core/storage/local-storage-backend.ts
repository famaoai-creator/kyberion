/**
 * local-fs storage backend — the governed default.
 *
 * Every operation delegates to the secure-io primitives callers used before
 * the seam existed, so tier, tenant, symlink and audit checks are unchanged.
 * Importing this module installs `local-fs` on the storage-backend seam
 * (wrapped to the async contract via `toAsyncStorageBackend`) and the core
 * default-order resolver (saved seam default → governed chain).
 */

import {
  safeAppendFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
} from '../secure-io.js';
import { streamTextLines } from './jsonl-read.js';
import { resolveSeamDefaultOrder } from '../provider/seam-provider-selection.js';
import {
  LOCAL_STORAGE_BACKEND_ID,
  STORAGE_BACKEND_SEAM,
  registerStorageBackend,
  setStorageBackendDefaultOrderResolver,
  type SyncStorageBackend,
} from '@agent/kernel/storage/storage-backend';

export const localStorageBackend: SyncStorageBackend = {
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

// No-selector order for the kernel seam: saved seam default
// (`KYBERION_SEAM_DEFAULTS="storage-backend=<id>"` / scope layers) → governed
// `default_chains.default` → builtin `local-fs`.
setStorageBackendDefaultOrderResolver(() =>
  resolveSeamDefaultOrder(STORAGE_BACKEND_SEAM, { builtin: [LOCAL_STORAGE_BACKEND_ID] })
);
