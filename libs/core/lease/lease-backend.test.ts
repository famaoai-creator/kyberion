// Step-2 distributed-runtime acceptance: the lease-backend seam resolves the
// governed default (local-file-lock), explicit selectors win, and
// writer-lease runs hermetically on the memory backend — acquire, busy
// rejection, fence increment, renewal and release all without the filesystem.
import { describe, expect, it } from 'vitest';
import {
  assertFencedWriterLease,
  getWriterLeaseMetrics,
  resetWriterLeaseMetrics,
  withFencedWriterLease,
  withFencedWriterLeaseSync,
  renewFencedWriterLeaseSync,
} from '../writer-lease.js';
import { LOCAL_LEASE_BACKEND_ID, getLeaseBackend, resolveLeaseBackend } from './lease-backend.js';
import './local-lease-backend.js';
import { MEMORY_LEASE_BACKEND_ID, createMemoryLeaseBackend } from './memory-lease-backend.js';
import {
  KV_LEASE_BACKEND_STUB_ID,
  createKvLeaseBackendStub,
  createSharedKvLeaseStore,
} from './kv-lease-backend.stub.js';

describe('lease-backend seam', () => {
  it('resolves the governed default to local-file-lock', () => {
    expect(resolveLeaseBackend().id).toBe(LOCAL_LEASE_BACKEND_ID);
  });

  it('resolves an explicit selector over the default', () => {
    expect(resolveLeaseBackend(MEMORY_LEASE_BACKEND_ID).id).toBe(MEMORY_LEASE_BACKEND_ID);
  });

  it('throws for an unknown selector', () => {
    expect(() => resolveLeaseBackend('no-such-backend')).toThrow(
      /unknown backend 'no-such-backend'/
    );
  });

  it('keeps memory out of the default chain (registered but never auto-selected)', () => {
    expect(getLeaseBackend(MEMORY_LEASE_BACKEND_ID)).toBeDefined();
    expect(resolveLeaseBackend().id).toBe(LOCAL_LEASE_BACKEND_ID);
  });

  it('keeps kv-lock-stub out of the default chain (registered but never auto-selected)', () => {
    expect(getLeaseBackend(KV_LEASE_BACKEND_STUB_ID)).toBeDefined();
    expect(resolveLeaseBackend(KV_LEASE_BACKEND_STUB_ID).id).toBe(KV_LEASE_BACKEND_STUB_ID);
    expect(resolveLeaseBackend().id).toBe(LOCAL_LEASE_BACKEND_ID);
  });
});

describe('writer-lease on a kv-lock stub (distributed contract)', () => {
  it('rejects withLockSync — distributed backends have no blocking sync mutex', () => {
    const backend = createKvLeaseBackendStub({ nodeId: 'a' });
    expect(() => backend.withLockSync('ns', () => 1)).toThrow(/sync lock unsupported/);
    expect(() =>
      withFencedWriterLeaseSync<void>({
        resourceId: 'kv-sync',
        ownerId: 'owner-a',
        leasePath: '/leases/kv-sync.json',
        backend,
        fn: () => undefined,
      })
    ).toThrow(/sync lock unsupported/);
  });

  it('excludes two nodes that share one KV store via async withLock', async () => {
    const store = createSharedKvLeaseStore();
    const nodeA = createKvLeaseBackendStub({ store, nodeId: 'a', lockDelayMs: 2 });
    const nodeB = createKvLeaseBackendStub({ store, nodeId: 'b' });
    const key = '/leases/kv-shared.json';
    const order: string[] = [];
    // Deterministic gates instead of real-time sleeps: A holds the lock until
    // B has been started, so B must wait rather than interleave.
    let markEntered!: () => void;
    const aEntered = new Promise<void>((resolve) => (markEntered = resolve));
    let releaseA!: () => void;
    const aReleased = new Promise<void>((resolve) => (releaseA = resolve));

    const first = withFencedWriterLease<void>({
      resourceId: 'kv-shared',
      ownerId: 'owner-a',
      leasePath: key,
      backend: nodeA,
      fn: async () => {
        order.push('a-enter');
        markEntered();
        await aReleased;
        order.push('a-exit');
      },
    });

    // Start B while A still holds the namespace lock — must not interleave.
    await aEntered;
    const second = withFencedWriterLease<void>({
      resourceId: 'kv-shared',
      ownerId: 'owner-b',
      leasePath: key,
      backend: nodeB,
      fn: async () => {
        order.push('b-enter');
        order.push('b-exit');
      },
    });

    // Let B reach the lock and queue behind A before A finishes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(order).toEqual(['a-enter']);
    releaseA();
    await Promise.all([first, second]);
    expect(order).toEqual(['a-enter', 'a-exit', 'b-enter', 'b-exit']);
    expect(store.records.get(key)?.fence).toBeGreaterThanOrEqual(1);
  });
});

