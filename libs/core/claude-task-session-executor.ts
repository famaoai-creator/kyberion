import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { safeWriteFile } from './secure-io.js';
import { recordTaskSessionHistory, updateTaskSession, type TaskSession } from './task-session.js';
import {
  runApprovedClaudeBrowserTask,
  runApprovedClaudeDocumentTask,
  type ClaudeTaskRunnerContext,
} from './claude-task-runner.js';

export type ClaudeTaskSessionKind = 'browser' | 'document';

export interface ExecuteApprovedClaudeTaskSessionParams {
  session: TaskSession;
  queryText: string;
  agentId: string;
  channel?: string;
  correlationId?: string;
  missionId?: string;
}

export interface ExecuteApprovedClaudeTaskSessionResult {
  kind: ClaudeTaskSessionKind;
  output: string;
  outputPath: string;
  session: TaskSession;
}

function resolveTaskKind(taskType: TaskSession['task_type']): ClaudeTaskSessionKind | null {
  if (taskType === 'browser') return 'browser';
  if (taskType === 'report_document' || taskType === 'document_generation') return 'document';
  return null;
}

function buildTaskInstruction(params: ExecuteApprovedClaudeTaskSessionParams): string {
  const lines = [
    `Complete the governed ${params.session.task_type} task session.`,
    `Session ID: ${params.session.session_id}`,
    `Goal: ${params.session.goal.summary}`,
    `Success condition: ${params.session.goal.success_condition}`,
    params.missionId ? `Mission ID: ${params.missionId}` : '',
    params.queryText.trim() ? `User request: ${params.queryText.trim()}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function buildTaskContext(params: ExecuteApprovedClaudeTaskSessionParams): string {
  return JSON.stringify(
    {
      session_id: params.session.session_id,
      task_type: params.session.task_type,
      surface: params.session.surface,
      project_context: params.session.project_context ?? null,
      requirements: params.session.requirements ?? null,
      payload: params.session.payload ?? null,
      mission_id: params.missionId ?? null,
      query_text: params.queryText,
    },
    null,
    2,
  );
}

function buildApprovalContext(params: ExecuteApprovedClaudeTaskSessionParams): ClaudeTaskRunnerContext {
  return {
    agentId: params.agentId,
    channel: params.channel ?? 'surface',
    correlationId: params.correlationId,
    payload: {
      session_id: params.session.session_id,
      task_type: params.session.task_type,
      mission_id: params.missionId,
      surface: params.session.surface,
      query_text: params.queryText,
    },
    draft: {
      title: `Claude ${params.session.task_type} task approval`,
      summary: `Execute Claude-backed ${params.session.task_type} session ${params.session.session_id}.`,
      severity: 'high',
    },
  };
}

function buildOutputPath(sessionId: string): string {
  return pathResolver.sharedTmp(`claude-task-sessions/${sessionId}.txt`);
}

export async function executeApprovedClaudeTaskSession(
  params: ExecuteApprovedClaudeTaskSessionParams,
): Promise<ExecuteApprovedClaudeTaskSessionResult> {
  const kind = resolveTaskKind(params.session.task_type);
  if (!kind) {
    throw new Error(`Unsupported Claude task-session type: ${params.session.task_type}`);
  }

  const instruction = buildTaskInstruction(params);
  const context = buildTaskContext(params);
  const approvalContext = buildApprovalContext(params);

  logger.info(
    `[claude-task-session-executor] running ${kind} task session ${params.session.session_id} via approved Claude runner`,
  );

  try {
    const output =
      kind === 'browser'
        ? await runApprovedClaudeBrowserTask(
            { instruction, context, maxTurns: 10 },
            approvalContext,
          )
        : await runApprovedClaudeDocumentTask(
            { instruction, context, maxTurns: 15 },
            approvalContext,
          );

    const outputPath = buildOutputPath(params.session.session_id);
    safeWriteFile(outputPath, `${output.trim()}\n`, { mkdir: true, encoding: 'utf8' });

    const updated = updateTaskSession(params.session.session_id, {
      status: 'completed',
      artifact: {
        kind: `claude_${kind}_output`,
        output_path: outputPath,
        preview_text: output.slice(0, 500),
        storage_class: 'tmp',
      },
    });

    if (updated) {
      const timestamp = new Date().toISOString();
      recordTaskSessionHistory(updated.session_id, {
        ts: timestamp,
        type: 'execution',
        text: `Claude ${kind} task executed via approval-gated runner.`,
      });
      recordTaskSessionHistory(updated.session_id, {
        ts: timestamp,
        type: 'artifact',
        text: `Output stored at ${outputPath}.`,
      });
    }

    return {
      kind,
      output,
      outputPath,
      session: updated || params.session,
    };
  } catch (error: any) {
    const message = error?.message || String(error);
    const blocked = updateTaskSession(params.session.session_id, {
      status: 'blocked',
      artifact: {
        kind: `claude_${kind}_output`,
        preview_text: message.slice(0, 500),
        storage_class: 'tmp',
      },
    });
    if (blocked) {
      const timestamp = new Date().toISOString();
      recordTaskSessionHistory(blocked.session_id, {
        ts: timestamp,
        type: 'error',
        text: `Claude ${kind} task failed: ${message}`,
      });
    }
    throw error;
  }
}
