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
});
