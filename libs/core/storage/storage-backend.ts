/**
 * storage-backend seam — the pluggable persistence extension point.
 *
 * Kyberion's sovereign state (ledgers, inboxes, evidence) is written through a
 * small POSIX-shaped surface. Providers register by id (`local-fs` builtin,
 * `memory` for hermetic tests, object-storage adapters later); selection order
 * is governed data (`seam-provider-selection/storage-backend.json`
 * `default_chains`), never a hard-coded preference list.
 *
 * The canonical seam contract is **async** (`AsyncStorageBackend`) so
 * Promise-based object stores (S3/R2/GCS) can meet durability without a silent
 * fire-and-forget. Sync implementations (`SyncStorageBackend`: local-fs,
 * memory) wrap once via `toAsyncStorageBackend` before registration — callers
 * always `await` and never drop durability.
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
 * Sync POSIX-subset surface for local disk / in-memory stores. Prefer
 * implementing this and registering through `toAsyncStorageBackend` rather
 * than hand-rolling Promise wrappers.
 */
export interface SyncStorageBackend {
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

/**
 * Canonical seam contract — every registered provider is async so remote
 * object stores can await durability instead of being forced through a sync
 * facade that would silently drop writes.
 */
export interface AsyncStorageBackend {
  readonly id: string;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<StorageStat | null>;
  mkdir(path: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  readLines(path: string): AsyncIterable<StorageTextLine>;
  list(path: string): Promise<string[]>;
}

/**
 * @deprecated Use `AsyncStorageBackend` (seam) or `SyncStorageBackend` (local
 * adapters). Alias kept so existing type imports keep compiling during the
 * migration; it resolves to the async contract.
 */
export type StorageBackend = AsyncStorageBackend;

const ASYNC_BRAND = Symbol.for('kyberion.storage.async');

type BrandedAsync = AsyncStorageBackend & { readonly [ASYNC_BRAND]?: true };

/** Wrap a sync backend so it satisfies the async seam without dropping awaits. */
export function toAsyncStorageBackend(sync: SyncStorageBackend): AsyncStorageBackend {
  const asyncBackend: BrandedAsync = {
    id: sync.id,
    [ASYNC_BRAND]: true,
    async exists(filePath) {
      return sync.exists(filePath);
    },
    async stat(filePath) {
      return sync.stat(filePath);
    },
    async mkdir(dirPath) {
      sync.mkdir(dirPath);
    },
    async append(filePath, data) {
      sync.append(filePath, data);
    },
    async *readLines(filePath) {
      for (const line of sync.readLines(filePath)) yield line;
    },
    async list(dirPath) {
      return sync.list(dirPath);
    },
  };
  return asyncBackend;
}

function isSyncReadLines(backend: SyncStorageBackend | AsyncStorageBackend): boolean {
  // Sync providers return a plain Iterable / Generator; async providers and
  // toAsync wrappers use AsyncFunction / AsyncGeneratorFunction.
  const sample = backend.readLines;
  return (
    typeof sample === 'function' &&
    sample.constructor.name !== 'AsyncFunction' &&
    sample.constructor.name !== 'AsyncGeneratorFunction'
  );
}

/** True when `backend` already satisfies the async seam (branded or native). */
export function isAsyncStorageBackend(
  backend: SyncStorageBackend | AsyncStorageBackend
): backend is AsyncStorageBackend {
  return (backend as BrandedAsync)[ASYNC_BRAND] === true || !isSyncReadLines(backend);
}

/** Normalize either shape to the async seam contract. */
export function asAsyncStorageBackend(
  backend: SyncStorageBackend | AsyncStorageBackend
): AsyncStorageBackend {
  if ((backend as BrandedAsync)[ASYNC_BRAND] === true) return backend as AsyncStorageBackend;
  if (isSyncReadLines(backend)) return toAsyncStorageBackend(backend as SyncStorageBackend);
  return backend as AsyncStorageBackend;
}

const storageBackendRegistry = createProviderRegistry<AsyncStorageBackend>({
  seam: STORAGE_BACKEND_SEAM,
  owner: 'libs/core/storage/storage-backend.ts',
  source: 'storage-backend-extension',
  missingIdError: 'StorageBackend must have a non-empty id',
});

export function registerStorageBackend(
  backend: AsyncStorageBackend | SyncStorageBackend,
  metadata?: SeamProviderMetadata
): () => void {
  return storageBackendRegistry.register(asAsyncStorageBackend(backend), metadata);
}

export function listStorageBackends(): AsyncStorageBackend[] {
  return storageBackendRegistry.list();
}

export function getStorageBackend(id: string): AsyncStorageBackend | undefined {
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
export function resolveStorageBackend(selector?: string): AsyncStorageBackend {
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
