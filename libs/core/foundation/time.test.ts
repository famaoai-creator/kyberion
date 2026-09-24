import { afterEach, describe, expect, it } from 'vitest';

import { createVirtualClock, setClock } from './clock.js';
import { normalizeIso, nowIso, parseIso } from './time.js';

let restoreClock: (() => void) | null = null;

afterEach(() => {
  restoreClock?.();
  restoreClock = null;
});

describe('foundation/time nowIso', () => {
  it('defaults to the system clock — output is identical to new Date().toISOString() (within a tight window)', () => {
    const before = Date.now();
    const iso = nowIso();
    const after = Date.now();
    const observedMs = new Date(iso).getTime();
    expect(observedMs).toBeGreaterThanOrEqual(before);
    expect(observedMs).toBeLessThanOrEqual(after);
  });

  it('reads the registered virtual clock instead of the system clock', () => {
    const virtual = createVirtualClock(Date.UTC(2020, 0, 1));
    restoreClock = setClock(virtual);
    expect(nowIso()).toBe('2020-01-01T00:00:00.000Z');
    virtual.advance(1000);
    expect(nowIso()).toBe('2020-01-01T00:00:01.000Z');
  });

  it('an explicit date argument is unaffected by the clock override', () => {
    const virtual = createVirtualClock(0);
    restoreClock = setClock(virtual);
    const explicit = new Date('2021-06-15T12:00:00.000Z');
    expect(nowIso(explicit)).toBe('2021-06-15T12:00:00.000Z');
  });
});

describe('foundation/time parseIso / normalizeIso', () => {
  it('round-trips a valid ISO timestamp', () => {
    const iso = '2022-03-04T05:06:07.000Z';
    expect(parseIso(iso).toISOString()).toBe(iso);
  });

  it('throws on an invalid timestamp', () => {
    expect(() => parseIso('not-a-date')).toThrow(/Invalid ISO timestamp/);
  });

  it('normalizes an undefined value to the fallback (defaulting to nowIso())', () => {
    const virtual = createVirtualClock(Date.UTC(2023, 0, 1));
    restoreClock = setClock(virtual);
    expect(normalizeIso(undefined)).toBe('2023-01-01T00:00:00.000Z');
  });
});
