import { describe, expect, it } from 'vitest';

import { createVirtualClock, getClock, setClock, systemClock } from './clock.js';

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
});
