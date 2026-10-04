/**
 * Dot wake orchestration wiring — resolves the wake backend once and injects
 * the goal-driven loop into the domain `runDotWake` port.
 *
 * Lives in the orchestration layer (filename matches `*orchestrat*`) so that
 * domain `dot-runtime` never imports `worker-goal-driver`. Scripts and the
 * supervisor daemon call this entry instead of composing the port themselves.
 *
 * The resolved backend is passed explicitly into `runGoalDrivenLoop`: the
 * driver otherwise re-resolves `getReasoningBackend()` itself, which is how a
 * wake that saw a tool-capable backend still died with "[GOAL_DRIVER] backend
 * lacks generateWithTools".
 */

import { runGoalDrivenLoop } from '../workforce/worker-goal-driver.js';
import type { LoadedDotCharter } from './dot-charter.js';
import {
  runDotWake,
  type DotRuntimeDeps,
  type DotWakeReceipt,
  type DueDotTrigger,
} from './dot-runtime.js';
import { resolveDotWakeBackend, type ResolveDotWakeBackendOptions } from './dot-wake-backend.js';

export type DotWakeOrchestrationDeps = Omit<DotRuntimeDeps, 'runLoop' | 'backendUnavailable'> & {
  trigger?: DueDotTrigger;
  /** Named-backend lookup for `charter.runtime.reasoning_backend`. */
  backendFor?: ResolveDotWakeBackendOptions['backendFor'];
  /** Goal-driver port (test seam); defaults to `runGoalDrivenLoop`. */
  goalDriver?: typeof runGoalDrivenLoop;
};

/** Run one charter wake with the production goal-driven loop injected. */
export async function runDotWakeWithGoalDriver(
  loaded: LoadedDotCharter,
  deps: DotWakeOrchestrationDeps = {}
): Promise<DotWakeReceipt> {
  const { backendFor, goalDriver, ...runtimeDeps } = deps;
  const backend =
    deps.backend ?? (await import('../reasoning/reasoning-backend.js')).getReasoningBackend();
  const resolution = resolveDotWakeBackend(loaded.charter, backend, {
    injected: deps.backend !== undefined,
    ...(backendFor ? { backendFor } : {}),
  });
  if (resolution.mode === 'unavailable') {
    return runDotWake(loaded, { ...runtimeDeps, backendUnavailable: resolution.reason });
  }
  const drive = goalDriver ?? runGoalDrivenLoop;
  return runDotWake(loaded, {
    ...runtimeDeps,
    backend: resolution.backend,
    ...(resolution.mode === 'tool'
      ? {
          runLoop: (options) =>
            drive({ ...options, backend: options.backend ?? resolution.backend }),
        }
      : {}),
  });
}
