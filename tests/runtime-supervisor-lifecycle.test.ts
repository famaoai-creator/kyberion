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
});
