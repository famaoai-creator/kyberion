import { describe, expect, it } from 'vitest';
import { createFailureTracker } from './failure-tracker.js';

describe('failure reset policies', () => {
  it('preserves cumulative failures unless success reset is explicitly selected', () => {
    const cumulative = createFailureTracker({ threshold: 2, reset: 'never', action: 'demote' });
    const failed = cumulative.transition({ count: 1 }, { kind: 'failure', now: 0 });
    expect(cumulative.decision(failed)).toEqual({ exceeded: true, action: 'demote' });
    expect(cumulative.transition(failed, { kind: 'success', now: 1 }).count).toBe(2);
    const consecutive = createFailureTracker({
      threshold: 2,
      reset: 'never',
      action: 'disable',
      resetOnSuccess: true,
    });
    expect(consecutive.transition(failed, { kind: 'success', now: 1 })).toEqual({ count: 0 });
  });

  it('resets after inactivity TTL, rather than treating elapsed time as a success', () => {
    const tracker = createFailureTracker({
      threshold: 2,
      reset: 'ttl',
      ttlMs: 100,
      action: 'open',
    });
    const first = tracker.transition({ count: 0 }, { kind: 'failure', now: 0 });
    expect(tracker.transition(first, { kind: 'failure', now: 99 }).count).toBe(2);
    expect(tracker.transition(first, { kind: 'failure', now: 100 }).count).toBe(1);
  });

  it('requires explicit ticks and resets only when tick identity changes', () => {
    const tracker = createFailureTracker({ threshold: 2, reset: 'tick', action: 'throw' });
    expect(
      tracker.transition({ count: 1, tick: 'a' }, { kind: 'failure', now: 1, tick: 'a' }).count
    ).toBe(2);
    expect(
      tracker.transition({ count: 1, tick: 'a' }, { kind: 'failure', now: 1, tick: 'b' }).count
    ).toBe(1);
    expect(() => tracker.transition({ count: 0 }, { kind: 'failure', now: 1 })).toThrow(
      'requires a tick'
    );
  });
});
