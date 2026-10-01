import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  startBridgePollLoop,
  startBridgeSequentialPoll,
  stopAllBridgePollLoops,
} from '../../satellites/shared/bridge-poll-loop.js';

afterEach(() => {
  stopAllBridgePollLoops();
  vi.useRealTimers();
});
describe('bridge poll lifecycle', () => {
  it('keeps cadence, suppresses duplicate starts and overlapping ticks, and stops', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const poll = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const handle = startBridgePollLoop({ name: 'guard-test', intervalMs: 100, poll });
    expect(startBridgePollLoop({ name: 'guard-test', intervalMs: 1, poll })).toBe(handle);
    await vi.advanceTimersByTimeAsync(100);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(poll).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(poll).toHaveBeenCalledTimes(2);
    handle.stop();
    release();
    await vi.advanceTimersByTimeAsync(300);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(handle.running).toBe(false);
  });
  it('stops sequential retry sleep without another poll', async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => {
      throw new Error('offline');
    });
    const onError = vi.fn();
    const loop = startBridgeSequentialPoll({
      name: 'sleep-test',
      poll,
      onError,
      errorDelayMs: 5000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    loop.stop();
    await loop.done;
    await vi.advanceTimersByTimeAsync(5000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
