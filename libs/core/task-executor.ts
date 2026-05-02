/**
 * Task Executor — carries a mission's task-plan.json through to completion
 * by spawning a Claude Code sub-agent per task with full tool access.
 *
 * Key distinction from the ReasoningBackend / IntentExtractor path: those
 * run with `tools: []` (pure reasoning). Here we give the sub-agent the
 * real `claude_code` tool preset so it can read, edit, run tests, etc.
 *
 * Ordering: topological sort on task.depends_on. Cycles were already
 * rejected by evaluateTaskPlanReadyGate, but we re-check defensively.
 *
 * Failure handling: if a task fails (non-zero exit, timeout, or agent
 * error), subsequent tasks that depend on it are skipped and the execution
 * log records them as `skipped_upstream_failed`. The executor resolves
 * with the full log so callers can decide whether to retry individual
 * tasks.
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';
import { logger } from './core.js';
import { safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { missionEvidenceDir, rootResolve } from './path-resolver.js';
import { readTaskPlan, type TaskPlan } from './sdlc-artifact-store.js';

const LOG_FILE = 'task-execution-log.jsonl';

export type TaskExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped_upstream_failed';

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
  /** Resolution policy when a dependency fails. Defaults to 'skip'. */
  onDependencyFailure?: 'skip' | 'continue';
  /** Cap task count (useful for dry-running the first N tasks). */
  maxTasks?: number;
  /** Model alias passed to the sub-agent. Defaults to 'opus'. */
  model?: string;
  /** Working directory for the sub-agent. Defaults to the project root in higher-level callers. */
  cwd?: string;
  /** Extra allowedTools to auto-approve beyond the claude_code preset. */
  allowedTools?: string[];
  /** Abort controller to cancel the whole run. */
  abortController?: AbortController;
  /** If true, stop after the first failure instead of skipping downstream. */
  haltOnFailure?: boolean;
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

function topologicalOrder(plan: TaskPlan): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const task of plan.tasks) {
    indeg.set(task.task_id, 0);
    adj.set(task.task_id, []);
  }
  for (const task of plan.tasks) {
    for (const dep of task.depends_on ?? []) {
      if (indeg.has(dep)) {
        indeg.set(task.task_id, (indeg.get(task.task_id) ?? 0) + 1);
        adj.get(dep)?.push(task.task_id);
      }
    }
  }
  const queue: string[] = [];
  for (const [id, deg] of indeg) if (deg === 0) queue.push(id);
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const next of adj.get(id) ?? []) {
      const remaining = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (out.length !== plan.tasks.length) {
    throw new Error(`[task-executor] task-plan has a dependency cycle (ran topo sort, got ${out.length}/${plan.tasks.length})`);
  }
  return out;
}

function buildTaskPrompt(task: TaskPlan['tasks'][number], plan: TaskPlan): string {
  const lines: string[] = [
    `You are implementing one task from a governed task plan.`,
    ``,
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
      ? `TEST CRITERIA:\n${task.test_criteria.map((c) => `- ${c}`).join('\n')}`
      : '',
    ``,
    `Work plan:`,
    `1. Re-read the relevant requirements / design files under active/missions/<id>/evidence/ if they exist.`,
    `2. Implement the task. Prefer small focused diffs.`,
    `3. Add or update tests covering the test_criteria (if any).`,
    `4. Before finishing, run the project's typecheck / tests and verify they pass.`,
    `5. End with a short summary of what you changed and how you verified it.`,
    ``,
    `If you cannot complete the task (missing context, external dependency, ambiguity), stop and explain what blocks you.`,
  ];
  return lines.filter(Boolean).join('\n');
}

