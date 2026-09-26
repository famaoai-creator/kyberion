/**
 * ES-03: injectable clock.
 *
 * `foundation/time.ts` `nowIso()` reads `getClock().now()` as its default
 * argument so a scenario run (or a test) can bind a virtual clock without
 * touching every `Date.now()` call site in the codebase. Nothing bound ->
 * `systemClock` (real wall time) — today's behavior is unchanged.
 *
 * This is plain module state rather than a capability seam: foundation must
 * not depend on the domain-layer seam catalog.
 *
 * FU-01: `runWithClock` binds a clock for one async context only (a scenario
 * run), so concurrent work elsewhere in the process keeps real wall time.
 * Resolution order: async-scoped clock, then `setClock`, then system.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface KyberionClock {
  now(): number;
}

export const systemClock: KyberionClock = {
  now: () => Date.now(),
};

let boundClock: KyberionClock | undefined;
const scopedClock = new AsyncLocalStorage<KyberionClock>();

/** Currently bound clock; falls back to the real system clock when nothing is bound. */
export function getClock(): KyberionClock {
  return scopedClock.getStore() ?? boundClock ?? systemClock;
}

/** Run `fn` (and all async work it starts) with `clock` as the current clock. */
export function runWithClock<T>(clock: KyberionClock, fn: () => T): T {
  return scopedClock.run(clock, fn);
}

/**
 * Bind a clock (e.g. a scenario run's virtual clock). Only one clock can be
 * bound at a time — call the returned disposer before binding another one.
 */
export function setClock(clock: KyberionClock): () => void {
  if (boundClock) {
    throw new Error('[CLOCK_ALREADY_BOUND] a clock is already registered; dispose it first');
  }
  boundClock = clock;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (boundClock === clock) boundClock = undefined;
  };
}

export interface VirtualClock extends KyberionClock {
  /** Move the clock forward by `ms` (use a negative value to rewind). */
  advance(ms: number): void;
  /** Set the clock to an absolute epoch-ms value. */
  set(ms: number): void;
}

/** A clock with no side effects outside itself — safe to create many of, bind at most one at a time. */
export function createVirtualClock(startMs: number): VirtualClock {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
    set: (ms: number) => {
      current = ms;
    },
  };
}
