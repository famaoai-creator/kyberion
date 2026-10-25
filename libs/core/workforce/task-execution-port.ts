/** Dependency inversion for task orchestration, installed by execution hosts. */
import type { ReasoningBackend } from '../reasoning/reasoning-backend.js';
import type { runGoalDrivenLoop } from './worker-goal-driver.js';

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
