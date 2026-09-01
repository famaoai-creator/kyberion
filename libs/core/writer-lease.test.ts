import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import {
  assertFencedWriterLease,
  getWriterLeaseMetrics,
  loadWriterLeaseMetrics,
  resetWriterLeaseMetrics,
  renewFencedWriterLease,
  renewFencedWriterLeaseSync,
  writerLeaseMetricsPath,
  withFencedWriterLease,
  withFencedWriterLeaseSync,
} from './writer-lease.js';

const root = path.resolve(`active/shared/tmp/writer-lease-${process.pid}`);
const leasePath = path.join(root, 'coordination', 'writer-lease.json');

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
  resetWriterLeaseMetrics();
});

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
    const events: string[] = [];
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
        onEvent: (event) => events.push(event.type),
        fn: () => undefined,
      })
    ).rejects.toThrow('WRITER_LEASE_BUSY');
    expect(events).toEqual(['rejected']);
    expect(getWriterLeaseMetrics('mission:PI16-B')).toMatchObject([
      { resource_id: 'mission:PI16-B', rejected: 1 },
    ]);

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

  it('rejects a symlinked lease leaf before reading its contents', async () => {
    const targetPath = path.join(root, 'lease-target.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(targetPath, '{}');
    safeSymlinkSync(targetPath, leasePath);

    await expect(
      withFencedWriterLease({
        resourceId: 'mission:PI16-SYMLINK',
        ownerId: 'owner-symlink',
        leasePath,
        fn: () => undefined,
      })
    ).rejects.toThrow('[RESOURCE_PATH_SYMLINK]');
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

  it('aggregates lifecycle events by resource without exposing lease payloads', async () => {
    const resourceId = 'mission:PI16-METRICS';
    await withFencedWriterLease({
      resourceId,
      ownerId: 'owner-metrics',
      leasePath,
      fn: () => undefined,
    });

    expect(getWriterLeaseMetrics(resourceId)).toEqual([
      {
        resource_id: resourceId,
        acquired: 1,
        renewed: 0,
        released: 1,
        rejected: 0,
      },
    ]);
    expect(getWriterLeaseMetrics(resourceId)[0]).not.toHaveProperty('owner_id');
    resetWriterLeaseMetrics();
    expect(loadWriterLeaseMetrics(writerLeaseMetricsPath(leasePath), resourceId)).toEqual([
      {
        resource_id: resourceId,
        acquired: 1,
        renewed: 0,
        released: 1,
        rejected: 0,
      },
    ]);
    expect(
      String(safeReadFile(writerLeaseMetricsPath(leasePath), { encoding: 'utf8' }))
    ).not.toContain('owner-metrics');
  });
});
