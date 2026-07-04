/**
 * Shared runtime execution bounds for pipeline engines (SA-02 Task 4).
 *
 * Extracted from system-actuator's executePipeline so every pipeline runner
 * enforces the same step / wall-clock / loop backstops instead of
 * re-implementing them. Static (contract-time) limits live in
 * adf-guardrails.ts; these are the runtime last line of defense.
 */

export const DEFAULT_MAX_PIPELINE_STEPS = 1000;
export const DEFAULT_PIPELINE_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_LOOP_ITERATIONS = 100;

export interface ExecutionBoundsOptions {
  maxSteps?: number;
  timeoutMs?: number;
}

export interface ExecutionBoundsState {
  stepCount: number;
  startTime: number;
}

export function createExecutionBoundsState(nowMs: number = Date.now()): ExecutionBoundsState {
  return { stepCount: 0, startTime: nowMs };
}

/**
 * Throws when the state exceeds the configured bounds. Callers increment
 * `state.stepCount` before each step, then call this guard.
 * Error messages keep the historical `[SAFETY_LIMIT]` prefix so existing
 * error classification and tests remain stable.
 */
export function assertExecutionBounds(
  state: ExecutionBoundsState,
  options: ExecutionBoundsOptions = {},
  nowMs: number = Date.now()
): void {
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_PIPELINE_STEPS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PIPELINE_TIMEOUT_MS;
  if (state.stepCount > maxSteps) {
    throw new Error(`[SAFETY_LIMIT] Exceeded maximum pipeline steps (${maxSteps})`);
  }
  if (nowMs - state.startTime > timeoutMs) {
    throw new Error(`[SAFETY_LIMIT] Pipeline execution timed out (${timeoutMs}ms)`);
  }
}

/**
 * Loop backstop: returns true while the loop may continue. Callers decide
 * whether hitting the bound is a warning (legacy while-loop behavior) or an
 * error.
 */
export function withinLoopBounds(iteration: number, maxIterations?: number): boolean {
  const limit = maxIterations ?? DEFAULT_MAX_LOOP_ITERATIONS;
  return iteration < limit;
}
