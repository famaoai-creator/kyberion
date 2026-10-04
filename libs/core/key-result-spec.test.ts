import { describe, expect, it } from 'vitest';
import { keyResultProgress, type KeyResultSpec } from './key-result-spec.js';

const base: KeyResultSpec = {
  kr_id: 'kr-1',
  title: 't',
  metric: { source: 'org_metric', metric: 'open_incidents' },
  target: 10,
  direction: 'increase',
};

describe('keyResultProgress', () => {
  it('increase uses the baseline span when given', () => {
    const spec = { ...base, baseline: 5 };
    expect(keyResultProgress(spec, 5)).toBe(0);
    expect(keyResultProgress(spec, 7.5)).toBeCloseTo(0.5);
    expect(keyResultProgress(spec, 12)).toBe(1);
    expect(keyResultProgress(spec, 1)).toBe(0);
  });
  it('increase without baseline measures against zero', () => {
    expect(keyResultProgress(base, 4)).toBeCloseTo(0.4);
  });
  it('decrease uses the baseline span, and met targets are 1', () => {
    const spec: KeyResultSpec = { ...base, direction: 'decrease', target: 2, baseline: 10 };
    expect(keyResultProgress(spec, 10)).toBe(0);
    expect(keyResultProgress(spec, 6)).toBeCloseTo(0.5);
    expect(keyResultProgress(spec, 2)).toBe(1);
    expect(keyResultProgress(spec, 0)).toBe(1);
  });
  it('decrease without baseline decays as the value rises', () => {
    const spec: KeyResultSpec = { ...base, direction: 'decrease', target: 0 };
    expect(keyResultProgress(spec, 0)).toBe(1);
    expect(keyResultProgress(spec, 3)).toBeCloseTo(0.25);
  });
  it('maintain falls off with distance from target', () => {
    const spec: KeyResultSpec = { ...base, direction: 'maintain', target: 100 };
    expect(keyResultProgress(spec, 100)).toBe(1);
    expect(keyResultProgress(spec, 90)).toBeCloseTo(0.9);
    expect(keyResultProgress(spec, 300)).toBe(0);
  });
  it('non-finite values give 0', () => {
    expect(keyResultProgress(base, Number.NaN)).toBe(0);
  });
});
