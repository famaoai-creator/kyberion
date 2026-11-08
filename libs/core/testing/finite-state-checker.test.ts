import { describe, expect, it } from 'vitest';
import { checkFiniteStateSafety, type SafetyModel } from './finite-state-checker.js';

const counter: SafetyModel<number> = {
  initial: [0],
  key: String,
  next: (n) => [{ action: 'increment', state: n + 1 }],
  invariants: { bounded: (n) => n < 3 },
};
describe('finite-state safety checker', () => {
  it('returns a shortest counterexample', () => {
    const result = checkFiniteStateSafety(counter);
    expect(result.status).toBe('violated');
    expect(result.invariant).toBe('bounded');
    expect(result.trace?.map((step) => step.state)).toEqual([0, 1, 2, 3]);
  });
  it('terminates on cycles and deduplicates initial states', () => {
    expect(
      checkFiniteStateSafety({
        ...counter,
        initial: [0, 0],
        next: () => [{ action: 'loop', state: 0 }],
      })
    ).toEqual({ status: 'verified', visited: 1, transitions: 1 });
  });
  it('finds the shorter failing branch even when the longer branch is first', () => {
    const edges: Record<number, number[]> = { 0: [1, 4], 1: [2], 2: [3] };
    const result = checkFiniteStateSafety({
      ...counter,
      next: (n) => (edges[n] ?? []).map((state) => ({ action: 'branch', state })),
    });
    expect(result.status).toBe('violated');
    expect(result.trace?.map((step) => step.state)).toEqual([0, 4]);
  });
  it('propagates specification errors rather than reporting verification', () => {
    const failure = new Error('broken invariant');
    expect(() =>
      checkFiniteStateSafety({
        ...counter,
        invariants: {
          broken: () => {
            throw failure;
          },
        },
      })
    ).toThrow(failure);
  });
  it('reports incomplete exploration rather than a proof at the budget', () => {
    expect(checkFiniteStateSafety(counter, 2).status).toBe('inconclusive');
    expect(checkFiniteStateSafety({ ...counter, initial: [0, 1, 2] }, 2).status).toBe(
      'inconclusive'
    );
  });
  it('checks initial states too', () => {
    expect(checkFiniteStateSafety({ ...counter, initial: [3] }).trace).toEqual([
      { action: 'initial', state: 3 },
    ]);
  });
  it('rejects invalid budgets and empty initial states', () => {
    for (const budget of [0, -1, 1.2, Infinity, NaN]) {
      expect(() => checkFiniteStateSafety(counter, budget)).toThrow(RangeError);
    }
    expect(() => checkFiniteStateSafety({ ...counter, initial: [] })).toThrow('initial state');
  });
});
