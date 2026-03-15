import { afterEach, describe, expect, it } from 'vitest';
import { runtimeSupervisor } from '../libs/core/runtime-supervisor.js';

describe('runtime supervisor observability', () => {
  afterEach(() => {
    runtimeSupervisor.resetForTests();
  });

  it('produces snapshots with idle age', () => {
    const record = runtimeSupervisor.register({
      resourceId: 'resource-1',
      kind: 'service',
      ownerId: 'manifest-x',
      ownerType: 'service-manifest',
      shutdownPolicy: 'detached',
      pid: 12345,
    });

    const snapshot = runtimeSupervisor.snapshot(record.lastActiveAt + 2500);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].resourceId).toBe('resource-1');
    expect(snapshot[0].idleForMs).toBe(2500);
  });

  it('supports gateway and ui runtime kinds for background surfaces', () => {
    runtimeSupervisor.register({
      resourceId: 'surface:slack-bridge',
      kind: 'gateway',
      ownerId: 'slack-bridge',
      ownerType: 'surface-runtime-manifest',
      shutdownPolicy: 'detached',
      pid: 23456,
    });
    runtimeSupervisor.register({
      resourceId: 'surface:chronos-mirror-v2',
      kind: 'ui',
      ownerId: 'chronos-mirror-v2',
      ownerType: 'surface-runtime-manifest',
      shutdownPolicy: 'detached',
      pid: 23457,
    });

    const snapshot = runtimeSupervisor.snapshot();
    expect(snapshot.map((entry) => entry.kind)).toEqual(['gateway', 'ui']);
  });
});
