/**
 * Dot wake orchestration wiring — injects the goal-driven loop into the
 * domain `runDotWake` port.
 *
 * Lives in the orchestration layer (filename matches `*orchestrat*`) so that
 * domain `dot-runtime` never imports `worker-goal-driver`. Scripts and the
 * supervisor daemon call this entry instead of composing the port themselves.
 */

import { runGoalDrivenLoop } from '../workforce/worker-goal-driver.js';
import type { LoadedDotCharter } from './dot-charter.js';
import {
  runDotWake,
  type DotRuntimeDeps,
  type DotWakeReceipt,
  type DueDotTrigger,
} from './dot-runtime.js';

export type DotWakeOrchestrationDeps = Omit<DotRuntimeDeps, 'runLoop'> & {
  trigger?: DueDotTrigger;
};

/** Run one charter wake with the production goal-driven loop injected. */
export async function runDotWakeWithGoalDriver(
  loaded: LoadedDotCharter,
  deps: DotWakeOrchestrationDeps = {}
): Promise<DotWakeReceipt> {
  return runDotWake(loaded, {
    ...deps,
    runLoop: (options) => runGoalDrivenLoop(options),
  });
}
