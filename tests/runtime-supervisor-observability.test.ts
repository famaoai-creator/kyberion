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
});
