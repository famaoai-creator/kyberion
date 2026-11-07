/**
 * Gap-phase accounting (QM-09): named-phase latency attribution for LLM
 * delegations, ported from qm's per-request gapPhases breakdown. A slow
 * delegation should be answerable with "which phase" from the trace, not by
 * grepping logs after the fact.
 *
 * The phase vocabulary lives HERE (code as registry, single source): trace
 * writers validate against it so a typo'd phase name is caught at write time
 * instead of silently fragmenting the analytics. `tool_body.<name>` is the
 * one parameterized family, mirroring qm.
 */

export const GAP_PHASES = [
  'context_pack',
  'knowledge_slice',
  'prompt_build',
  'screen',
  'backend_dispatch',
  'model_wait',
  'parse',
  'repair',
  'delivery',
  'audit',
] as const;

export type BaseGapPhase = (typeof GAP_PHASES)[number];

export interface GapPhaseSample {
  phase: string;
  ms: number;
}

export function isKnownGapPhase(name: string): boolean {
  if ((GAP_PHASES as readonly string[]).includes(name)) return true;
  return /^tool_body\.[\w:-]{1,64}$/.test(name);
}

export interface GapRecorder {
  /** Measure an async operation under a named phase. */
  measure<T>(phase: string, fn: () => Promise<T>): Promise<T>;
  /** Measure a sync operation under a named phase. */
  measureSync<T>(phase: string, fn: () => T): T;
  samples(): GapPhaseSample[];
  totalMs(): number;
}

export function createGapRecorder(now: () => number = Date.now): GapRecorder {
  const samples: GapPhaseSample[] = [];
  const record = (phase: string, ms: number): void => {
    samples.push({ phase, ms });
  };
  return {
    async measure<T>(phase: string, fn: () => Promise<T>): Promise<T> {
      const start = now();
      try {
        return await fn();
      } finally {
        record(phase, now() - start);
      }
    },
    measureSync<T>(phase: string, fn: () => T): T {
      const start = now();
      try {
        return fn();
      } finally {
        record(phase, now() - start);
      }
    },
    samples: () => samples.map((sample) => ({ ...sample })),
    totalMs: () => samples.reduce((sum, sample) => sum + sample.ms, 0),
  };
}

/**
 * Drops samples with unknown phase names (warning via the provided sink) so a
 * typo cannot fragment the vocabulary; the survivors are safe to persist.
 */
export function sanitizeGapSamples(
  samples: GapPhaseSample[],
  warn: (message: string) => void = () => {}
): GapPhaseSample[] {
  const kept: GapPhaseSample[] = [];
  for (const sample of samples) {
    if (!isKnownGapPhase(sample.phase)) {
      warn(
        `[gap-phase] dropping sample with unknown phase ${JSON.stringify(sample.phase)} — add it to GAP_PHASES if it is a real phase.`
      );
      continue;
    }
    if (!Number.isFinite(sample.ms) || sample.ms < 0) {
      warn(`[gap-phase] dropping sample with invalid ms for phase ${sample.phase}`);
      continue;
    }
    kept.push({ phase: sample.phase, ms: Math.round(sample.ms) });
  }
  return kept;
}
