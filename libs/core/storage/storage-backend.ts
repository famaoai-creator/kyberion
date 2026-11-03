/**
 * storage-backend seam — the pluggable persistence extension point.
 *
 * Kyberion's sovereign state (ledgers, inboxes, evidence) is written through a
 * small POSIX-shaped surface. Today exactly one implementation backs it:
 * `local-fs` over @agent/core/secure-io. Distributed runtimes need the same
 * surface over object storage / KV / memory, without callers learning which
 * environment they run in.
 *
 * Providers register by id (`local-fs` builtin, `memory` for hermetic tests,
 * object-storage adapters later); selection order is governed data
 * (`seam-provider-selection/storage-backend.json` `default_chains`), never a
 * hard-coded preference list. Callers that need a specific backend pass its id
 * or instance explicitly — the governed default only fills the gap.
 *
 * The contract is intentionally a POSIX subset (sync, string paths): it is the
 * smallest surface entry-ledger and friends actually need, and every backend —
 * local disk, in-memory, S3-compatible — can satisfy it.
 */

import { createProviderRegistry } from '../provider-registry.js';
import type { SeamProviderMetadata } from '../seam.js';
import { getSeamSelectionPolicy } from '../seam-provider-selection.js';

export const STORAGE_BACKEND_SEAM = 'storage-backend';
/** Builtin default provider id; also the governed `default_provider`. */
export const LOCAL_STORAGE_BACKEND_ID = 'local-fs';

/** Structural subset of `fs.Stats` — lstat semantics, no symlink follow. */
export interface StorageStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface StorageTextLine {
  readonly text: string;
  readonly lineNumber: number;
  /** False only for a final line with no `\n` terminator (possibly torn). */
  readonly terminated: boolean;
}

/**
 * POSIX-subset storage surface. Implementations must be synchronous — the
 * governed call sites (entry-ledger, secure-io consumers) are sync today; an
 * async backend would silently drop durability guarantees.
 */
export interface StorageBackend {
  readonly id: string;
  exists(path: string): boolean;
  /** lstat semantics — `null` when the path is absent. */
  stat(path: string): StorageStat | null;
  /** Recursive mkdir; no-op when the directory already exists. */
  mkdir(path: string): void;
  /** Append bytes (utf8) to the end of `path`, creating the file if absent. */
  append(path: string, data: string): void;
  /** Stream raw text lines in append order. Implementations bound chunk size. */
  readLines(path: string): Iterable<StorageTextLine>;
  /** Direct-child names of a directory; throws when `path` is not a directory. */
  list(path: string): string[];
}

const storageBackendRegistry = createProviderRegistry<StorageBackend>({
  seam: STORAGE_BACKEND_SEAM,
  owner: 'libs/core/storage/storage-backend.ts',
  source: 'storage-backend-extension',
  missingIdError: 'StorageBackend must have a non-empty id',
});

export function registerStorageBackend(
  backend: StorageBackend,
  metadata?: SeamProviderMetadata
): () => void {
  return storageBackendRegistry.register(backend, metadata);
}

export function listStorageBackends(): StorageBackend[] {
  return storageBackendRegistry.list();
}

export function getStorageBackend(id: string): StorageBackend | undefined {
  return storageBackendRegistry.get(id);
}

export function resetStorageBackends(): void {
  storageBackendRegistry.reset();
}

/**
 * Resolve the backend for a caller. An explicit selector always wins; without
 * one the governed `default_chains.default` ordering picks the first
 * registered provider, falling back to `local-fs` then to whatever is
 * registered. Throws when nothing is registered — local-fs is installed by
 * importing `local-storage-backend.ts`, which entry-ledger does for callers.
 */
export function resolveStorageBackend(selector?: string): StorageBackend {
  const explicit = selector?.trim();
  if (explicit) {
    const backend = storageBackendRegistry.get(explicit);
    if (!backend) {
      throw new Error(
        `[STORAGE_BACKEND] unknown backend '${explicit}' — registered: ${
          storageBackendRegistry
            .list()
            .map((b) => b.id)
            .join(', ') || '(none)'
        }`
      );
    }
    return backend;
  }
  const chain = getSeamSelectionPolicy(STORAGE_BACKEND_SEAM)?.default_chains?.default ?? [
    LOCAL_STORAGE_BACKEND_ID,
  ];
  for (const id of chain) {
    const backend = storageBackendRegistry.get(id);
    if (backend) return backend;
  }
  const first = storageBackendRegistry.list()[0];
  if (first) return first;
  throw new Error(
    '[STORAGE_BACKEND] no backend registered — import @agent/core/storage/local-storage-backend (or register one)'
  );
}
