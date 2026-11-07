import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scheduleBridgeProcessingNote, startBridgeTypingLoop } from './bridge-typing.js';

describe('bridge typing helpers (UX-02)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires immediately, repeats on the interval, and stops cleanly', async () => {
    const send = vi.fn();
    const loop = startBridgeTypingLoop('test-bridge', send, 4000);
    await vi.advanceTimersByTimeAsync(0); // flush the immediate microtask fire
    expect(send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4000);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(send).toHaveBeenCalledTimes(3);

    loop.stop();
    await vi.advanceTimersByTimeAsync(20000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('survives indicator failures without throwing', async () => {
    const send = vi.fn().mockRejectedValue(new Error('rate limited'));
    const loop = startBridgeTypingLoop('test-bridge', send, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(send.mock.calls.length).toBeGreaterThan(1);
    loop.stop();
  });

  it('sends the processing note only when work outlives the delay', async () => {
    const send = vi.fn();
    const fast = scheduleBridgeProcessingNote('test-bridge', send, 5000);
    fast.cancel();
    await vi.advanceTimersByTimeAsync(10000);
    expect(send).not.toHaveBeenCalled();

    scheduleBridgeProcessingNote('test-bridge', send, 5000);
    await vi.advanceTimersByTimeAsync(5001);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
