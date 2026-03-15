import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcess } from 'node:child_process';

const mockChild = () => {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  return {
    pid: 4242,
    killed: false,
    on(event: string, cb: (...args: any[]) => void) {
      const existing = handlers.get(event) || [];
      existing.push(cb);
      handlers.set(event, existing);
      return this;
    },
    kill() {
      this.killed = true;
      return true;
    },
    emit(event: string, ...args: any[]) {
      for (const cb of handlers.get(event) || []) cb(...args);
    },
  } as unknown as ChildProcess & { emit: (event: string, ...args: any[]) => void; killed: boolean };
};

describe('managed-process core', () => {
  afterEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    const { runtimeSupervisor } = await import('../libs/core/runtime-supervisor.js');
    runtimeSupervisor.resetForTests();
  });

  it('registers and unregisters managed child processes in runtime supervisor', async () => {
    const child = mockChild();
    vi.doMock('node:child_process', () => ({
      spawn: vi.fn(() => child),
    }));

    const { spawnManagedProcess, stopManagedProcess } = await import('../libs/core/managed-process.js');
    const { runtimeSupervisor } = await import('../libs/core/runtime-supervisor.js');

    const managed = spawnManagedProcess({
      resourceId: 'proc:test',
      kind: 'service',
      ownerId: 'owner-x',
      ownerType: 'test',
      command: 'echo',
      args: ['hi'],
    });

    expect(managed.child.pid).toBe(4242);
    expect(runtimeSupervisor.get('proc:test')?.pid).toBe(4242);

    stopManagedProcess('proc:test', managed.child);
    expect(runtimeSupervisor.get('proc:test')).toBeUndefined();
  });
});
