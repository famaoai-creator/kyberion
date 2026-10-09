import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startSummaryWatch } from './summary-watch';
import { storeFrontDeskToken } from './front-desk-auth-token';
let token: string | null;
let source: {
  close: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  onerror?: () => void;
};
beforeEach(() => {
  token = null;
  vi.useFakeTimers();
  vi.stubGlobal('window', {
    sessionStorage: {
      getItem: () => token,
      setItem: (_key: string, value: string) => {
        token = value;
      },
    },
  });
  vi.stubGlobal('document', { cookie: '' });
  source = { close: vi.fn(), addEventListener: vi.fn() };
  vi.stubGlobal(
    'EventSource',
    vi.fn(function () {
      return source;
    })
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('member summary watch', () => {
  it('uses immediate authenticated refresh and paced polling, never bearer EventSource', async () => {
    storeFrontDeskToken('owner');
    const refresh = vi.fn(async (_signal: AbortSignal) => {});
    const stop = startSummaryWatch({ refresh, onSummary: vi.fn() });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(EventSource).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(refresh).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('never overlaps slow refresh; timeout aborts and close prevents late scheduling', async () => {
    storeFrontDeskToken('owner');
    let finish!: () => void;
    let signal!: AbortSignal;
    const refresh = vi.fn((value: AbortSignal) => {
      signal = value;
      return new Promise<void>((r) => {
        finish = r;
      });
    });
    const stop = startSummaryWatch({ refresh, onSummary: vi.fn() });
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    stop();
    finish();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it('keeps cookie SSE, closes once on error, avoids duplicate timers and late events', async () => {
    const refresh = vi.fn(async (_signal: AbortSignal) => {});
    const onSummary = vi.fn();
    const stop = startSummaryWatch({ refresh, onSummary });
    expect(EventSource).toHaveBeenCalledWith('/api/events');
    await vi.advanceTimersByTimeAsync(1);
    source.onerror!();
    source.onerror!();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(source.close).toHaveBeenCalledTimes(1);
    stop();
    source.addEventListener.mock.calls[0]![1]({ data: 'late' });
    expect(onSummary).not.toHaveBeenCalled();
  });
  it('drops stale SSE and polling after member changes', async () => {
    const onSummary = vi.fn();
    const stop = startSummaryWatch({ refresh: async () => {}, onSummary });
    storeFrontDeskToken('new-owner');
    source.addEventListener.mock.calls[0]![1]({ data: 'other identity' });
    expect(onSummary).not.toHaveBeenCalled();
    stop();
    const refresh = vi.fn(async (_signal: AbortSignal) => {});
    const stop2 = startSummaryWatch({ refresh, onSummary });
    await vi.advanceTimersByTimeAsync(1);
    storeFrontDeskToken('third-owner');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    stop2();
  });
});
