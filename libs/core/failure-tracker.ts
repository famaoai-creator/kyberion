/** State-only transitions; the owning subsystem executes its existing recovery action. */
export interface FailureState {
  count: number;
  lastFailureAt?: number;
  tick?: string | number;
}
export interface FailurePolicy {
  threshold: number;
  reset: 'never' | 'ttl' | 'tick';
  ttlMs?: number;
  action: 'throw' | 'open' | 'demote' | 'disable';
  /** Consecutive failures reset on success; cumulative failures explicitly opt out. */
  resetOnSuccess?: boolean;
}
export type FailureEvent =
  | { kind: 'failure'; now: number; tick?: string | number }
  | { kind: 'success'; now: number; tick?: string | number }
  | { kind: 'reset'; now: number; tick?: string | number };

export function createFailureTracker(policy: FailurePolicy) {
  if (
    !Number.isSafeInteger(policy.threshold) ||
    policy.threshold < 1 ||
    (policy.reset === 'ttl' && (!Number.isFinite(policy.ttlMs) || (policy.ttlMs ?? 0) <= 0))
  ) {
    throw new Error('Failure tracker requires positive threshold and TTL when selected');
  }
  return {
    transition(previous: FailureState, event: FailureEvent): FailureState {
      if (
        !Number.isSafeInteger(previous.count) ||
        previous.count < 0 ||
        !Number.isFinite(event.now)
      ) {
        throw new Error('Failure tracker requires a nonnegative count and finite clock');
      }
      if (policy.reset === 'tick' && event.tick === undefined) {
        throw new Error('Tick-reset failure tracker requires a tick');
      }
      const expired =
        policy.reset === 'ttl' &&
        previous.lastFailureAt !== undefined &&
        event.now - previous.lastFailureAt >= (policy.ttlMs as number);
      const changedTick = policy.reset === 'tick' && previous.tick !== event.tick;
      const count = expired || changedTick ? 0 : previous.count;
      if (event.kind === 'reset' || (event.kind === 'success' && policy.resetOnSuccess === true)) {
        return { count: 0, ...(event.tick !== undefined ? { tick: event.tick } : {}) };
      }
      return event.kind === 'failure'
        ? {
            count: Math.min(Number.MAX_SAFE_INTEGER, count + 1),
            lastFailureAt: event.now,
            ...(event.tick !== undefined ? { tick: event.tick } : {}),
          }
        : { ...previous, count, ...(event.tick !== undefined ? { tick: event.tick } : {}) };
    },
    decision(state: FailureState): { exceeded: boolean; action?: FailurePolicy['action'] } {
      return state.count >= policy.threshold
        ? { exceeded: true, action: policy.action }
        : { exceeded: false };
    },
  };
}
