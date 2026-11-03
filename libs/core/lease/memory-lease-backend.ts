/**
 * memory lease backend — hermetic backend for tests and dry runs.
 *
 * `createMemoryLeaseBackend()` returns an isolated store; injecting it via
 * writer-lease options (`backend`) exercises the full fenced-lease path
 * without touching the filesystem. Importing this module also registers one
 * shared `memory` provider on the seam so `resolveLeaseBackend('memory')`
 * works — it is never in the governed default chain.
 *
 * Lock semantics: `withLock` serializes callbacks per namespace through a
 * promise queue (true mutex for async callers); `withLockSync` uses a held
 * set and throws on re-entry — a blocking sync mutex cannot exist in one
 * process, and silently re-entering would hide caller bugs that the real
 * file lock surfaces.
 */

import {
  registerLeaseBackend,
  type FencedLeaseRecord,
  type LeaseBackend,
} from './lease-backend.js';

export const MEMORY_LEASE_BACKEND_ID = 'memory';

class MemoryLeaseBackend implements LeaseBackend {
  readonly id = MEMORY_LEASE_BACKEND_ID;
  private readonly records = new Map<string, FencedLeaseRecord>();
  private readonly syncHeld = new Set<string>();
  private readonly queues = new Map<string, Promise<unknown>>();

  withLock<T>(namespace: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(namespace) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    this.queues.set(
      namespace,
      run.finally(() => {
        if (this.queues.get(namespace) === run) this.queues.delete(namespace);
      })
    );
    return run;
  }

  withLockSync<T>(namespace: string, fn: () => T): T {
    if (this.syncHeld.has(namespace)) {
      throw new Error(`[LEASE_BACKEND] sync lock re-entry for namespace '${namespace}'`);
    }
    this.syncHeld.add(namespace);
    try {
      return fn();
    } finally {
      this.syncHeld.delete(namespace);
    }
  }

  read(leaseKey: string): FencedLeaseRecord | undefined {
    const record = this.records.get(leaseKey);
    return record ? { ...record } : undefined;
  }

  write(leaseKey: string, record: FencedLeaseRecord): void {
    this.records.set(leaseKey, { ...record });
  }

  metricsPath(): null {
    return null;
  }
}

export function createMemoryLeaseBackend(): LeaseBackend {
  return new MemoryLeaseBackend();
}

registerLeaseBackend(createMemoryLeaseBackend(), {
  provenance: 'builtin',
  source: 'libs/core/lease/memory-lease-backend.ts',
});
