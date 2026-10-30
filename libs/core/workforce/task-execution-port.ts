/** Dependency inversion for task orchestration, installed by execution hosts. */
import type { ReasoningBackend } from '../reasoning/reasoning-backend.js';
import type { runGoalDrivenLoop } from './worker-goal-driver.js';
import type { ReasoningBackendMode } from '../reasoning/reasoning-backend-policy.js';
import type { SamplingParams } from '../reasoning/reasoning-route-resolver.js';

let goalLoop: typeof runGoalDrivenLoop | undefined;
let backendFactory: ((mode: string) => ReasoningBackend | undefined) | undefined;
export function registerTaskGoalLoop(loop: typeof runGoalDrivenLoop): void {
  goalLoop = loop;
}
export function registerTaskBackendFactory(
  factory: (mode: string) => ReasoningBackend | undefined
): void {
  backendFactory = factory;
}
export const executeTaskGoalLoop: typeof runGoalDrivenLoop = (options) => {
  if (!goalLoop)
    throw new Error('[TASK_TOOL_CAPABILITY_UNAVAILABLE] Task goal engine is not installed');
  return goalLoop(options);
};
export function buildTaskBackend(mode: string): ReasoningBackend | undefined {
  return backendFactory?.(mode);
}

/** Governed routing input for one claimed task; no process-global installation. */
export interface TaskReasoningBackendOptions {
  mode?: ReasoningBackendMode;
  model?: string;
  role?: string;
  profile?: string;
  samplingParams?: SamplingParams;
}

let scopedBackendFactory: ((options: TaskReasoningBackendOptions) => ReasoningBackend) | undefined;
export function registerTaskReasoningBackendFactory(
  factory: (options: TaskReasoningBackendOptions) => ReasoningBackend
): void {
  scopedBackendFactory = factory;
}

export function buildTaskReasoningBackend(
  options: TaskReasoningBackendOptions = {}
): ReasoningBackend {
  if (!scopedBackendFactory) {
    throw new Error(
      '[TASK_TOOL_CAPABILITY_UNAVAILABLE] Task reasoning construction is not installed by the execution host'
    );
  }
  return scopedBackendFactory(options);
}
