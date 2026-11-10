/**
 * Contract stub for a Redis/KV-style distributed lease backend.
 *
 * Proves the lease-backend seam can host a multi-node exclusion model without
 * shipping a Redis/DynamoDB SDK:
 *   - `withLock` serializes per namespace through a shared async queue (the
 *     stand-in for Redlock / conditional-put fencing of the mutex itself);
 *   - `withLockSync` is unsupported — a distributed store cannot offer a
 *     blocking sync mutex across runtimes, so callers must use the async path;
 *   - multiple stub instances can share one store to simulate two workers on
 *     the same KV cluster.
 *
 * Not in the governed default chain. Tests construct it via
 * `createKvLeaseBackendStub()` or resolve `kv-lock-stub` after import.
 */

import {
  cloneFencedLeaseRecord,
  registerLeaseBackend,
  type FencedLeaseRecord,
  type LeaseBackend,
} from './lease-backend.js';

export const KV_LEASE_BACKEND_STUB_ID = 'kv-lock-stub';

/** Shared cluster state — pass the same store to two stubs to simulate two nodes. */
export interface SharedKvLeaseStore {
  readonly records: Map<string, FencedLeaseRecord>;
  readonly queues: Map<string, Promise<unknown>>;
}

export function createSharedKvLeaseStore(): SharedKvLeaseStore {
  return { records: new Map(), queues: new Map() };
}

export interface KvLeaseBackendStubOptions {
  /** Shared cluster. Defaults to an isolated store for this instance. */
  store?: SharedKvLeaseStore;
  /** Artificial lock-acquisition delay — demonstrates awaited distributed exclusion. */
  lockDelayMs?: number;
  /** Distinct node id for debugging; does not affect exclusion. */
  nodeId?: string;
}

/**
 * Build a KV-style lease backend. Prefer injecting via writer-lease
 * `{ backend }` rather than relying on seam resolution in production.
 */
export function createKvLeaseBackendStub(options: KvLeaseBackendStubOptions = {}): LeaseBackend {
  const store = options.store ?? createSharedKvLeaseStore();
  const lockDelayMs = Math.max(0, options.lockDelayMs ?? 0);
  const nodeId = options.nodeId?.trim() || 'node';

  return {
    id: KV_LEASE_BACKEND_STUB_ID,
    async withLock<T>(namespace: string, fn: () => Promise<T>): Promise<T> {
      const previous = store.queues.get(namespace) ?? Promise.resolve();
      const execute = async (): Promise<T> => {
        if (lockDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, lockDelayMs));
        }
        return fn();
      };
      const run = previous.then(execute, execute);
      // Keep caller errors on `run`, never on the shared queue tail. A
      // finishing predecessor must not erase a later node's reservation.
      const release = (): void => {
        if (store.queues.get(namespace) === tail) store.queues.delete(namespace);
      };
      const tail = run.then(release, release);
      store.queues.set(namespace, tail);
      return run;
    },
    withLockSync<T>(_namespace: string, _fn: () => T): T {
      throw new Error(
        `[LEASE_BACKEND] sync lock unsupported on distributed backend '${KV_LEASE_BACKEND_STUB_ID}' ` +
          `(node=${nodeId}) — use withLock (async) so exclusion can span runtimes`
      );
    },
    read(leaseKey: string): FencedLeaseRecord | undefined {
      const record = store.records.get(leaseKey);
      return record ? cloneFencedLeaseRecord(record) : undefined;
    },
    write(leaseKey: string, record: FencedLeaseRecord): void {
      store.records.set(leaseKey, cloneFencedLeaseRecord(record));
    },
    metricsPath(): null {
      return null;
    },
  };
}

/** Shared builtin for `resolveLeaseBackend('kv-lock-stub')` — never auto-selected. */
registerLeaseBackend(createKvLeaseBackendStub({ nodeId: 'builtin' }), {
  provenance: 'builtin',
  source: 'libs/core/lease/kv-lease-backend.stub.ts',
});