async function runOneTask(
  task: TaskPlan['tasks'][number],
  plan: TaskPlan,
  params: ExecuteTaskPlanParams,
): Promise<TaskExecutionRecord> {
  const record: TaskExecutionRecord = {
    task_id: task.task_id,
    status: 'running',
    started_at: new Date().toISOString(),
  };

  const options: Options = {
    model: params.model ?? 'opus',
    tools: { type: 'preset', preset: 'claude_code' },
    permissionMode: 'dontAsk',
    maxTurns: 50,
    cwd: params.cwd,
    abortController: params.abortController,
    allowedTools: params.allowedTools,
  };

  try {
    const iterator = query({ prompt: buildTaskPrompt(task, plan), options });
    let lastAssistantText = '';
    for await (const message of iterator) {
      if (message.type === 'assistant') {
        const content = (message as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block?.type === 'text' && typeof block.text === 'string') {
              lastAssistantText = block.text;
            }
          }
        }
      } else if (message.type === 'result') {
        record.session_id = (message as any).session_id;
        record.total_cost_usd = (message as any).total_cost_usd ?? 0;
        record.duration_ms = (message as any).duration_ms ?? 0;
        if (message.subtype === 'success') {
          record.status = 'succeeded';
          record.summary = ((message as any).result as string | undefined) ?? lastAssistantText ?? '';
        } else {
          record.status = 'failed';
          record.error = `result.subtype=${(message as any).subtype}`;
          record.summary = lastAssistantText || record.error;
        }
        break;
      }
    }
  } catch (err: any) {
    record.status = 'failed';
    record.error = err?.message ?? String(err);
  } finally {
    record.ended_at = new Date().toISOString();
  }
  return record;
}

function appendLog(missionId: string, record: TaskExecutionRecord): string {
  const dir = missionEvidenceDir(missionId);
  if (!dir) throw new Error(`[task-executor] mission evidence dir not found for ${missionId}`);
  const file = path.join(dir, LOG_FILE);
  const existing = safeExistsSync(file) ? (safeReadFile(file, { encoding: 'utf8' }) as string) : '';
  const line = JSON.stringify(record);
  const next = existing.length > 0 && !existing.endsWith('\n')
    ? `${existing}\n${line}\n`
    : `${existing}${line}\n`;
  safeWriteFile(file, next, { encoding: 'utf8', mkdir: true });
  return file;
}

export async function executeTaskPlan(
  params: ExecuteTaskPlanParams,
): Promise<ExecuteTaskPlanResult> {
  const plan = readTaskPlan(params.missionId);
  if (!plan) throw new Error(`[task-executor] no task-plan.json for ${params.missionId}`);

  const order = topologicalOrder(plan);
  const taskById = new Map(plan.tasks.map((t) => [t.task_id, t]));
  const records = new Map<string, TaskExecutionRecord>();

  const limit = params.maxTasks ?? order.length;
  let logPath = '';
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  for (const taskId of order.slice(0, limit)) {
    const task = taskById.get(taskId)!;
    // Skip if any dependency failed
    const failedDeps = (task.depends_on ?? []).filter(
      (dep) => records.get(dep)?.status === 'failed' || records.get(dep)?.status === 'skipped_upstream_failed',
    );
    if (failedDeps.length > 0) {
      const record: TaskExecutionRecord = {
        task_id: task.task_id,
        status: 'skipped_upstream_failed',
        started_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
        error: `dependencies failed or skipped: ${failedDeps.join(', ')}`,
      };
      records.set(task.task_id, record);
      logPath = appendLog(params.missionId, record);
      skipped += 1;
      logger.warn(`[task-executor] skipping ${task.task_id} — upstream failed: ${failedDeps.join(', ')}`);
      continue;
    }

    logger.info(`[task-executor] running ${task.task_id} (${task.title})`);
    const record = await runOneTask(task, plan, params);
    records.set(task.task_id, record);
    logPath = appendLog(params.missionId, record);
    if (record.status === 'succeeded') {
      succeeded += 1;
    } else {
      failed += 1;
      if (params.haltOnFailure) {
        logger.error(`[task-executor] halting on failure of ${task.task_id}`);
        break;
      }
    }
  }

  return {
    mission_id: params.missionId,
    plan_version: plan.version,
    total_tasks: order.length,
    succeeded,
    failed,
    skipped,
    log_path: logPath,
    records: order.map((id) => records.get(id)).filter((r): r is TaskExecutionRecord => r != null),
  };
}
