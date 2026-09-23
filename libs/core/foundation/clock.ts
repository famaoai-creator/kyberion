/**
 * ES-03: injectable clock seam.
 *
 * `foundation/time.ts` `nowIso()` reads `getClock().now()` as its default
 * argument so a scenario run (or a test) can bind a virtual clock without
 * touching every `Date.now()` call site in the codebase. Unregistered ->
 * `systemClock` (real wall time) — today's behavior is unchanged.
 */

import { coreSeamCatalog, createSeam, type SeamProviderMetadata } from '../seam.js';

export interface KyberionClock {
  now(): number;
}

export const systemClock: KyberionClock = {
  now: () => Date.now(),
};

const CLOCK_SEAM_KEY = 'core-clock';

const DEFAULT_METADATA: SeamProviderMetadata = {
  provenance: 'builtin',
  source: 'libs/core/foundation/clock.ts',
  reason: 'virtual clock override (scenario runs, tests)',
};

const clockSeam = createSeam<KyberionClock>({
  key: CLOCK_SEAM_KEY,
  multiplicity: 'sole',
  catalog: coreSeamCatalog,
});

/** Currently bound clock; falls back to the real system clock when nothing is registered. */
export function getClock(): KyberionClock {
  return clockSeam.getOptional() ?? systemClock;
}

/**
 * Bind a clock (e.g. a scenario run's virtual clock). Only one clock can be
 * bound at a time (sole seam) — call the returned disposer before binding
 * another one, otherwise registration throws `SEAM_DUPLICATE_PROVIDER`.
 */
export function setClock(
  clock: KyberionClock,
  metadata: SeamProviderMetadata = DEFAULT_METADATA
): () => void {
  return clockSeam.register('override', clock, metadata);
}

export interface VirtualClock extends KyberionClock {
  /** Move the clock forward by `ms` (use a negative value to rewind). */
  advance(ms: number): void;
  /** Set the clock to an absolute epoch-ms value. */
  set(ms: number): void;
}

/** A clock with no side effects outside itself — safe to create many of, register at most one at a time. */
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
