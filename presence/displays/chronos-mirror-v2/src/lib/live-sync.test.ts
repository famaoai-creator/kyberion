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

  it('rejects an older authoritative snapshot without applying its payload', () => {
    const onSnapshot = vi.fn();
    const scheduler = new LiveSyncScheduler({
      fetchSnapshot: async () => ({ revision: 1, items: [] }),
      onSnapshot,
      revisionOf: (snapshot) => snapshot.revision,
    });

    expect(scheduler.applySnapshot({ revision: 4, items: ['new'] })).toBe(true);
    expect(scheduler.applySnapshot({ revision: 3, items: ['stale'] })).toBe(false);
    expect(scheduler.snapshot).toEqual({ revision: 4, items: ['new'] });
    expect(scheduler.revision).toBe(4);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
  });

  it('accepts a newer snapshot even when an event arrived out of order', () => {
    const onSnapshot = vi.fn();
    const scheduler = new LiveSyncScheduler({
      fetchSnapshot: async () => ({ revision: 1, items: [] }),
      onSnapshot,
      revisionOf: (snapshot) => snapshot.revision,
    });

    scheduler.applySnapshot({ revision: 2, items: ['second'] });
    expect(scheduler.applySnapshot({ revision: 5, items: ['fifth'] })).toBe(true);
    expect(scheduler.snapshot).toEqual({ revision: 5, items: ['fifth'] });
    expect(scheduler.revision).toBe(5);
    expect(onSnapshot).toHaveBeenCalledTimes(2);
  });

  it('does not apply a snapshot that finishes after the scheduler stopped', async () => {
    let resolveSnapshot!: (snapshot: { items: string[] }) => void;
    const onSnapshot = vi.fn();
    const scheduler = new LiveSyncScheduler({
      fetchSnapshot: () =>
        new Promise<{ items: string[] }>((resolve) => {
          resolveSnapshot = resolve;
        }),
      onSnapshot,
    });

    const refresh = scheduler.refresh();
    scheduler.stop();
    resolveSnapshot({ items: ['late'] });
    await refresh;

    expect(onSnapshot).not.toHaveBeenCalled();
    expect(scheduler.snapshot).toBeUndefined();
  });
});
