import { describe, expect, it } from 'vitest';
import { runtimeSupervisor } from './runtime-supervisor.js';

describe('runtime-supervisor core', () => {
  it('reaps idle resources with idle shutdown policy', async () => {
    let cleaned = false;
    const record = runtimeSupervisor.register({
      resourceId: 'test-idle-resource',
      kind: 'pty',
      ownerId: 'owner-1',
      ownerType: 'test',
      idleTimeoutMs: 1000,
      shutdownPolicy: 'idle',
      cleanup: () => {
        cleaned = true;
      },
    });

    const reaped = await runtimeSupervisor.reapIdle(record.lastActiveAt + 1001);

    expect(reaped).toContain('test-idle-resource');
    expect(cleaned).toBe(true);
    expect(runtimeSupervisor.get('test-idle-resource')).toBeUndefined();
  });

  it('does not reap manual resources', async () => {
    const record = runtimeSupervisor.register({
      resourceId: 'test-manual-resource',
      kind: 'agent',
      ownerId: 'owner-2',
      ownerType: 'test',
      idleTimeoutMs: 1000,
      shutdownPolicy: 'manual',
    });

    const reaped = await runtimeSupervisor.reapIdle(record.lastActiveAt + 5000);

    expect(reaped).not.toContain('test-manual-resource');
    expect(runtimeSupervisor.get('test-manual-resource')?.resourceId).toBe('test-manual-resource');
    runtimeSupervisor.unregister('test-manual-resource');
  });

  it('retains the record and reports the error when cleanup fails', async () => {
    let attempts = 0;
    runtimeSupervisor.register({
      resourceId: 'test-failing-cleanup',
      kind: 'service',
      ownerId: 'owner-3',
      ownerType: 'test',
      cleanup: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('socket still draining');
      },
    });

    // First attempt fails: the record stays owned, the error is inspectable.
    await expect(runtimeSupervisor.cleanup('test-failing-cleanup', 'test')).resolves.toBe(
      'retained'
    );
    const retained = runtimeSupervisor.get('test-failing-cleanup');
    expect(retained).toBeDefined();
    expect(retained?.lastCleanupError?.error).toBe('socket still draining');
    expect(retained?.lastCleanupError?.reason).toBe('test');

    // A retry completes cleanup and releases ownership.
    await expect(runtimeSupervisor.cleanup('test-failing-cleanup', 'test')).resolves.toBe(
      'removed'
    );
    expect(runtimeSupervisor.get('test-failing-cleanup')).toBeUndefined();
    expect(attempts).toBe(2);
  });

  it('reports absent when cleaning an unknown resource', async () => {
    await expect(runtimeSupervisor.cleanup('never-registered', 'test')).resolves.toBe('absent');
  });

  it('does not list a resource whose idle cleanup failed as reaped', async () => {
    let attempts = 0;
    const record = runtimeSupervisor.register({
      resourceId: 'test-idle-failing',
      kind: 'pty',
      ownerId: 'owner-4',
      ownerType: 'test',
      idleTimeoutMs: 1000,
      shutdownPolicy: 'idle',
      cleanup: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporarily stuck');
      },
    });

    const first = await runtimeSupervisor.reapIdle(record.lastActiveAt + 1001);
    expect(first).not.toContain('test-idle-failing');
    expect(runtimeSupervisor.get('test-idle-failing')).toBeDefined();

    const second = await runtimeSupervisor.reapIdle(record.lastActiveAt + 1001);
    expect(second).toContain('test-idle-failing');
    expect(runtimeSupervisor.get('test-idle-failing')).toBeUndefined();
  });

  it('keeps a registered pid start marker on the record', () => {
    runtimeSupervisor.register({
      resourceId: 'test-marker-record',
      kind: 'pty',
      ownerId: 'owner-5',
      ownerType: 'test',
      pid: 424242,
      pidStartMarker: 'marker-abc',
    });
    const record = runtimeSupervisor.get('test-marker-record');
    expect(record?.pid).toBe(424242);
    expect(record?.pidStartMarker).toBe('marker-abc');
    runtimeSupervisor.unregister('test-marker-record');
  });

  it('does not stop detached services during owner signal cleanup', async () => {
    let cleaned = false;
    runtimeSupervisor.register({
      resourceId: 'test-detached-service',
      kind: 'service',
      ownerId: 'test-owner',
      ownerType: 'cli',
      shutdownPolicy: 'detached',
      cleanup: () => {
        cleaned = true;
      },
    });

    await expect(runtimeSupervisor.cleanupAll('signal:143')).resolves.not.toContain(
      'test-detached-service'
    );
    expect(cleaned).toBe(false);
    expect(runtimeSupervisor.get('test-detached-service')).toBeDefined();
    runtimeSupervisor.unregister('test-detached-service');
  });
});
