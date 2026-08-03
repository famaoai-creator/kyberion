import { describe, expect, it, vi } from 'vitest';

import { LiveSyncScheduler } from './live-sync';

describe('LiveSyncScheduler', () => {
  it('coalesces an event burst and keeps identity for an equivalent snapshot', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const first = { items: [{ id: 'a', status: 'running' }] };
    const snapshots = [first, { items: [{ id: 'a', status: 'running' }] }];
    const onSnapshot = vi.fn();
    const scheduler = new LiveSyncScheduler({
      fetchSnapshot: async () => snapshots[calls++]!,
      onSnapshot,
      debounceMs: 50,
    });

    scheduler.invalidate();
    scheduler.invalidate();
    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(1);
    expect(onSnapshot).toHaveBeenCalledTimes(1);

    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(2);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(scheduler.snapshot).toBe(first);
    scheduler.stop();
    vi.useRealTimers();
  });

  it('defers refresh while hidden and resumes when visible', async () => {
    vi.useFakeTimers();
    let visible = false;
    let calls = 0;
    const scheduler = new LiveSyncScheduler({
      fetchSnapshot: async () => {
        calls += 1;
        return { calls };
      },
      onSnapshot: vi.fn(),
      debounceMs: 10,
      isVisible: () => visible,
    });

    scheduler.invalidate();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(0);
    visible = true;
    scheduler.resume();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    scheduler.stop();
    vi.useRealTimers();
  });
});
