/**
 * PI-08: resume a suspended pipeline after its exact approval is decided.
 *
 * This module is intentionally independent of approval-store.ts. The
 * approval store dynamically imports it after persisting the decision, which
 * keeps approval surfaces synchronous and avoids an import cycle.
 */

import type { ApprovalRequestRecord } from './approval-store.js';
import { spawnManagedProcess } from './managed-process.js';
import { loadPipelineRunJournal } from './pipeline-run-journal.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath } from './secure-io.js';

export type PipelineApprovalResumeOutcome =
  | { status: 'not_applicable'; reason: string }
  | { status: 'already_running'; reason: string; runId: string }
  | { status: 'started'; reason: string; runId: string; resourceId: string };

const pendingResumes = new Set<string>();

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function isSafeRunId(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/u.test(value);
}

function approvalBindsToSuspendedRun(
  record: ApprovalRequestRecord,
  runId: string,
  missionId: string | undefined,
  state: ReturnType<typeof loadPipelineRunJournal>
): string | undefined {
  if (state.run_id !== runId) return 'pipeline journal id does not match requested run';
  const context = record.requestedByContext;
  const stepId = nonEmpty(context?.stepId);
  if (!stepId || state.suspended?.step_id !== stepId)
    return 'approval step does not match suspended step';
  if (state.suspended.approval_request_id !== record.id) {
    return 'approval request does not match suspended run';
  }
  if (state.suspended.storage_channel !== record.storageChannel) {
    return 'approval storage channel does not match suspended run';
  }
  if (context?.actorId !== `pipeline:${runId}` || record.requestedBy !== context.actorId) {
    return 'approval requester is not bound to the pipeline run';
  }
  const expectedCorrelation = `pipeline:${runId}:${stepId}`;
  if (record.correlationId !== expectedCorrelation) {
    return 'approval correlation is not bound to the pipeline step';
  }
  const startedMissionId = nonEmpty(state.started?.mission_id);
  if (missionId !== startedMissionId) {
    return 'approval mission does not match the pipeline run';
  }
  if (state.finished) return 'pipeline run is already finished';
  return undefined;
}

/**
 * Launch the canonical pipeline runner only when the approval record and
 * suspended journal agree on every durable binding. A malformed or stale
 * approval is reported as a non-starting outcome so callers can retain the
 * operator-visible manual resume path without widening execution authority.
 */
export function resumePipelineRunAfterApproval(
  record: ApprovalRequestRecord
): PipelineApprovalResumeOutcome {
  if (record.status !== 'approved' || record.kind !== 'mission_gate') {
    return { status: 'not_applicable', reason: 'approval is not an approved mission gate' };
  }
  const context = record.requestedByContext;
  const runId = nonEmpty(context?.pipelineRunId);
  if (!runId || !isSafeRunId(runId)) {
    return { status: 'not_applicable', reason: 'approval has no safe pipeline run binding' };
  }
  const missionId = nonEmpty(context?.missionId);
  const resourceId = `pipeline-run-resume:${runId}`;
  if (pendingResumes.has(resourceId)) {
    return {
      status: 'already_running',
      reason: 'pipeline resume launch is already in flight',
      runId,
    };
  }

  const state = loadPipelineRunJournal(runId, missionId);
  if (state.finished) {
    return { status: 'not_applicable', reason: 'pipeline run is already finished' };
  }
  const mismatch = approvalBindsToSuspendedRun(record, runId, missionId, state);
  if (mismatch) return { status: 'not_applicable', reason: mismatch };

  const runnerPath = assertSafeRepositoryPath(
    pathResolver.rootResolve('dist/scripts/run_pipeline.js')
  );
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (missionId) env.MISSION_ID = missionId;
  else delete env.MISSION_ID;

  pendingResumes.add(resourceId);
  try {
    const handle = spawnManagedProcess({
      resourceId,
      kind: 'service',
      ownerId: missionId || `pipeline:${runId}`,
      ownerType: 'pipeline-approval-resume',
      command: process.execPath,
      args: [runnerPath, '--resume', runId],
      spawnOptions: {
        cwd: pathResolver.rootDir(),
        env,
        detached: true,
        stdio: 'ignore',
      },
      shutdownPolicy: 'detached',
      metadata: {
        pipelineRunId: runId,
        approvalRequestId: record.id,
        ...(missionId ? { missionId } : {}),
        stepId: context?.stepId,
      },
    });
    handle.child.once('exit', () => pendingResumes.delete(resourceId));
  } catch (error) {
    pendingResumes.delete(resourceId);
    throw error;
  }

  return {
    status: 'started',
    reason: `pipeline resume started for approved step ${context?.stepId}`,
    runId,
    resourceId,
  };
}

/** Test seam for a process that wants to await outstanding launch calls. */
export function resetPipelineApprovalResumeState(): void {
  pendingResumes.clear();
}
