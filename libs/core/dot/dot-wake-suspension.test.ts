import { describe, expect, it } from 'vitest';
import {
  DOT_WAKE_SUSPENSION_THRESHOLD_MS,
  startDotWakeSuspensionMonitor,
} from './dot-wake-suspension.js';

function fakeTimers() {
  let clock = 0;
  let tick: (() => void) | undefined;
  let cleared = false;
  return {
    options: {
      now: () => clock,
      tickMs: 5_000,
      setIntervalFn: (callback: () => void) => {
        tick = callback;
        return {};
      },
      clearIntervalFn: () => {
        cleared = true;
      },
    },
    advance(ms: number, ticks = true) {
      if (!ticks) {
        clock += ms;
        return;
      }
      for (let left = ms; left > 0; left -= 5_000) {
        clock += Math.min(5_000, left);
        if (left >= 5_000) tick?.();
      }
    },
    resumeTick() {
      tick?.();
    },
    get cleared() {
      return cleared;
    },
  };
}

describe('startDotWakeSuspensionMonitor', () => {
  it('reports ~0 while the timer keeps ticking', () => {
    const timers = fakeTimers();
    const monitor = startDotWakeSuspensionMonitor(timers.options);
    timers.advance(30 * 60_000);
    expect(monitor.suspendedMs()).toBe(0);
    monitor.stop();
    expect(timers.cleared).toBe(true);
  });

  it('counts a gap in which the process did not tick (host asleep)', () => {
    const timers = fakeTimers();
    const monitor = startDotWakeSuspensionMonitor(timers.options);
    timers.advance(60_000);
    timers.advance(3 * 60 * 60_000, false); // asleep: no ticks
    timers.resumeTick();
    expect(monitor.suspendedMs()).toBeGreaterThan(DOT_WAKE_SUSPENSION_THRESHOLD_MS);
    expect(monitor.suspendedMs()).toBe(3 * 60 * 60_000 - 5_000);
  });

  it('includes the pending gap when sampled before the first post-resume tick', () => {
    const timers = fakeTimers();
    const monitor = startDotWakeSuspensionMonitor(timers.options);
    timers.advance(2 * 60 * 60_000, false);
    expect(monitor.suspendedMs()).toBeGreaterThan(DOT_WAKE_SUSPENSION_THRESHOLD_MS);
  });

  it('ignores ordinary event-loop jitter', () => {
    const timers = fakeTimers();
    const monitor = startDotWakeSuspensionMonitor(timers.options);
    timers.advance(8_000, false);
    timers.resumeTick();
    expect(monitor.suspendedMs()).toBe(0);
  });
});
