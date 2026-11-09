import { describe, expect, it, vi } from 'vitest';
import { createMemoryLeaseBackend } from './memory-lease-backend.js';
import { createKvLeaseBackendStub, createSharedKvLeaseStore } from './kv-lease-backend.stub.js';
import { withFencedWriterLease, withFencedWriterLeaseSync } from './writer-lease.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('memory lease backend mixed-mode exclusion', () => {
  it('reserves queued async admission before the callback starts', async () => {
    const backend = createMemoryLeaseBackend();
    const release = deferred();
    let started = false;
    const task = backend.withLock('resource', async () => {
      started = true;
      await release.promise;
    });
    try {
      expect(started).toBe(false);
      expect(() => backend.withLockSync('resource', () => 'overlap')).toThrow(/async lock/);
      expect(backend.withLockSync('independent', () => 'free')).toBe('free');
    } finally {
      release.resolve();
      await task;
    }
    expect(backend.withLockSync('resource', () => 'released')).toBe('released');
  });

  it('refuses sync admission for the entire active async callback', async () => {
    const backend = createMemoryLeaseBackend();
    const entered = deferred();
    const release = deferred();
    const task = backend.withLock('resource', async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try {
      expect(() => backend.withLockSync('resource', () => 'overlap')).toThrow(/async lock/);
      expect(await backend.withLock('independent', async () => 'free')).toBe('free');
    } finally {
      release.resolve();
      await task;
    }
    expect(backend.withLockSync('resource', () => 'released')).toBe('released');
  });

  it('keeps queued successors exclusive and FIFO as earlier callbacks settle', async () => {
    const backend = createMemoryLeaseBackend();
    const releases = [deferred(), deferred(), deferred()];
    const entries = [deferred(), deferred(), deferred()];
    const order: number[] = [];
    const tasks = releases.map((release, index) =>
      backend.withLock('resource', async () => {
        order.push(index);
        entries[index]!.resolve();
        await release.promise;
      })
    );
    try {
      for (let index = 0; index < tasks.length; index++) {
        await entries[index]!.promise;
        expect(order).toEqual(Array.from({ length: index + 1 }, (_, n) => n));
        expect(() => backend.withLockSync('resource', () => 'overlap')).toThrow(/async lock/);
        releases[index]!.resolve();
        await tasks[index];
      }
    } finally {
      releases.forEach((release) => release.resolve());
      await Promise.all(tasks);
    }
    expect(backend.withLockSync('resource', () => 'released')).toBe('released');
  });

  it('preserves sync re-entry refusal and permits async work queued inside sync after exit', async () => {
    const backend = createMemoryLeaseBackend();
    const order: string[] = [];
    let queued!: Promise<string>;
    backend.withLockSync('resource', () => {
      order.push('sync');
      expect(() => backend.withLockSync('resource', () => undefined)).toThrow(/lock re-entry/);
      queued = backend.withLock('resource', async () => {
        order.push('async');
        return 'finished';
      });
      expect(order).toEqual(['sync']);
    });
    expect(await queued).toBe('finished');
    expect(order).toEqual(['sync', 'async']);
    expect(backend.withLockSync('resource', () => 'released')).toBe('released');
  });

  it('preserves rejection identity and admits a queued successor and later sync writer', async () => {
    const backend = createMemoryLeaseBackend();
    const failure = new Error('callback failed');
    const failed = backend.withLock('resource', async () => {
      throw failure;
    });
    const rejection = expect(failed).rejects.toBe(failure);
    const successor = backend.withLock('resource', async () => 'recovered');
    await rejection;
    expect(await successor).toBe('recovered');
    expect(backend.withLockSync('resource', () => 'released')).toBe('released');
  });

  it('clears a rejected last holder before admitting a sync writer', async () => {
    const backend = createMemoryLeaseBackend();
    const failure = new Error('last holder failed');
    await expect(
      backend.withLock('resource', async () => {
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(backend.withLockSync('resource', () => 'recovered')).toBe('recovered');
  });

  it('releases sync ownership when a callback throws before later async admission', async () => {
    const backend = createMemoryLeaseBackend();
    const failure = new Error('sync holder failed');
    expect(() =>
      backend.withLockSync('resource', () => {
        throw failure;
      })
    ).toThrow(failure);
    expect(await backend.withLock('resource', async () => 'recovered')).toBe('recovered');
    expect(backend.withLockSync('resource', () => 'released')).toBe('released');
  });

  it('keeps an expired writer exclusive until its callback actually stops', async () => {
    const backend = createMemoryLeaseBackend();
    const entered = deferred();
    const release = deferred();
    let now = 100;
    let secondEntered = false;
    const first = withFencedWriterLease({
      resourceId: 'expiry-overlap',
      ownerId: 'a',
      leasePath: '/leases/expiry-overlap.json',
      backend,
      ttlMs: 10,
      nowMs: () => now,
      fn: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const expired = expect(first).rejects.toThrow(/WRITER_LEASE_FENCED/);
    await entered.promise;
    now = 111;
    try {
      expect(() =>
        withFencedWriterLeaseSync({
          resourceId: 'expiry-overlap',
          ownerId: 'b',
          leasePath: '/leases/expiry-overlap.json',
          backend,
          ttlMs: 10,
          nowMs: () => now,
          fn: () => {
            secondEntered = true;
          },
        })
      ).toThrow(/async lock/);
      expect(secondEntered).toBe(false);
    } finally {
      release.resolve();
      await expired;
    }
    expect(
      withFencedWriterLeaseSync({
        resourceId: 'expiry-overlap',
        ownerId: 'b',
        leasePath: '/leases/expiry-overlap.json',
        backend,
        ttlMs: 10,
        nowMs: () => now,
        fn: (lease) => lease.fence,
      })
    ).toBe(2);
  });
});

describe('KV lease backend queue settlement', () => {
  it('applies acquisition delay after a rejected predecessor as well as a successful one', async () => {
    vi.useFakeTimers();
    try {
      const store = createSharedKvLeaseStore();
      const backend = createKvLeaseBackendStub({ store, lockDelayMs: 5 });
      const failure = new Error('delayed predecessor failed');
      const order: string[] = [];
      const first = backend.withLock('resource', async () => {
        order.push('first');
        throw failure;
      });
      const rejected = expect(first).rejects.toBe(failure);
      const second = backend.withLock('resource', async () => {
        order.push('second');
      });
      await vi.advanceTimersByTimeAsync(4);
      expect(order).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(order).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(4);
      expect(order).toEqual(['first']);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(order).toEqual(['first', 'second']);
      expect(store.queues.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  for (const reject of [false, true]) {
    it(`settles and removes the last queue tail after callback ${reject ? 'failure' : 'success'}`, async () => {
      const store = createSharedKvLeaseStore();
      const backend = createKvLeaseBackendStub({ store });
      const failure = new Error('KV callback failed');
      const task = backend.withLock('resource', async () => {
        if (reject) throw failure;
        return 'value';
      });
      const tail = store.queues.get('resource');
      expect(tail).toBeDefined();
      // Attach to both promises immediately: even the intentionally broken
      // implementation's cleanup rejection is observed during the red run.
      const tailSettled = expect(tail).resolves.toBeUndefined();
      if (reject) await expect(task).rejects.toBe(failure);
      else expect(await task).toBe('value');
      await tailSettled;
      expect(store.queues.size).toBe(0);
    });
  }

  it('does not let an earlier completion erase a later node queue tail', async () => {
    const store = createSharedKvLeaseStore();
    const a = createKvLeaseBackendStub({ store, nodeId: 'a' });
    const b = createKvLeaseBackendStub({ store, nodeId: 'b' });
    const releaseA = deferred();
    const releaseB = deferred();
    const enteredB = deferred();
    const first = a.withLock('resource', async () => {
      await releaseA.promise;
    });
    const second = b.withLock('resource', async () => {
      enteredB.resolve();
      await releaseB.promise;
      return 'second';
    });
    const lastTail = store.queues.get('resource');
    try {
      releaseA.resolve();
      await first;
      await enteredB.promise;
      expect(store.queues.get('resource')).toBe(lastTail);
      expect(await b.withLock('independent', async () => 'free')).toBe('free');
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await Promise.all([first, second]);
    }
    expect(store.queues.size).toBe(0);
  });

  it('continues the shared FIFO after a rejected callback without poisoning cleanup', async () => {
    const store = createSharedKvLeaseStore();
    const a = createKvLeaseBackendStub({ store, nodeId: 'a' });
    const b = createKvLeaseBackendStub({ store, nodeId: 'b' });
    const failure = new Error('first node failed');
    const first = a.withLock('resource', async () => {
      throw failure;
    });
    const firstTail = store.queues.get('resource')!;
    const firstTailSettled = expect(firstTail).resolves.toBeUndefined();
    const rejection = expect(first).rejects.toBe(failure);
    const second = b.withLock('resource', async () => 'second');
    await rejection;
    expect(await second).toBe('second');
    await firstTailSettled;
    expect(store.queues.size).toBe(0);
  });
});
