import { describe, expect, it, vi } from 'vitest';
import { VoiceTurnCancellationCoordinator } from './voice-turn-cancellation.js';

describe('VoiceTurnCancellationCoordinator', () => {
  it('creates an unaborted token on arm()', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    expect(token.turnId).toBe('turn-1');
    expect(token.aborted).toBe(false);
    expect(token.reason).toBeNull();
    expect(token.signal.aborted).toBe(false);
    expect(coordinator.current()).toBe(token);
  });

  it('is idempotent — the first abort reason wins', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    token.abort('barge_in');
    token.abort('user_cancel');
    expect(token.reason).toBe('barge_in');
    expect(token.aborted).toBe(true);
    expect(token.signal.aborted).toBe(true);
  });

  it('fires listeners registered before abort synchronously', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    const seen: string[] = [];
    token.onAbort((reason) => seen.push(reason));
    token.abort('eot_revoked');
    expect(seen).toEqual(['eot_revoked']);
  });

  it('fires a listener registered AFTER abort synchronously with the recorded reason', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    token.abort('timeout');
    const seen: string[] = [];
    token.onAbort((reason) => seen.push(reason));
    expect(seen).toEqual(['timeout']);
  });

  it('onAbort unsubscribe stops further notifications', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    const seen: string[] = [];
    const unsubscribe = token.onAbort((reason) => seen.push(reason));
    unsubscribe();
    token.abort('user_cancel');
    expect(seen).toEqual([]);
  });

  it('auto-aborts with "timeout" once the injected budget timer fires', () => {
    let scheduled: { cb: () => void; ms: number } | null = null;
    const coordinator = new VoiceTurnCancellationCoordinator({
      setTimer: (cb, ms) => {
        scheduled = { cb, ms };
        return 'handle-1';
      },
      clearTimer: vi.fn(),
    });
    const token = coordinator.arm('turn-1', { budgetMs: 1500 });
    expect(scheduled?.ms).toBe(1500);
    expect(token.aborted).toBe(false);
    scheduled?.cb();
    expect(token.reason).toBe('timeout');
  });

  it('clears the budget timer when the token aborts for another reason first', () => {
    const clearTimer = vi.fn();
    const coordinator = new VoiceTurnCancellationCoordinator({
      setTimer: () => 'handle-1',
      clearTimer,
    });
    const token = coordinator.arm('turn-1', { budgetMs: 1500 });
    token.abort('barge_in');
    expect(clearTimer).toHaveBeenCalledWith('handle-1');
    expect(token.reason).toBe('barge_in');
  });

  it('abortCurrent() aborts whichever token was armed most recently', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    coordinator.abortCurrent('user_cancel');
    expect(token.reason).toBe('user_cancel');
  });

  it('abortCurrent() is a no-op when nothing has been armed', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    expect(() => coordinator.abortCurrent('user_cancel')).not.toThrow();
  });

  it('arming a new turn does NOT abort the previous turn (documented choice)', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const first = coordinator.arm('turn-1');
    const second = coordinator.arm('turn-2');
    expect(first.aborted).toBe(false);
    expect(second.aborted).toBe(false);
    expect(coordinator.current()).toBe(second);
  });

  it("arming a new turn disposes the previous turn's pending budget timer", () => {
    const clearTimer = vi.fn();
    let calls = 0;
    const coordinator = new VoiceTurnCancellationCoordinator({
      setTimer: () => {
        calls += 1;
        return `handle-${calls}`;
      },
      clearTimer,
    });
    coordinator.arm('turn-1', { budgetMs: 1000 });
    coordinator.arm('turn-2', { budgetMs: 1000 });
    expect(clearTimer).toHaveBeenCalledWith('handle-1');
  });

  it('bindExternal() propagates an external AbortSignal abort as "external"', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    const controller = new AbortController();
    coordinator.bindExternal(controller.signal);
    controller.abort();
    expect(token.reason).toBe('external');
  });

  it('bindExternal() aborts immediately when the signal is already aborted', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    const controller = new AbortController();
    controller.abort();
    coordinator.bindExternal(controller.signal);
    expect(token.reason).toBe('external');
  });

  it('bindExternal() unsubscribe stops the propagation', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    const controller = new AbortController();
    const unsubscribe = coordinator.bindExternal(controller.signal);
    unsubscribe();
    controller.abort();
    expect(token.aborted).toBe(false);
  });

  it('downstream consumers can use token.signal directly after either direction aborts', () => {
    const coordinator = new VoiceTurnCancellationCoordinator();
    const token = coordinator.arm('turn-1');
    expect(token.signal.aborted).toBe(false);
    token.abort('barge_in');
    expect(token.signal.aborted).toBe(true);
  });
});