describe('writer-lease on a memory backend', () => {
  it('acquires, protects the write and releases the fence', () => {
    resetWriterLeaseMetrics();
    const backend = createMemoryLeaseBackend();
    const events: string[] = [];
    const result = withFencedWriterLeaseSync<string>({
      resourceId: 'r1',
      ownerId: 'owner-a',
      leasePath: '/leases/r1.json',
      backend,
      onEvent: (e) => events.push(e.type),
      fn: (lease) => {
        expect(lease.fence).toBe(1);
        assertFencedWriterLease('/leases/r1.json', lease, Date.now(), backend);
        return 'written';
      },
    });
    expect(result).toBe('written');
    expect(events).toEqual(['acquired', 'released']);
    // Fence preserved after release.
    const record = backend.read('/leases/r1.json');
    expect(record?.fence).toBe(1);
    expect(record?.expires_at_ms).toBe(0);
  });

  it('rejects a second owner while a live lease is held', () => {
    const backend = createMemoryLeaseBackend();
    const key = '/leases/contended.json';
    expect(() =>
      withFencedWriterLeaseSync<void>({
        resourceId: 'r2',
        ownerId: 'owner-a',
        leasePath: key,
        backend,
        fn: () => {
          // Re-entrant sync lock + live lease: another owner cannot enter.
          withFencedWriterLeaseSync<void>({
            resourceId: 'r2',
            ownerId: 'owner-b',
            leasePath: key,
            backend,
            fn: () => undefined,
          });
        },
      })
    ).toThrow(/lock re-entry/);
  });

  it('increments the fence across owners after expiry', () => {
    const backend = createMemoryLeaseBackend();
    const key = '/leases/fence.json';
    let t = 1_000;
    const now = () => t;
    withFencedWriterLeaseSync<void>({
      resourceId: 'r3',
      ownerId: 'owner-a',
      leasePath: key,
      ttlMs: 100,
      nowMs: now,
      backend,
      fn: () => undefined,
    });
    // After release the fence is preserved; a later owner gets fence+1.
    t += 10;
    let secondFence = 0;
    withFencedWriterLeaseSync<void>({
      resourceId: 'r3',
      ownerId: 'owner-b',
      leasePath: key,
      ttlMs: 100,
      nowMs: now,
      backend,
      fn: (lease) => {
        secondFence = lease.fence;
      },
    });
    expect(secondFence).toBe(2);
  });

  it('renews a held lease without changing its fence', () => {
    const backend = createMemoryLeaseBackend();
    const key = '/leases/renew.json';
    let t = 1_000;
    const now = () => t;
    // A live lease still held by its owner (withFencedWriterLeaseSync always
    // releases on exit, so seed the record directly).
    const lease = {
      resource_id: 'r4',
      owner_id: 'owner-a',
      fence: 1,
      expires_at_ms: 1_500,
    };
    backend.write(key, lease);
    t += 100;
    const renewed = renewFencedWriterLeaseSync({
      resourceId: 'r4',
      ownerId: 'owner-a',
      leasePath: key,
      lease,
      ttlMs: 500,
      nowMs: now,
      backend,
    });
    expect(renewed.fence).toBe(lease.fence);
    expect(renewed.expires_at_ms).toBe(1_600);
  });

  it('rejects renewal for a released lease', () => {
    const backend = createMemoryLeaseBackend();
    const key = '/leases/released.json';
    const lease = withFencedWriterLeaseSync({
      resourceId: 'r5',
      ownerId: 'owner-a',
      leasePath: key,
      backend,
      fn: (l) => l,
    });
    expect(() =>
      renewFencedWriterLeaseSync({
        resourceId: 'r5',
        ownerId: 'owner-a',
        leasePath: key,
        lease,
        backend,
      })
    ).toThrow(/renewal rejected/);
  });

  it('supports the async withFencedWriterLease path', async () => {
    const backend = createMemoryLeaseBackend();
    const result = await withFencedWriterLease<string>({
      resourceId: 'r6',
      ownerId: 'owner-a',
      leasePath: '/leases/async.json',
      backend,
      fn: async (lease) => `f${lease.fence}`,
    });
    expect(result).toBe('f1');
  });

  it('reports in-memory metrics without durable side-channel writes', () => {
    resetWriterLeaseMetrics();
    const backend = createMemoryLeaseBackend();
    withFencedWriterLeaseSync<void>({
      resourceId: 'r7',
      ownerId: 'owner-a',
      leasePath: '/leases/metrics.json',
      backend,
      fn: () => undefined,
    });
    const metrics = getWriterLeaseMetrics('r7');
    expect(metrics[0]?.acquired).toBe(1);
    expect(metrics[0]?.released).toBe(1);
    // memory backend has no metricsPath — no durable file was attempted.
    expect(backend.metricsPath?.('/leases/metrics.json')).toBeNull();
  });
});
