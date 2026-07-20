import {
  getAgentExecutionPort,
  logger,
  missionEvidenceDir,
  readTaskPlan,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  type AgentExecutionPort,
  type ExecuteTaskPlanParams,
  type ExecuteTaskPlanResult,
  type TaskExecutionRecord,
  type TaskPlan,
  type TaskPlanCoordinatorPort,
} from '@agent/core';
import * as path from 'node:path';

const LOG_FILE = 'task-execution-log.jsonl';

function topologicalOrder(plan: TaskPlan): string[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of plan.tasks) {
    indegree.set(task.task_id, 0);
    dependents.set(task.task_id, []);
  }
  for (const task of plan.tasks) {
    for (const dependency of task.depends_on || []) {
      if (!indegree.has(dependency)) {
        throw new Error(
          `[ORCHESTRATOR_TASK_PLAN_INVALID] ${task.task_id} depends on unknown task ${dependency}`
        );
      }
      indegree.set(task.task_id, (indegree.get(task.task_id) || 0) + 1);
      dependents.get(dependency)?.push(task.task_id);
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([taskId]) => taskId);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const taskId = ready.shift() as string;
    ordered.push(taskId);
    for (const dependent of dependents.get(taskId) || []) {
      const remaining = (indegree.get(dependent) || 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }
  if (ordered.length !== plan.tasks.length) {
    throw new Error(
      `[ORCHESTRATOR_TASK_PLAN_INVALID] dependency cycle detected (${ordered.length}/${plan.tasks.length} ordered)`
    );
  }
  return ordered;
}

function buildTaskInstruction(task: TaskPlan['tasks'][number], plan: TaskPlan): string {
  const lines = [
    'You are implementing one task from a governed task plan.',
    '',
    `PROJECT: ${plan.project_name}`,
    `TASK ID: ${task.task_id}`,
    `TITLE: ${task.title}`,
    `SUMMARY: ${task.summary}`,
    `PRIORITY: ${task.priority}`,
    `ESTIMATE: ${task.estimate}`,
    task.assigned_role ? `ROLE: ${task.assigned_role}` : '',
    task.fulfills_requirements?.length
      ? `FULFILLS REQUIREMENTS: ${task.fulfills_requirements.join(', ')}`
      : '',
    task.design_refs?.length ? `DESIGN REFS: ${task.design_refs.join(', ')}` : '',
    task.depends_on?.length ? `DEPENDS ON (already completed): ${task.depends_on.join(', ')}` : '',
    task.inputs?.length ? `INPUTS: ${task.inputs.join(', ')}` : '',
    task.deliverables?.length ? `DELIVERABLES: ${task.deliverables.join(', ')}` : '',
    task.test_criteria?.length
      ? `TEST CRITERIA:\n${task.test_criteria.map((criterion) => `- ${criterion}`).join('\n')}`
      : '',
    '',
    'Work plan:',
    '1. Re-read the relevant requirements and design files under the mission evidence directory.',
    '2. Implement the task with a small focused diff.',
    '3. Add or update tests covering the task criteria.',
    '4. Run the project typecheck and relevant tests before finishing.',
    '5. End with a short summary of changes and verification.',
  ];
  return lines.filter(Boolean).join('\n');
}

async function executeOneTask(
  task: TaskPlan['tasks'][number],
  plan: TaskPlan,
  params: ExecuteTaskPlanParams,
  executionPort: AgentExecutionPort
): Promise<TaskExecutionRecord> {
  const startedAt = new Date().toISOString();
  const record: TaskExecutionRecord = {
    task_id: task.task_id,
    status: 'running',
    started_at: startedAt,
  };
  try {
    const receipt = await executionPort.delegate({
      task_id: task.task_id,
      mission_id: params.missionId,
      agent_id: `task-agent-${params.missionId}-${task.task_id}`,
      agent_profile_id: 'reasoning-worker',
      team_role_id: task.assigned_role,
      security_scope: {
        tenant_id: 'default',
        mission_id: params.missionId,
        read_tiers: ['public', 'confidential'],
        write_tier: 'confidential',
        purpose: 'task-plan-execution',
      },
      instruction: buildTaskInstruction(task, plan),
      capabilities: params.allowedTools,
      timeout_ms: 600_000,
      idempotency_key: `task-plan:${params.missionId}:${task.task_id}`,
      model_id: params.model,
    });
    record.session_id = receipt.runtime_id;
    record.duration_ms =
      receipt.started_at && receipt.completed_at
        ? Date.parse(receipt.completed_at) - Date.parse(receipt.started_at)
        : undefined;
    if (receipt.status === 'succeeded') {
      record.status = 'succeeded';
      record.summary = receipt.output || receipt.output_ref || '';
    } else {
      record.status = 'failed';
      record.error = receipt.error || `agent receipt status=${receipt.status}`;
      record.summary = record.error;
    }
  } catch (error: unknown) {
    record.status = 'failed';
    record.error = error instanceof Error ? error.message : String(error);
  }
  record.ended_at = new Date().toISOString();
  return record;
}

function appendExecutionLedger(missionId: string, record: TaskExecutionRecord): string {
  const evidenceDir = missionEvidenceDir(missionId);
  if (!evidenceDir) {
    throw new Error(
      `[ORCHESTRATOR_LEDGER_UNAVAILABLE] mission evidence dir not found: ${missionId}`
    );
  }
  const logPath = path.join(evidenceDir, LOG_FILE);
  const previous = safeExistsSync(logPath)
    ? (safeReadFile(logPath, { encoding: 'utf8' }) as string)
    : '';
  const line = JSON.stringify(record);
  const next =
    previous.length > 0 && !previous.endsWith('\n')
      ? `${previous}\n${line}\n`
      : `${previous}${line}\n`;
  safeWriteFile(logPath, next, { encoding: 'utf8', mkdir: true });
  return logPath;
}

export async function executeTaskPlanFromOrchestrator(
  params: ExecuteTaskPlanParams
): Promise<ExecuteTaskPlanResult> {
  const plan = readTaskPlan(params.missionId);
  if (!plan) throw new Error(`[ORCHESTRATOR_TASK_PLAN_NOT_FOUND] ${params.missionId}`);

  const orderedTaskIds = topologicalOrder(plan);
  const taskById = new Map(plan.tasks.map((task) => [task.task_id, task]));
  const records = new Map<string, TaskExecutionRecord>();
  const executionPort = params.executionPort || getAgentExecutionPort();
  const maxTasks = params.maxTasks ?? orderedTaskIds.length;
  let logPath = '';
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const taskId of orderedTaskIds.slice(0, maxTasks)) {
    const task = taskById.get(taskId);
    if (!task) throw new Error(`[ORCHESTRATOR_TASK_PLAN_INVALID] missing task ${taskId}`);
    const failedDependencies = (task.depends_on || []).filter((dependency) => {
      const status = records.get(dependency)?.status;
      return status === 'failed' || status === 'skipped_upstream_failed';
    });
    if (failedDependencies.length > 0) {
      const now = new Date().toISOString();
      const record: TaskExecutionRecord = {
        task_id: task.task_id,
        status: 'skipped_upstream_failed',
        started_at: now,
        ended_at: now,
        error: `dependencies failed or skipped: ${failedDependencies.join(', ')}`,
      };
      records.set(task.task_id, record);
      logPath = appendExecutionLedger(params.missionId, record);
      skipped += 1;
      logger.warn(`[orchestrator] skipping ${task.task_id}: ${record.error}`);
      continue;
    }

    logger.info(`[orchestrator] running ${task.task_id} (${task.title})`);
    const record = await executeOneTask(task, plan, params, executionPort);
    records.set(task.task_id, record);
    logPath = appendExecutionLedger(params.missionId, record);
    if (record.status === 'succeeded') succeeded += 1;
    else {
      failed += 1;
      if (params.haltOnFailure) break;
    }
  }

  return {
    mission_id: params.missionId,
    plan_version: plan.version,
    total_tasks: orderedTaskIds.length,
    succeeded,
    failed,
    skipped,
    log_path: logPath,
    records: orderedTaskIds
      .map((taskId) => records.get(taskId))
      .filter((record): record is TaskExecutionRecord => record !== undefined),
  };
}

export const taskPlanCoordinator: TaskPlanCoordinatorPort = {
  execute: executeTaskPlanFromOrchestrator,
};
