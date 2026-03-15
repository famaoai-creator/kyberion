import { afterEach, describe, expect, it, vi } from 'vitest';

describe('runtime supervisor lifecycle', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('unrefs the sweep timer so CLI processes can exit cleanly', async () => {
    const unref = vi.fn();
    const clearToken = { unref } as any;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(clearToken);

    const { runtimeSupervisor } = await import('../libs/core/runtime-supervisor.js');
    runtimeSupervisor.startSweep(1234);

    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    runtimeSupervisor.stopSweep();
  });

  it('installs runtime exit hooks lazily on first resource registration', async () => {
    const onceSpy = vi.spyOn(process, 'once');

    const { runtimeSupervisor } = await import('../libs/core/runtime-supervisor.js');
    expect(onceSpy).not.toHaveBeenCalled();

    runtimeSupervisor.register({
      resourceId: 'proc:test',
      kind: 'service',
      ownerId: 'owner-x',
      ownerType: 'test',
    });

    expect(onceSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(onceSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));

    runtimeSupervisor.unregister('proc:test');
  });

  it('unrefs the agent health monitor timer so CLI processes can exit cleanly', async () => {
    const unref = vi.fn();
    const clearToken = { unref } as any;
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockReturnValue(clearToken);

    const { agentLifecycle } = await import('../libs/core/agent-lifecycle.js');
    const beforeUnrefCalls = unref.mock.calls.length;
    agentLifecycle.startHealthMonitor(4321);

    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 4321);
    expect(unref.mock.calls.length).toBe(beforeUnrefCalls + 1);

    agentLifecycle.stopHealthMonitor();
  });

  it('cleans up all registered runtime resources in registration order', async () => {
    const cleanupA = vi.fn(async () => {});
    const cleanupB = vi.fn(async () => {});

    const { runtimeSupervisor } = await import('../libs/core/runtime-supervisor.js');
    runtimeSupervisor.register({
      resourceId: 'proc:a',
      kind: 'agent',
      ownerId: 'owner-a',
      ownerType: 'test',
      cleanup: cleanupA,
    });
    runtimeSupervisor.register({
      resourceId: 'proc:b',
      kind: 'service',
      ownerId: 'owner-b',
      ownerType: 'test',
      cleanup: cleanupB,
    });

    const cleaned = await runtimeSupervisor.cleanupAll('test');

    expect(cleaned).toEqual(['proc:a', 'proc:b']);
    expect(cleanupA).toHaveBeenCalledOnce();
    expect(cleanupB).toHaveBeenCalledOnce();
    expect(runtimeSupervisor.list()).toEqual([]);
  });
});
