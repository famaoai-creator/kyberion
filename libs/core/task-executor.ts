/**
 * Deprecated compatibility facade for task-plan execution.
 *
 * DAG coordination belongs to orchestrator-actuator. Agent runtime execution
 * belongs to AgentExecutionPort. This core entry point remains only so legacy
 * callers receive an explicit routing error instead of silently taking a
 * second execution path.
 */

import { getTaskPlanCoordinator } from './task-plan-coordinator-port.js';
import type { ExecuteTaskPlanParams, ExecuteTaskPlanResult } from './task-plan-coordinator-port.js';

/** @deprecated Route execute_task_plan through orchestrator-actuator. */
export async function executeTaskPlan(
  params: ExecuteTaskPlanParams
): Promise<ExecuteTaskPlanResult> {
  return getTaskPlanCoordinator().execute(params);
}
