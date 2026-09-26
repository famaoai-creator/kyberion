import { describe, expect, it } from 'vitest';

import { createVirtualClock, getClock, runWithClock, setClock, systemClock } from './clock.js';
import { nowIso } from './time.js';

describe('foundation/clock', () => {
  it('defaults to the system clock when nothing is registered', () => {
    expect(getClock()).toBe(systemClock);
    const before = Date.now();
    const observed = getClock().now();
    const after = Date.now();
    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });

  it('binds a clock and restores the system clock on dispose', () => {
    const virtual = createVirtualClock(1000);
    const dispose = setClock(virtual);
    try {
      expect(getClock()).toBe(virtual);
      expect(getClock().now()).toBe(1000);
    } finally {
      dispose();
    }
    expect(getClock()).toBe(systemClock);
  });

  it('rejects a second registration while one is already bound (sole seam)', () => {
    const first = createVirtualClock(0);
    const dispose = setClock(first);
    try {
      expect(() => setClock(createVirtualClock(1))).toThrow(/already registered/);
    } finally {
      dispose();
    }
  });

  it('createVirtualClock advances and sets deterministically', () => {
    const clock = createVirtualClock(500);
    expect(clock.now()).toBe(500);
    clock.advance(250);
    expect(clock.now()).toBe(750);
    clock.advance(-100);
    expect(clock.now()).toBe(650);
    clock.set(0);
    expect(clock.now()).toBe(0);
  });

  it('runWithClock scopes a clock to one async context (FU-01)', async () => {
    const virtual = createVirtualClock(Date.UTC(2020, 0, 1));
    let releaseInside!: () => void;
    const insideGate = new Promise<void>((resolve) => {
      releaseInside = resolve;
    });
    const inside = runWithClock(virtual, async () => {
      await insideGate;
      return nowIso();
    });
    // Unrelated work running while the scoped clock is active keeps wall time.
    const outside = nowIso();
    releaseInside();
    await expect(inside).resolves.toBe('2020-01-01T00:00:00.000Z');
    expect(Date.parse(outside)).toBeGreaterThan(Date.UTC(2024, 0, 1));
    expect(getClock()).toBe(systemClock);
  });

  it('runWithClock takes precedence over a module-bound clock', () => {
    const dispose = setClock(createVirtualClock(1));
    try {
      expect(runWithClock(createVirtualClock(2), () => getClock().now())).toBe(2);
      expect(getClock().now()).toBe(1);
    } finally {
      dispose();
    }
  });
});
