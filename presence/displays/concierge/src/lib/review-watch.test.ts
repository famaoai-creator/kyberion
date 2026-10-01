import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startReviewWatch, REVIEW_DURATION_MS, REVIEW_INTERVAL_MS } from './review-watch';
import type { ObservationReviewDigest } from './observation-review-types';

const digest: ObservationReviewDigest = {
  checkedAt: '2026-10-02T00:00:00Z',
  pendingCount: 1,
  attentionCount: 0,
  limited: false,
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function callbacks(
  read: (signal: AbortSignal) => Promise<ObservationReviewDigest> = vi.fn(async () => digest)
) {
  return {
    repeat: true,
    read,
    onResult: vi.fn(),
    onChecking: vi.fn(),
    onStop: vi.fn(),
    onError: vi.fn(),
  };
}
describe('bounded read-only review watch', () => {
  it('starts immediately, repeats without overlapping and stops after one hour', async () => {
    const options = callbacks();
    startReviewWatch(options);
    await vi.advanceTimersByTimeAsync(0);
    expect(options.onResult).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(REVIEW_INTERVAL_MS);
    expect(options.onResult).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(REVIEW_DURATION_MS - REVIEW_INTERVAL_MS);
    expect(options.onResult).toHaveBeenCalledTimes(12);
    expect(options.onStop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('manual check never schedules another request', async () => {
    const options = { ...callbacks(), repeat: false };
    startReviewWatch(options);
    await vi.advanceTimersByTimeAsync(REVIEW_DURATION_MS);
    expect(options.onResult).toHaveBeenCalledOnce();
    expect(options.onStop).toHaveBeenCalledOnce();
  });
  it('does not read after a suspended browser resumes past the absolute deadline', async () => {
    const options = callbacks();
    startReviewWatch(options);
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + REVIEW_DURATION_MS);
    await vi.advanceTimersByTimeAsync(REVIEW_INTERVAL_MS);
    expect(options.onChecking).toHaveBeenCalledOnce();
    expect(options.onStop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('context/unmount stop aborts and suppresses a late result even if abort is ignored', async () => {
    let resolve: (result: ObservationReviewDigest) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const options = callbacks((input) => {
      signal = input;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const stop = startReviewWatch(options);
    stop();
    stop();
    resolve(digest);
    await vi.advanceTimersByTimeAsync(REVIEW_DURATION_MS);
    expect(signal?.aborted).toBe(true);
    expect(options.onResult).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
    expect(options.onStop).toHaveBeenCalledOnce();
  });
  it('errors stop polling and report failure once', async () => {
    const options = callbacks(async () => {
      throw new Error('revoked');
    });
    startReviewWatch(options);
    await vi.advanceTimersByTimeAsync(REVIEW_DURATION_MS);
    expect(options.onError).toHaveBeenCalledOnce();
    expect(options.onChecking).toHaveBeenCalledOnce();
    expect(options.onStop).toHaveBeenCalledOnce();
  });
  it('timeout aborts hung reads and suppresses late outcomes', async () => {
    let resolve: (result: ObservationReviewDigest) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const options = callbacks((input) => {
      signal = input;
      return new Promise((done) => {
        resolve = done;
      });
    });
    startReviewWatch(options);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal?.aborted).toBe(true);
    expect(options.onError).toHaveBeenCalledOnce();
    resolve(digest);
    await vi.advanceTimersByTimeAsync(REVIEW_DURATION_MS);
    expect(options.onResult).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
