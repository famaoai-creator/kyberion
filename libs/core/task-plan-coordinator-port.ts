import type { AgentExecutionPort } from './agent-execution-port.js';

export type TaskExecutionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped_upstream_failed';

export interface TaskExecutionRecord {
  task_id: string;
  status: TaskExecutionStatus;
  started_at?: string;
  ended_at?: string;
  session_id?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  summary?: string;
  error?: string;
  transcript_path?: string;
}

export interface ExecuteTaskPlanParams {
  missionId: string;
  onDependencyFailure?: 'skip' | 'continue';
  maxTasks?: number;
  model?: string;
  cwd?: string;
  allowedTools?: string[];
  abortController?: AbortController;
  haltOnFailure?: boolean;
  executionPort?: AgentExecutionPort;
}

export interface ExecuteTaskPlanResult {
  mission_id: string;
  plan_version: string;
  total_tasks: number;
  succeeded: number;
  failed: number;
  skipped: number;
  log_path: string;
  records: TaskExecutionRecord[];
}

export interface TaskPlanCoordinatorPort {
  execute(params: ExecuteTaskPlanParams): Promise<ExecuteTaskPlanResult>;
}

let registeredTaskPlanCoordinator: TaskPlanCoordinatorPort | undefined;

export function registerTaskPlanCoordinator(port: TaskPlanCoordinatorPort): void {
  registeredTaskPlanCoordinator = port;
}

export function resetTaskPlanCoordinator(): void {
  registeredTaskPlanCoordinator = undefined;
}

export function getTaskPlanCoordinator(): TaskPlanCoordinatorPort {
  if (!registeredTaskPlanCoordinator) {
    throw new Error(
      '[TASK_PLAN_COORDINATOR_UNAVAILABLE] execute_task_plan must be routed through orchestrator-actuator'
    );
  }
  return registeredTaskPlanCoordinator;
}
