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
