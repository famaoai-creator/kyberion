/**
 * Resident-dot supervisor steps — per-sweep work beyond trigger evaluation
 * (executor, KR measurement, memory distillation, autonomy, arbitration …).
 *
 * The supervisor daemon calls {@link runDotSupervisorExtensions} once per dot
 * sweep, after housekeeping. A capability registers by appending ONE entry to
 * {@link DOT_SUPERVISOR_STEPS}. Every step is isolated: a throwing step is
 * logged in diagnostic format and the rest still run.
 */

import type { LoadedDotCharter } from '@agent/core/dot/dot-charter';
import { createLogger } from '@agent/core/logger';
import { distillDotMemory } from '@agent/core/dot/dot-memory';
import { measureActiveDotKeyResults, runAsDotCharter } from '@agent/core/dot/dot-key-results';
import { evaluateDueDotOutcomes, scheduleDotOutcomeChecks } from '@agent/core/dot/dot-outcomes';
import { settleDotArbitration } from '@agent/core/dot/dot-arbitration';
import { runDotAutonomySweep } from '@agent/core/dot/dot-autonomy';
import { DOT_EXECUTOR_SUPERVISOR_STEP } from './dot_executor_step.js';

const logger = createLogger('dot-supervisor');

export interface DotSupervisorStep {
  id: string;
  run(now: Date, active: LoadedDotCharter[]): Promise<void>;
}

export const DOT_SUPERVISOR_STEPS: DotSupervisorStep[] = [];

/** Run every registered step in order; returns the ids of steps that failed. */
export async function runDotSupervisorExtensions(
  now: Date,
  active: LoadedDotCharter[],
  steps: readonly DotSupervisorStep[] = DOT_SUPERVISOR_STEPS
): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step.run(now, active);
    } catch (error) {
      failed.push(step.id);
      logger.warn(
        `supervisor step '${step.id}' failed — ${error instanceof Error ? error.message : String(error)} | next: the sweep continues; the step retries next sweep | evidence: scripts/dot_supervisor_extensions.ts`
      );
    }
  }
  return failed;
}

// DL-03 key-result measurement (dots' KRs + referenced organization objectives' KRs),
// each charter measured inside its own role / tenant / organization context
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-kr-measure',
  async run(_now, active) {
    await measureActiveDotKeyResults(active.map((entry) => entry.charter));
  },
});

// DL-05 weekly working-memory distillation (once per ISO week per dot)
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-memory-distill',
  async run(now, active) {
    for (const loaded of active) {
      try {
        await runAsDotCharter(loaded.charter, () =>
          distillDotMemory(loaded.charter, { now: () => now })
        );
      } catch (error) {
        logger.warn(
          `memory distill failed for ${loaded.charter.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep | evidence: libs/core/dot/dot-memory.ts`
        );
      }
    }
  },
});

// DL-01 executor: closes at most one delegated WorkItem per dot per sweep
DOT_SUPERVISOR_STEPS.push(DOT_EXECUTOR_SUPERVISOR_STEP);

// DL-04 outcome checks: schedule new done results, evaluate the due ones (each dot isolated)
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-outcomes',
  async run(now, active) {
    for (const loaded of active) {
      try {
        scheduleDotOutcomeChecks(loaded.charter, { now: () => now });
        await evaluateDueDotOutcomes(loaded.charter, { now: () => now });
      } catch (error) {
        logger.warn(
          `outcome check failed for ${loaded.charter.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep | evidence: libs/core/dot/dot-outcomes.ts`
        );
      }
    }
  },
});

// DL-11 settle combined arbitration cards (after housekeeping settled the newcomer)
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-arbitration-settle',
  async run(now, active) {
    for (const loaded of active) {
      try {
        settleDotArbitration(loaded.charter, now);
      } catch (error) {
        logger.warn(
          `arbitration settlement failed for ${loaded.charter.dot_id} — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep | evidence: libs/core/dot/dot-arbitration.ts`
        );
      }
    }
  },
});

// DL-10 graduated autonomy: shadow ledger, automatic demotion, promotion cards
// (daily evaluation; a promotion applies only after a human approval settles)
DOT_SUPERVISOR_STEPS.push({
  id: 'dot-autonomy',
  async run(now, active) {
    runDotAutonomySweep(
      active.map((loaded) => loaded.charter),
      { now: () => now }
    );
  },
});
