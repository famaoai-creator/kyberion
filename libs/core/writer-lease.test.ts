import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { safeRmSync } from './secure-io.js';
import {
  assertFencedWriterLease,
  renewFencedWriterLease,
  renewFencedWriterLeaseSync,
  withFencedWriterLease,
  withFencedWriterLeaseSync,
} from './writer-lease.js';

const root = path.resolve(`active/shared/tmp/writer-lease-${process.pid}`);
const leasePath = path.join(root, 'coordination', 'writer-lease.json');

afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('withFencedWriterLease (PI-16)', () => {
  it('increments the fence and releases an expired lease after a successful write', async () => {
    let clock = 1_000;
    const first = await withFencedWriterLease({
      resourceId: 'mission:PI16-A',
      ownerId: 'owner-a',
      leasePath,
      nowMs: () => clock,
      fn: (lease) => lease,
    });
    expect(first).toMatchObject({ owner_id: 'owner-a', fence: 1, expires_at_ms: 31_000 });

    clock = 2_000;
    const second = await withFencedWriterLease({
      resourceId: 'mission:PI16-A',
      ownerId: 'owner-b',
      leasePath,
      nowMs: () => clock,
      fn: (lease) => lease,
    });
    expect(second).toMatchObject({ owner_id: 'owner-b', fence: 2, expires_at_ms: 32_000 });
  });

  it('rejects a live lease held by another owner and corrupt records', async () => {
    let clock = 5_000;
    const { safeWriteFile } = await import('./secure-io.js');
    safeWriteFile(
      leasePath,
      JSON.stringify({
        resource_id: 'mission:PI16-B',
        owner_id: 'owner-a',
        fence: 4,
        expires_at_ms: clock + 1_000,
      })
    );
    await expect(
      withFencedWriterLease({
        resourceId: 'mission:PI16-B',
        ownerId: 'owner-b',
        leasePath,
        nowMs: () => clock,
        fn: () => undefined,
      })
    ).rejects.toThrow('WRITER_LEASE_BUSY');

    safeWriteFile(leasePath, '{broken');
    await expect(
      withFencedWriterLease({
        resourceId: 'mission:PI16-B',
        ownerId: 'owner-c',
        leasePath,
        nowMs: () => clock,
        fn: () => undefined,
      })
    ).rejects.toThrow('WRITER_LEASE_CORRUPT');
  });

  it('rejects a stale owner/fence token even when the lease record is valid', async () => {
    const { safeWriteFile } = await import('./secure-io.js');
    safeWriteFile(
      leasePath,
      JSON.stringify({
        resource_id: 'mission:PI16-C',
        owner_id: 'owner-current',
        fence: 8,
        expires_at_ms: 20_000,
      })
    );
    expect(() =>
      assertFencedWriterLease(
        leasePath,
        {
          resource_id: 'mission:PI16-C',
          owner_id: 'owner-zombie',
          fence: 7,
          expires_at_ms: 20_000,
        },
        10_000
      )
    ).toThrow('WRITER_LEASE_FENCED');
  });

  it('supports synchronous fenced writes for journal callbacks', () => {
    const result = withFencedWriterLeaseSync({
      resourceId: 'mission:PI16-SYNC',
      ownerId: 'owner-sync',
      leasePath,
      fn: (lease) => `${lease.owner_id}:${lease.fence}`,
    });
    expect(result).toBe('owner-sync:1');
  });

  it('renews a live lease without changing its fencing token', async () => {
    let clock = 10_000;
    const { safeWriteFile } = await import('./secure-io.js');
    const acquired = {
      resource_id: 'mission:PI16-RENEW',
      owner_id: 'owner-renew',
      fence: 1,
      expires_at_ms: 11_000,
    } as const;
    safeWriteFile(leasePath, `${JSON.stringify(acquired)}\n`);

    clock = 10_500;
    const renewed = await renewFencedWriterLease({
      resourceId: 'mission:PI16-RENEW',
      ownerId: 'owner-renew',
      leasePath,
      lease: acquired,
      ttlMs: 2_000,
      nowMs: () => clock,
    });
    expect(renewed).toMatchObject({ owner_id: 'owner-renew', fence: 1, expires_at_ms: 12_500 });

    clock = 11_000;
    const renewedSync = renewFencedWriterLeaseSync({
      resourceId: 'mission:PI16-RENEW',
      ownerId: 'owner-renew',
      leasePath,
      lease: renewed,
      ttlMs: 3_000,
      nowMs: () => clock,
    });
    expect(renewedSync).toMatchObject({ fence: 1, expires_at_ms: 14_000 });
  });

  it('fails renewal after the lease expires and exposes lifecycle events', async () => {
    let clock = 20_000;
    const events: string[] = [];
    const acquired = await withFencedWriterLease({
      resourceId: 'mission:PI16-EXPIRED',
      ownerId: 'owner-expired',
      leasePath,
      ttlMs: 1_000,
      nowMs: () => clock,
      onEvent: (event) => events.push(event.type),
      fn: (lease) => lease,
    });

    clock = 21_001;
    await expect(
      renewFencedWriterLease({
        resourceId: 'mission:PI16-EXPIRED',
        ownerId: 'owner-expired',
        leasePath,
        lease: acquired,
        ttlMs: 1_000,
        nowMs: () => clock,
        onEvent: (event) => events.push(event.type),
      })
    ).rejects.toThrow('WRITER_LEASE_FENCED');
    expect(events).toEqual(['acquired', 'released', 'rejected']);
  });

  it('can auto-renew while the protected async callback is still running', async () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      let release!: () => void;
      const pending = withFencedWriterLease({
        resourceId: 'mission:PI16-AUTO-RENEW',
        ownerId: 'owner-auto-renew',
        leasePath,
        ttlMs: 1_000,
        renewEveryMs: 100,
        nowMs: () => 50_000,
        onEvent: (event) => events.push(event.type),
        fn: () => new Promise<void>((resolve) => (release = resolve)),
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(events).toContain('renewed');
      release();
      await pending;
      expect(events.at(-1)).toBe('released');
    } finally {
      vi.useRealTimers();
    }
  });
});
