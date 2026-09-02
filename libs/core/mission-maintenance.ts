import { appendJsonLine, readJson, readJsonLines } from './foundation/json.js';
/**
 * scripts/refactor/mission-maintenance.ts
 * Maintenance and recovery operations for missions.
 */

import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { logger } from './core.js';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeRmSync,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import { sendOpsAlert } from './ops-alert.js';
import { withLock } from './src/lock-utils.js';
import {
  appendMissionExecutionLedgerEntry,
  type MissionActorType,
} from './mission-team-binding.js';
import { TraceContext, persistTrace } from './src/trace.js';
import { loadMissionOrchestrationReplayPlan } from './mission-orchestration-journal.js';
import {
  enqueueMissionOrchestrationEvent,
  startMissionOrchestrationWorker,
} from './mission-orchestration-events.js';
import {
  recoverMissionRequestedTasks,
  reissueBlockedMissionTasks,
} from './mission-task-recovery.js';
import {
  buildArtifactReviewReceipt,
  evaluateArtifactReviews,
  hashArtifactForReview,
  inferArtifactReviewKind,
  receiptToArtifactReviewDecision,
  type ArtifactReviewFinding,
} from './artifact-review.js';
import { recordApprovedIntentScopeChange } from './intent-snapshot-store.js';
import {
  assertCanGrantMissionAuthority,
  listActiveMissions,
  listMissionsInSearchDirs,
  loadState,
  saveState,
} from './mission-state.js';
import { emitMissionLifecycleIntentSnapshot } from './mission-intent-delta.js';
import {
  readMissionNextTasks,
  tryAutoCompleteTaskFromEvidence,
  writeMissionNextTasks,
} from './mission-lifecycle.js';
import { gcMissionRuntimeResidue } from './scope-offboarding.js';
import { retireIdentitiesForScopeBestEffort } from './nhi-lifecycle-governance.js';
import { writeDispatchArtifact } from './mission-dispatch-lifecycle.js';
import { generateMissionWorkReconciliationScaffold } from './mission-work-reconciliation.js';
import { loadMissionStateAtPath } from './mission-state-reader.js';

function safeMissionRoot(missionDir: string): string {
  return assertSafeRepositoryPath(missionDir, { allowMissingLeaf: true });
}

function safeMissionArtifactPath(missionDir: string, relativePath: string): string {
  return assertSafeRepositoryPath(path.join(safeMissionRoot(missionDir), relativePath), {
    allowMissingLeaf: true,
  });
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function resolveApprovalActor(requestedBy?: string): string {
  const resolvedActor =
    getRegisteredEnvText('KYBERION_PERSONA') || process.env.USER || 'mission_controller';
  const requested = String(requestedBy || '').trim();
  if (requested && requested !== resolvedActor) {
    throw new Error(
      `Approved-by identity mismatch: expected ${resolvedActor} but received ${requested}.`
    );
  }
  return resolvedActor;
}

/**
 * Materialize the operator-editable reconcile-work scaffold once a recovery
 * plan finds an interrupted provisioned write. Applying the manifest remains
 * a separate human-gated operation; resume only creates the bounded handoff.
 */
export function ensureRecoveryScaffold(missionId: string): string {
  const relativePath = `active/shared/tmp/reconciliation-${missionId}.scaffold.json`;
  const outputPath = assertSafeRepositoryPath(pathResolver.rootResolve(relativePath), {
    allowMissingLeaf: true,
  });
  if (safeExistsSync(outputPath)) return pathResolver.toRepoRelative(outputPath);
  return generateMissionWorkReconciliationScaffold({
    missionId,
    outputPath: relativePath,
    reason: 'Recover an interrupted provisioned artifact before orchestration replay.',
  }).manifest_path;
}

export async function createCheckpoint(args: {
  taskId: string;
  note: string;
  explicitMissionId?: string;
  readFocusedMissionId: () => string | null;
  writeFocusedMissionId: (missionId: string) => void;
  getGitHash: (cwd: string) => string;
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
}): Promise<void> {
  const { explicitMissionId, readFocusedMissionId } = args;
  if (explicitMissionId) {
    const targetMissionId = explicitMissionId.toUpperCase();
    const explicitState = loadState(targetMissionId);
    const explicitPath = findMissionPath(targetMissionId);
    if (explicitState?.status === 'active' && explicitPath) {
      return recordCheckpointForMission(targetMissionId, explicitPath, args);
    }
    logger.error(
      `Mission ${targetMissionId} is not active or could not be found. Checkpoint aborted.`
    );
    return;
  }

  const focusedMissionId = readFocusedMissionId();
  if (focusedMissionId) {
    const focusedState = loadState(focusedMissionId);
    const focusedPath = findMissionPath(focusedMissionId);
    if (focusedState?.status === 'active' && focusedPath) {
      return recordCheckpointForMission(focusedMissionId, focusedPath, args);
    }
  }

  const activeMissions = listActiveMissions();

  if (activeMissions.length === 0) {
    logger.error('No active mission found. Checkpoint aborted.');
    logger.info('  To activate a mission:  mission_controller start <MISSION_ID>');
    logger.info('  To see all missions:    mission_controller list');
    return;
  }

  if (activeMissions.length > 1) {
    logger.error(
      'Multiple active missions found. Checkpoint aborted to avoid writing to the wrong mission.'
    );
    logger.info(
      '  Specify the target mission explicitly: mission_controller checkpoint <MISSION_ID> <TASK_ID> "<NOTE>"'
    );
    logger.info(
      '  Or use: mission_controller checkpoint --mission-id <MISSION_ID> <TASK_ID> "<NOTE>"'
    );
    return;
  }

  const [activeMission] = activeMissions;
  return recordCheckpointForMission(activeMission.missionId, activeMission.missionPath, args);
}

async function recordCheckpointForMission(
  activeMissionId: string,
  missionPath: string,
  args: {
    taskId: string;
    note: string;
    writeFocusedMissionId: (missionId: string) => void;
    getGitHash: (cwd: string) => string;
    syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
  }
): Promise<void> {
  const { taskId, note, writeFocusedMissionId, getGitHash, syncProjectLedgerIfLinked } = args;
  const safeMissionDir = safeMissionRoot(missionPath);
  writeFocusedMissionId(activeMissionId);

  const state = loadState(activeMissionId);
  if (!state) return;

  // Phase B-1.5: every checkpoint emits a Trace, so the structured observability
  // pipeline (Chronos viewer, distill, error-classifier) can correlate
  // checkpoint events with surrounding actuator activity.
  const traceCtx = new TraceContext(`mission_controller:checkpoint:${activeMissionId}`, {
    actuator: 'mission_controller',
    missionId: activeMissionId,
    correlationId: state.correlation_id,
  });
  traceCtx.addEvent('checkpoint.requested', { task_id: taskId, note: note.slice(0, 200) });

  logger.info(`📸 Checkpoint for ${activeMissionId}: ${taskId}...`);
  let traceStatus: 'ok' | 'error' = 'ok';
  try {
    await withLock(`mission-${activeMissionId}`, async () => {
      traceCtx.startSpan('git.stage');
      try {
        safeExec('git', ['add', '.'], { cwd: safeMissionDir });
        traceCtx.endSpan('ok');
      } catch (err: any) {
        traceCtx.endSpan('error', err?.message);
        throw err;
      }

      let commitCreated = true;
      traceCtx.startSpan('git.commit');
      try {
        safeExec('git', ['commit', '-m', `checkpoint(${activeMissionId}): ${taskId} - ${note}`], {
          cwd: safeMissionDir,
        });
        traceCtx.endSpan('ok');
      } catch (_) {
        // git commit fails when there are no staged changes — that is the
        // "state-only checkpoint" path, NOT an error condition.
        logger.info('No new changes in mission repo — recording state-only checkpoint.');
        commitCreated = false;
        traceCtx.addEvent('git.commit.skipped_no_changes');
        traceCtx.endSpan('ok');
      }

      const hash = getGitHash(safeMissionDir);
      traceCtx.startSpan('state.save');
      const currentState = loadState(activeMissionId)!;
      currentState.git.latest_commit = hash;
      currentState.git.checkpoints.push({
        task_id: taskId,
        commit_hash: hash,
        ts: new Date().toISOString(),
      });
      await saveState(activeMissionId, currentState, { alreadyLocked: true });
      traceCtx.addEvent('checkpoint.recorded', {
        commit_hash: hash,
        commit_created: commitCreated,
        checkpoint_count: currentState.git.checkpoints.length,
      });
      traceCtx.endSpan('ok');

      logger.success(
        `✅ Recorded checkpoint ${hash} in mission repo${commitCreated ? '' : ' (state-only)'}.`
      );
    });

    traceCtx.startSpan('project_ledger.sync');
    try {
      await syncProjectLedgerIfLinked(activeMissionId);
      traceCtx.endSpan('ok');
    } catch (err: any) {
      // Ledger sync failure must not fail the checkpoint, but we record it.
      traceCtx.endSpan('error', err?.message);
      throw err;
    }

    traceCtx.startSpan('intent_delta.emit');
    try {
      await emitMissionLifecycleIntentSnapshot({
        missionId: activeMissionId,
        stage: 'execution',
        text: note || taskId,
        source: 'mission_state',
        traceRef: state.correlation_id,
      });
      traceCtx.endSpan('ok');
    } catch (err: any) {
      traceCtx.endSpan('error', err?.message);
      throw err;
    }
  } catch (err: any) {
    traceStatus = 'error';
    logger.error(`Checkpoint failed: ${err.message}`);
  } finally {
    // Persistence must never break the checkpoint flow itself.
    try {
      const trace = traceCtx.finalize();
      // If finalize ran via the inner try/finally already setting status, force
      // the rootSpan status to reflect outer outcome (children may have all been ok
      // but a step after the lock could still have thrown).
      if (traceStatus === 'error' && trace.rootSpan.status !== 'error') {
        trace.rootSpan.status = 'error';
      }
      persistTrace(trace);
    } catch (persistErr: any) {
      logger.warn(
        `[mission-maintenance] Failed to persist checkpoint trace: ${persistErr?.message || persistErr}`
      );
    }
  }
}

export async function approveScopeChange(args: {
  missionId: string;
  approvedBy?: string;
  reason: string;
  goalSummary: string;
  successCondition?: string;
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
}): Promise<void> {
  assertCanGrantMissionAuthority();
  const missionId = args.missionId.toUpperCase();
  const missionPathCandidate = findMissionPath(missionId);
  if (!missionPathCandidate) {
    throw new Error(`Mission directory for ${missionId} not found.`);
  }
  safeMissionRoot(missionPathCandidate);

  const goalSummary = String(args.goalSummary || '').trim();
  if (!goalSummary) {
    throw new Error('A non-empty goal summary is required to approve a scope change.');
  }
  const successCondition = String(args.successCondition || goalSummary).trim();
  const approvedAt = new Date().toISOString();
  const approvedBy = resolveApprovalActor(args.approvedBy);

  await withLock(`mission-${missionId}`, async () => {
    const state = loadState(missionId);
    if (!state) {
      throw new Error(`Mission ${missionId} not found.`);
    }

    const intent = {
      goal: goalSummary,
      constraints: state.outcome_contract?.success_criteria || [],
      deliverables:
        state.outcome_contract?.expected_artifacts?.map((artifact) => artifact.kind) || [],
      stakeholders: state.relationships?.project?.project_id
        ? [state.relationships.project.project_id]
        : [],
    };

    const change = recordApprovedIntentScopeChange({
      missionId,
      approvedBy,
      reason: args.reason,
      intent,
      stage: 'scope_change',
      approvedAt,
    });

    state.intent = {
      ...(state.intent || {}),
      goal_summary: goalSummary,
      success_condition: successCondition,
      outcome_ids: state.intent?.outcome_ids || [],
    };
    state.context = {
      ...(state.context || {}),
      approved_scope_change: {
        approved_by: change.change.approved_by,
        approved_at: change.change.approved_at,
        reason: change.change.reason,
        previous_origin_snapshot_id: change.change.previous_origin_snapshot_id,
        new_origin_snapshot_id: change.change.new_origin_snapshot_id,
        goal_summary: goalSummary,
        success_condition: successCondition,
      },
    };
    state.history.push({
      ts: approvedAt,
      event: 'SCOPE_APPROVED',
      note: `Approved scope change by ${approvedBy}: ${args.reason}`,
    });

    await saveState(missionId, state, { alreadyLocked: true });
    // recordApprovedIntentScopeChange already emitted the new `origin`
    // snapshot. Do not append a second goal-only `current` snapshot here:
    // dropping the approved constraints/deliverables from that same event
    // would manufacture a minor field-churn delta immediately after a
    // legitimate rebaseline.
  });

  try {
    await args.syncProjectLedgerIfLinked(missionId);
  } catch (err: any) {
    logger.warn(
      `[mission-maintenance] scope approval ledger sync skipped for ${missionId}: ${err?.message || err}`
    );
  }
  logger.success(
    `✅ Approved scope change for ${missionId} by ${approvedBy} and reset the origin baseline to "${goalSummary}".`
  );
}

/**
 * Window in milliseconds during which repeated RESUME calls are coalesced
 * into a single history entry. Prevents history bloat across orchestrator
 * restarts / supervisor flapping for long-running (24h+) missions.
 */
export const RESUME_IDEMPOTENCY_WINDOW_MS = 60_000;

/**
 * Returns true if a fresh RESUME entry should be skipped because the most
 * recent history entry is already a RESUME within the idempotency window.
 * Pure function — exported for unit testing.
 */
export function shouldSkipResumeEntry(
  history: Array<{ ts: string; event: string }>,
  now: Date = new Date(),
  windowMs: number = RESUME_IDEMPOTENCY_WINDOW_MS
): boolean {
  const last = history[history.length - 1];
  if (!last || last.event !== 'RESUME') return false;
  const lastMs = new Date(last.ts).getTime();
  if (Number.isNaN(lastMs)) return false;
  return now.getTime() - lastMs < windowMs;
}

export async function resumeMission(
  id: string | undefined,
  args: {
    readFocusedMissionId: () => string | null;
    writeFocusedMissionId: (missionId: string) => void;
    getCurrentBranch: (cwd: string) => string;
    syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
  }
): Promise<void> {
  let targetId = id?.toUpperCase();

  if (!targetId) {
    for (const { missionId: active } of listActiveMissions()) {
      targetId = active;
      break;
    }

    if (!targetId) {
      logger.warn('No active mission found to resume.');
      return;
    }
  }

  // Pre-flight read (no mutation) — used only for branch switch decision and flight recorder display.
  const preState = loadState(targetId);
  if (!preState) throw new Error(`Mission ${targetId} not found.`);

  logger.info(`🔄 Resuming Mission: ${targetId}...`);
  const missionPathCandidate = findMissionPath(targetId);
  if (!missionPathCandidate) throw new Error(`Mission ${targetId} path not found.`);
  const missionPath = safeMissionRoot(missionPathCandidate);

  const replayPlan = loadMissionOrchestrationReplayPlan(targetId);
  if (replayPlan.recovery_required) {
    let scaffoldPath = 'unavailable';
    try {
      scaffoldPath = ensureRecoveryScaffold(targetId);
    } catch (error) {
      logger.warn(
        `Journal recovery scaffold could not be generated: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
    logger.warn(
      `Journal recovery blocked: ${replayPlan.unverified_provisioned_entries.length} unverified and ${replayPlan.missing_provisioned_entries.length} missing provision receipt(s) detected; automatic replay is stopped. Complete reconcile-work using scaffold=${scaffoldPath}.`
    );
  } else if (replayPlan.next_event) {
    logger.info(
      `journal から再開: 次イベント=${replayPlan.next_event.event_type} (${replayPlan.next_event.event_id}) / 回収タスク=${replayPlan.replay_count} 件`
    );
    // Restart the detached worker for the pending event. The replay plan used
    // to be display-only, so a failed chain stayed stalled until a surface
    // re-enqueued it by hand — resume is the operator's retry lever.
    const replayEventPath = startMissionOrchestrationWorker(replayPlan.next_event);
    logger.info(
      `orchestration worker を再起動しました: ${replayPlan.next_event.event_id} (${replayEventPath})`
    );
  } else {
    logger.info('journal から再開: 再開対象の orchestration event はありません。');
  }
  const recovery = recoverMissionRequestedTasks(targetId);
  logger.info(
    `lease 回収: requested=${recovery.requested_count} / waiting=${recovery.waiting_count} / reissued=${recovery.reissued_count}`
  );
  const blockedRetry = reissueBlockedMissionTasks(targetId);
  if (blockedRetry.reissued_task_ids.length > 0) {
    logger.info(
      `blocked タスクを planned に戻しました (再preflight対象): ${blockedRetry.reissued_task_ids.join(', ')}`
    );
  }

  const currentBranch = args.getCurrentBranch(missionPath);
  if (currentBranch !== preState.git.branch) {
    safeExec('git', ['checkout', preState.git.branch], { cwd: missionPath });
  }

  const flightRecorderPath = safeMissionArtifactPath(missionPath, 'LATEST_TASK.json');
  if (safeExistsSync(flightRecorderPath)) {
    const task = readJson<{ description?: string }>(flightRecorderPath);
    logger.warn(`📍 FLIGHT RECORDER DETECTED: Last intended task was: ${task.description}`);
    logger.info('Please verify the physical state and continue from this point.');
  }

  // Atomic RESUME: re-load fresh state inside the lock to avoid clobbering
  // a concurrent checkpoint, and dedupe RESUMEs within the idempotency window.
  let resumeEntryRecorded = false;
  await withLock(`mission-${targetId}`, async () => {
    const fresh = loadState(targetId!)!;
    const now = new Date();
    if (shouldSkipResumeEntry(fresh.history, now)) {
      const lastTs = new Date(fresh.history[fresh.history.length - 1].ts).getTime();
      logger.info(
        `↳ Skipping RESUME entry (last RESUME was ${Math.round(
          (now.getTime() - lastTs) / 1000
        )}s ago, within idempotency window).`
      );
    } else {
      fresh.history.push({
        ts: now.toISOString(),
        event: 'RESUME',
        note: 'Session re-established.',
      });
      resumeEntryRecorded = true;
      await saveState(targetId!, fresh, { alreadyLocked: true });
    }
  });

  // The provider runtime supervisor owns provider/agent process prewarm. A
  // paused goal is a mission-worker concern, so hand it to a dedicated,
  // journaled orchestration event after the explicit resume is recorded.
  // Do not enqueue when artifact recovery is blocked or when this resume was
  // coalesced with a recent one; both cases preserve at-most-once recovery
  // intent without silently applying a reconcile manifest.
  if (resumeEntryRecorded && !replayPlan.recovery_required) {
    const recoveryEvent = enqueueMissionOrchestrationEvent({
      eventType: 'mission_worker_recovery_requested',
      missionId: targetId,
      requestedBy: 'mission_controller',
      correlationId: `mission-resume:${targetId}`,
      payload: { operation: 'resume_goal_driven' },
    });
    const recoveryEventPath = startMissionOrchestrationWorker(recoveryEvent);
    logger.info(
      `Mission worker recovery started: ${recoveryEvent.event_id} (${recoveryEventPath})`
    );
  }

  await args.syncProjectLedgerIfLinked(targetId);
  args.writeFocusedMissionId(targetId);
  logger.success(`✅ Mission ${targetId} is back in focus.`);
}

export async function recordTask(
  missionId: string,
  description: string,
  details: any = {}
): Promise<void> {
  const upperId = missionId.toUpperCase();
  const missionDir = findMissionPath(upperId);
  if (!missionDir) throw new Error(`Mission ${upperId} not found.`);
  const detailRecord =
    details && typeof details === 'object' ? (details as Record<string, unknown>) : {};

  const safeMissionDir = safeMissionRoot(missionDir);
  const flightRecorderPath = safeMissionArtifactPath(safeMissionDir, 'LATEST_TASK.json');
  safeWriteFile(
    flightRecorderPath,
    JSON.stringify(
      {
        ts: new Date().toISOString(),
        description,
        details,
      },
      null,
      2
    )
  );

  await withLock(`mission-${upperId}`, async () => {
    const state = loadState(upperId);
    if (!state) return;
    const context = { ...(state.context || {}) } as Record<string, unknown>;
    context.last_action = description;
    if (typeof detailRecord.next_step === 'string' && detailRecord.next_step.trim()) {
      context.next_step = detailRecord.next_step.trim();
    }
    if (
      typeof detailRecord.routing_decision_summary === 'string' &&
      detailRecord.routing_decision_summary.trim()
    ) {
      context.routing_decision_summary = detailRecord.routing_decision_summary.trim();
    }
    if (typeof detailRecord.context_pack_id === 'string' && detailRecord.context_pack_id.trim()) {
      context.context_pack_id = detailRecord.context_pack_id.trim();
    }
    if (
      typeof detailRecord.context_pack_path === 'string' &&
      detailRecord.context_pack_path.trim()
    ) {
      context.context_pack_path = detailRecord.context_pack_path.trim();
    }
    if (
      typeof detailRecord.context_pack_summary === 'string' &&
      detailRecord.context_pack_summary.trim()
    ) {
      context.context_pack_summary = detailRecord.context_pack_summary.trim();
    }
    if (
      typeof detailRecord.context_chars === 'number' &&
      Number.isFinite(detailRecord.context_chars)
    ) {
      context.context_chars = detailRecord.context_chars;
    }
    if (
      typeof detailRecord.pruned_chars === 'number' &&
      Number.isFinite(detailRecord.pruned_chars)
    ) {
      context.pruned_chars = detailRecord.pruned_chars;
    }
    if (typeof detailRecord.rollup_used === 'boolean') {
      context.rollup_used = detailRecord.rollup_used;
    }
    if (typeof detailRecord.result_schema_ok === 'boolean') {
      context.result_schema_ok = detailRecord.result_schema_ok;
    }
    if (typeof detailRecord.needs_count === 'number' && Number.isFinite(detailRecord.needs_count)) {
      context.needs_count = detailRecord.needs_count;
    }
    if (
      detailRecord.context_pack_pruning_summary &&
      typeof detailRecord.context_pack_pruning_summary === 'object'
    ) {
      context.context_pack_pruning_summary = detailRecord.context_pack_pruning_summary;
    }
    if (
      detailRecord.work_item_dispatch_summary &&
      typeof detailRecord.work_item_dispatch_summary === 'object'
    ) {
      context.work_item_dispatch_summary = detailRecord.work_item_dispatch_summary;
    }
    if (
      detailRecord.ticket_dispatch_summary &&
      typeof detailRecord.ticket_dispatch_summary === 'object'
    ) {
      context.ticket_dispatch_summary = detailRecord.ticket_dispatch_summary;
    }
    if (
      typeof detailRecord.drift_watchdog_summary === 'string' &&
      detailRecord.drift_watchdog_summary.trim()
    ) {
      context.work_item_dispatch_summary = {
        ...(context.work_item_dispatch_summary &&
        typeof context.work_item_dispatch_summary === 'object'
          ? (context.work_item_dispatch_summary as Record<string, unknown>)
          : {}),
        drift_watchdog_summary: detailRecord.drift_watchdog_summary.trim(),
      };
    }
    state.context = context as NonNullable<typeof state.context>;
    state.history.push({
      ts: new Date().toISOString(),
      event: 'RECORD_TASK',
      note: description,
    });
    await saveState(upperId, state, { alreadyLocked: true });
  });

  logger.info(`📝 [FlightRecorder] Intention recorded: ${description}`);
}

export async function recordEvidence(args: {
  missionId: string;
  taskId: string;
  note: string;
  evidence?: string[];
  teamRole?: string;
  actorId?: string;
  actorType?: MissionActorType;
  getGitHash: (cwd: string) => string;
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
}): Promise<void> {
  const upperId = args.missionId.toUpperCase();
  const missionPathCandidate = findMissionPath(upperId);
  if (!missionPathCandidate) throw new Error(`Mission ${upperId} not found.`);
  const missionPath = safeMissionRoot(missionPathCandidate);

  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} state not found.`);
  if (state.status === 'archived') {
    throw new Error(`Mission ${upperId} is archived. Evidence cannot be recorded.`);
  }

  logger.info(`🧾 Evidence for ${upperId}: ${args.taskId}...`);

  await withLock(`mission-${upperId}`, async () => {
    appendMissionExecutionLedgerEntry({
      mission_id: upperId,
      mission_path_hint: missionPath,
      event_type: 'evidence_recorded',
      task_id: args.taskId,
      team_role: args.teamRole,
      actor_id: args.actorId,
      actor_type: args.actorType || (args.actorId ? 'agent' : undefined),
      decision: args.note,
      evidence: args.evidence || [],
      payload: {
        mission_status: state.status,
      },
    });

    // Close the NEXT_TASKS.json task out when its deliverable now exists and
    // its dependencies are already done — otherwise the documented
    // checkpoint+record-evidence flow (execution.md) silently never closes a
    // task, and `finish` fails with "Pending tasks remain" even though every
    // deliverable is in place. Gated on this explicit, task_id-scoped call so
    // a bare file-existence check is never trusted without an agent
    // deliberately asserting the work for THAT task is done.
    const autoComplete = tryAutoCompleteTaskFromEvidence(missionPath, args.taskId);
    if (autoComplete.completed) {
      logger.info(`✅ Task "${args.taskId}" auto-completed (${autoComplete.reason}).`);
    }

    safeExec('git', ['add', '.'], { cwd: missionPath });
    try {
      safeExec('git', ['commit', '-m', `evidence(${upperId}): ${args.taskId} - ${args.note}`], {
        cwd: missionPath,
      });
    } catch (_) {
      logger.info('No new changes in mission repo after evidence record.');
    }

    const hash = args.getGitHash(missionPath);
    const currentState = loadState(upperId)!;
    currentState.git.latest_commit = hash;
    currentState.history.push({
      ts: new Date().toISOString(),
      event: 'EVIDENCE',
      note: `${args.taskId}: ${args.note}`,
    });
    await saveState(upperId, currentState, { alreadyLocked: true });
  });

  await args.syncProjectLedgerIfLinked(upperId);
  logger.success(`✅ Recorded evidence for ${upperId}.`);
}

/** Distinct actor_ids that recorded evidence for `taskId` in this mission's execution ledger. */
function findLedgerActorIdsForTask(missionPath: string, taskId: string): string[] {
  const ledgerPath = safeMissionArtifactPath(missionPath, 'execution-ledger.jsonl');
  if (!safeExistsSync(ledgerPath)) return [];
  const actorIds = new Set<string>();
  const entries = readJsonLines<Record<string, unknown> | null>(ledgerPath, {
    onMalformed: 'skip',
    map: (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null,
  });
  for (const entry of entries) {
    if (entry?.task_id === taskId && entry.actor_id) actorIds.add(String(entry.actor_id));
  }
  return Array.from(actorIds);
}

export interface RecordArtifactReviewResult {
  /** Whether the receipt (as recorded) satisfies independence + no-blocking-findings. */
  status: 'recorded' | 'blocked';
  /** Whether the review task itself was auto-completed as a result. */
  taskCompleted: boolean;
  /** Non-empty only when status === 'blocked' — why the receipt doesn't clear the gate. */
  reasons: string[];
  receiptPath: string;
}

/**
 * Record a REAL review verdict for a review-kind task — the strict
 * counterpart to `recordEvidence` that `isReviewTaskSatisfied`
 * (mission-lifecycle.ts) requires before a review-kind task can complete.
 *
 * Independence is not self-declared by the caller: `implementer_agent_ids`
 * is computed from who ACTUALLY recorded evidence for the reviewed task in
 * this mission's own execution ledger, so a reviewer that happens to be the
 * same actor who did the implementation is a hard failure
 * (`evaluation.ready === false`), not a self-reported flag a caller could
 * fabricate.
 */
export async function recordArtifactReview(args: {
  missionId: string;
  reviewTaskId: string;
  reviewerAgentId: string;
  findings?: ArtifactReviewFinding[];
  reviewerTeamRole?: 'reviewer' | 'qa';
  specialistRoles?: string[];
  getGitHash: (cwd: string) => string;
}): Promise<RecordArtifactReviewResult> {
  const upperId = args.missionId.toUpperCase();
  const missionPathCandidate = findMissionPath(upperId);
  if (!missionPathCandidate) throw new Error(`Mission ${upperId} not found.`);
  const missionPath = safeMissionRoot(missionPathCandidate);

  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} state not found.`);
  if (state.status === 'archived') {
    throw new Error(`Mission ${upperId} is archived. Reviews cannot be recorded.`);
  }

  const nextTasks = readMissionNextTasks(missionPath);
  const task = nextTasks.find((entry) => String(entry.task_id || '') === args.reviewTaskId);
  if (!task) throw new Error(`Task "${args.reviewTaskId}" not found in NEXT_TASKS.json.`);
  const reviewTargetId = String(task.review_target || '');
  if (!reviewTargetId) {
    throw new Error(
      `Task "${args.reviewTaskId}" has no review_target — it is not a review-kind task.`
    );
  }
  const targetTask = nextTasks.find((entry) => String(entry.task_id || '') === reviewTargetId);
  const deliverable = String(targetTask?.deliverable || targetTask?.target_path || '');
  if (!deliverable) {
    throw new Error(`Review target "${reviewTargetId}" has no deliverable to review.`);
  }
  const artifactCandidate = path.resolve(missionPath, deliverable);
  if (!isPathInside(missionPath, artifactCandidate)) {
    throw new Error(`Reviewed artifact must remain inside the mission directory: ${deliverable}`);
  }
  const artifactPath = assertSafeRepositoryPath(artifactCandidate, { allowMissingLeaf: false });
  if (!safeExistsSync(artifactPath)) {
    throw new Error(`Reviewed artifact does not exist yet: ${deliverable}`);
  }
  // artifact_review_profile / the receipt store the artifact path
  // repo-root-relative (matching validateMissionArtifactReviewGate's
  // pathResolver.rootResolve, and mission-governance.test.ts's convention),
  // not mission-relative.
  const artifactReference = pathResolver.toRepoRelative(artifactPath);

  logger.info(
    `🔍 Recording review for ${upperId}: ${args.reviewTaskId} (target: ${reviewTargetId})...`
  );

  const implementerAgentIds = findLedgerActorIdsForTask(missionPath, reviewTargetId);
  const sha256Value = hashArtifactForReview(artifactPath);
  const kind = inferArtifactReviewKind(deliverable);

  const reviewerTeamRole = args.reviewerTeamRole || 'reviewer';
  // The receipt schema requires at least one entry in both arrays — fall
  // back to the team role / a generic review scope rather than let an
  // empty-array caller silently produce a receipt that fails validation.
  const specialistRoles =
    args.specialistRoles && args.specialistRoles.length > 0
      ? args.specialistRoles
      : [reviewerTeamRole];
  const acceptanceCriteria =
    Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length > 0
      ? task.acceptance_criteria.map(String)
      : ['Reviewed for correctness, security, and regression risk.'];

  const receipt = buildArtifactReviewReceipt({
    reviewId: `${args.reviewTaskId}-r1`,
    missionId: upperId,
    reviewTaskId: args.reviewTaskId,
    reviewTargetTaskId: reviewTargetId,
    artifact: { path: artifactReference, sha256: sha256Value, kind },
    reviewerAgentId: args.reviewerAgentId,
    reviewerTeamRole,
    specialistRoles,
    independentFrom: implementerAgentIds,
    findings: args.findings || [],
    acceptanceCriteria,
  });

  const receiptRelPath = `evidence/reviews/${args.reviewTaskId}-r1.json`;
  const receiptPath = safeMissionArtifactPath(missionPath, receiptRelPath);

  let evaluation: { ready: boolean; reasons: string[] } = { ready: false, reasons: [] };
  await withLock(`mission-${upperId}`, async () => {
    const reviewsDir = safeMissionArtifactPath(missionPath, 'evidence/reviews');
    if (!safeExistsSync(reviewsDir)) safeMkdir(reviewsDir, { recursive: true });
    writeDispatchArtifact(receiptPath, receipt, {
      missionId: upperId,
      missionPath,
    });

    // Stamp the task so both isReviewTaskSatisfied (record-evidence-time) and
    // validateMissionArtifactReviewGate (finish-time) see the same receipt.
    task.artifact_review_receipt = receiptRelPath;
    task.artifact_review_profile = {
      artifact_kind: kind,
      artifact_path: artifactReference,
      artifact_sha256: sha256Value,
      required_reviewer_roles: [],
      independence_required: true,
      implementer_agent_ids: implementerAgentIds,
    };
    writeMissionNextTasks(missionPath, nextTasks);

    appendMissionExecutionLedgerEntry({
      mission_id: upperId,
      mission_path_hint: missionPath,
      event_type: 'artifact_review_recorded',
      task_id: args.reviewTaskId,
      actor_id: args.reviewerAgentId,
      actor_type: 'agent',
      decision: receipt.verdict,
      evidence: [receiptRelPath],
      payload: {
        review_target_task_id: reviewTargetId,
        independence_verified: receipt.reviewer.independence_verified,
      },
    });

    safeExec('git', ['add', '.'], { cwd: missionPath });
    try {
      safeExec(
        'git',
        ['commit', '-m', `review(${upperId}): ${args.reviewTaskId} - ${receipt.verdict}`],
        { cwd: missionPath }
      );
    } catch (_) {
      logger.info('No new changes in mission repo after review record.');
    }

    evaluation = evaluateArtifactReviews({
      artifacts: [{ path: artifactReference, sha256: sha256Value, kind }],
      reviews: [receiptToArtifactReviewDecision(receipt)],
      requiredReviewerRoles: [],
      implementerAgentIds,
      requireIndependence: true,
    });

    const hash = args.getGitHash(missionPath);
    const currentState = loadState(upperId)!;
    currentState.git.latest_commit = hash;
    currentState.history.push({
      ts: new Date().toISOString(),
      event: 'ARTIFACT_REVIEW',
      note: `${args.reviewTaskId}: ${receipt.verdict} (${evaluation.ready ? 'ready' : 'blocked'})`,
    });
    await saveState(upperId, currentState, { alreadyLocked: true });
  });

  let taskCompleted = false;
  if (evaluation.ready) {
    const autoComplete = tryAutoCompleteTaskFromEvidence(missionPath, args.reviewTaskId);
    taskCompleted = autoComplete.completed;
  }

  if (evaluation.ready) {
    logger.success(
      `✅ Review recorded and task "${args.reviewTaskId}" satisfied: ${receipt.verdict}.`
    );
  } else {
    logger.warn(
      `⚠️ Review recorded but task "${args.reviewTaskId}" is still blocked: ${evaluation.reasons.join('; ')}`
    );
  }

  return {
    status: evaluation.ready ? 'recorded' : 'blocked',
    taskCompleted,
    reasons: evaluation.reasons,
    receiptPath: receiptRelPath,
  };
}

export interface PurgeMissionCandidate {
  mission: string;
  missionDir: string;
  targetPath: string;
  policyName: string;
}

export interface PurgeMissionsResult {
  status: 'ok' | 'adf_missing';
  adfPath: string;
  dryRun: boolean;
  candidates: PurgeMissionCandidate[];
  /** Missions actually moved to their archive target (empty on dry-run / adf_missing). */
  archived: PurgeMissionCandidate[];
}

function readMissionStatus(missionDir: string): string | null {
  let statePath: string;
  try {
    statePath = safeMissionArtifactPath(missionDir, 'mission-state.json');
  } catch {
    return null;
  }
  if (!safeExistsSync(statePath)) return null;
  return loadMissionStateAtPath(statePath)?.status || null;
}

interface MissionLifecyclePolicy {
  name: string;
  condition: { has_file?: string; max_age_days?: number; status?: string };
  target_dir: string;
  naming_pattern: string;
}

interface MissionLifecyclePolicyFile {
  policies: MissionLifecyclePolicy[];
}

const MISSION_LIFECYCLE_POLICY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-lifecycle-policy.schema.json'
);
const missionLifecyclePolicyCatalog = defineCatalog<MissionLifecyclePolicyFile>({
  id: 'mission-lifecycle-policy',
  path: () => pathResolver.knowledge('product/governance/mission-lifecycle.json'),
  schema: MISSION_LIFECYCLE_POLICY_SCHEMA_PATH,
});

/**
 * Loads the mission lifecycle ADF policies. AL-01: the ADF lives under
 * knowledge/product/governance/ — the former `knowledge('governance/...')`
 * path pointed at a file that never existed, so automatic archival was
 * silently dead. A missing ADF escalates (no-silent-noop) and returns
 * `policies: null`.
 */
function loadMissionLifecyclePolicies(): {
  adfPath: string;
  policies: MissionLifecyclePolicy[] | null;
} {
  const adfPath = pathResolver.knowledge('product/governance/mission-lifecycle.json');
  if (!safeExistsSync(adfPath)) {
    logger.error(`Mission lifecycle ADF not found: ${adfPath}`);
    sendOpsAlert({
      severity: 'critical',
      title: 'Mission lifecycle ADF missing — automatic mission archival is disabled',
      context: { adf_path: adfPath },
      recommendation:
        'Restore knowledge/product/governance/mission-lifecycle.json so mission purge/archive policies can run again.',
      dedupe_key: 'mission-purge:adf-missing',
    });
    return { adfPath, policies: null };
  }
  const adf = missionLifecyclePolicyCatalog.load();
  return { adfPath, policies: adf.policies };
}

/** Resolves a policy's absolute archive target path for a mission id. */
function resolvePolicyTargetPath(policy: MissionLifecyclePolicy, mission: string): string {
  const now = new Date();
  const targetDir = policy.target_dir.replace(
    '{YYYY-MM}',
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  );
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(
      path.join(targetDir, policy.naming_pattern.replace('{mission_id}', mission))
    ),
    { allowMissingLeaf: true }
  );
}

/**
 * AL-01/AL-03 acceptance: archival leaves an audit record of what moved
 * where. Best-effort — an unwritable audit log never blocks the archival
 * that already happened.
 */
function appendMissionPurgeAudit(record: Record<string, unknown>): void {
  try {
    const auditPath = pathResolver.sharedLogsAudit('mission-purge.jsonl');
    safeMkdir(path.dirname(auditPath), { recursive: true });
    appendJsonLine(auditPath, { ts: new Date().toISOString(), ...record });
  } catch (err) {
    logger.warn(
      `Failed to record mission purge audit entry for ${String(record.mission)}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export async function purgeMissions(rootDir: string, dryRun = false): Promise<PurgeMissionsResult> {
  const { adfPath, policies } = loadMissionLifecyclePolicies();
  if (!policies) {
    return { status: 'adf_missing', adfPath, dryRun, candidates: [], archived: [] };
  }
  const candidates: PurgeMissionCandidate[] = [];

  for (const { missionId: mission, missionPath: missionDir } of listMissionsInSearchDirs()) {
    let safeMissionDir: string;
    try {
      safeMissionDir = safeMissionRoot(missionDir);
    } catch (error) {
      logger.warn(
        `Skipping unsafe mission path ${mission}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    for (const policy of policies) {
      const { condition } = policy;

      // AND semantics across every declared condition field. The real ADF
      // declares `status` (e.g. purge-orphaned = failed AND >30d); ignoring
      // it would archive active missions by age alone. An empty/unknown
      // condition never matches (fail-safe).
      const checks: boolean[] = [];
      if (condition.has_file) {
        try {
          checks.push(safeExistsSync(safeMissionArtifactPath(safeMissionDir, condition.has_file)));
        } catch {
          checks.push(false);
        }
      }
      if (condition.max_age_days) {
        const stat = safeStat(safeMissionDir);
        const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
        checks.push(ageDays > condition.max_age_days);
      }
      if (condition.status) {
        checks.push(readMissionStatus(safeMissionDir) === condition.status);
      }
      const match = checks.length > 0 && checks.every(Boolean);
      if (!match) continue;

      let targetPath: string;
      try {
        targetPath = resolvePolicyTargetPath(policy, mission);
      } catch (error) {
        logger.warn(
          `Skipping unsafe archive target for ${mission}: ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      candidates.push({ mission, missionDir: safeMissionDir, targetPath, policyName: policy.name });
      break;
    }
  }

  if (candidates.length === 0) {
    logger.info('No missions match purge policies. Nothing to do.');
    return { status: 'ok', adfPath, dryRun, candidates: [], archived: [] };
  }

  console.log('');
  console.log(`  Missions matching purge policies: ${candidates.length}`);
  console.log('');
  for (const candidate of candidates) {
    console.log(
      `    ${candidate.mission.padEnd(30)} → ${path.relative(rootDir, candidate.targetPath)}  (${candidate.policyName})`
    );
  }
  console.log('');

  if (dryRun) {
    logger.info('Dry run complete. No missions were moved. Run "purge --execute" to apply.');
    return { status: 'ok', adfPath, dryRun, candidates, archived: [] };
  }

  // Revalidate every source and destination before the first move so one
  // late symlink/configuration violation cannot leave a partially archived
  // sweep.
  for (const candidate of candidates) {
    safeMissionRoot(candidate.missionDir);
    const safeTarget = assertSafeRepositoryPath(candidate.targetPath, { allowMissingLeaf: true });
    assertSafeRepositoryPath(path.dirname(safeTarget), { allowMissingLeaf: true });
  }

  const archived: PurgeMissionCandidate[] = [];
  for (const candidate of candidates) {
    const safeSource = safeMissionRoot(candidate.missionDir);
    const safeTarget = assertSafeRepositoryPath(candidate.targetPath, { allowMissingLeaf: true });
    logger.info(
      `Archiving mission ${candidate.mission} to ${safeTarget} (Policy: ${candidate.policyName})`
    );
    const targetDir = assertSafeRepositoryPath(path.dirname(safeTarget), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(targetDir)) {
      safeMkdir(targetDir, { recursive: true });
    }
    safeExec('cp', ['-r', safeSource, safeTarget]);
    safeRmSync(safeSource, { recursive: true, force: true });
    archived.push(candidate);
    appendMissionPurgeAudit({
      event: 'MISSION_PURGE_ARCHIVED',
      mission: candidate.mission,
      from: safeSource,
      to: safeTarget,
      policy: candidate.policyName,
    });
    // AL-04: the mission tree moved to the archive — reclaim the runtime
    // residue that now points at nothing (best-effort by contract).
    gcMissionRuntimeResidue({ missionId: candidate.mission });
    // NI-05: and retire the identities affiliated with it (idempotent — the
    // finish ceremony already tried; a mission archived without a finish
    // closure is exactly the case this catches).
    retireIdentitiesForScopeBestEffort({
      scope: 'mission',
      scopeId: candidate.mission,
      reason: `mission ${candidate.mission} archived by policy ${candidate.policyName}`,
    });
  }

  logger.success(`✅ ${archived.length} mission(s) purged.`);
  return { status: 'ok', adfPath, dryRun, candidates, archived };
}

export interface ArchiveMissionByIdResult {
  status: 'archived' | 'already_archived' | 'not_found' | 'not_archivable' | 'adf_missing';
  mission: string;
  from?: string;
  to?: string;
  policy?: string;
  reason?: string;
}

/**
 * AL-03: explicit operator-targeted archive of a single mission. Unlike the
 * policy sweep in `purgeMissions`, the mission is archived regardless of age
 * — but ONLY when its status is `completed` or `failed` (an explicit archive
 * still refuses to move live missions). The archive target comes from the
 * same lifecycle ADF policy that declares the mission's status, and the same
 * `mission-purge.jsonl` audit record is written (with `explicit: true`).
 *
 * Idempotent and structured: an already-archived or missing mission returns
 * a no-op result instead of throwing.
 */
export async function archiveMissionById(missionId: string): Promise<ArchiveMissionByIdResult> {
  const mission = String(missionId || '').toUpperCase();
  const { adfPath, policies } = loadMissionLifecyclePolicies();
  if (!policies) {
    return {
      status: 'adf_missing',
      mission,
      reason: `mission lifecycle ADF not found: ${adfPath}`,
    };
  }

  const missionDirCandidate = findMissionPath(mission);
  if (!missionDirCandidate) {
    for (const policy of policies) {
      let target: string;
      try {
        target = resolvePolicyTargetPath(policy, mission);
      } catch {
        continue;
      }
      if (safeExistsSync(target)) {
        return { status: 'already_archived', mission, to: target, policy: policy.name };
      }
    }
    return {
      status: 'not_found',
      mission,
      reason: 'mission directory not found in active mission roots or lifecycle archive targets',
    };
  }

  let missionDir: string;
  try {
    missionDir = safeMissionRoot(missionDirCandidate);
  } catch (error) {
    return {
      status: 'not_archivable',
      mission,
      reason: `mission path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const status = readMissionStatus(missionDir);
  if (status !== 'completed' && status !== 'failed') {
    return {
      status: 'not_archivable',
      mission,
      from: missionDir,
      reason: `mission status '${status ?? 'unknown'}' is not completed/failed — explicit archive refuses to move live missions`,
    };
  }

  // Match on the policy's declared status only: explicit targeting is the
  // operator's decision, so max_age_days is deliberately not applied here.
  const policy = policies.find((entry) => entry.condition?.status === status);
  if (!policy) {
    return {
      status: 'not_archivable',
      mission,
      from: missionDir,
      reason: `no lifecycle policy declares an archive target for status '${status}'`,
    };
  }

  let targetPath: string;
  try {
    targetPath = resolvePolicyTargetPath(policy, mission);
  } catch (error) {
    return {
      status: 'not_archivable',
      mission,
      from: missionDir,
      reason: `archive target is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const targetDir = assertSafeRepositoryPath(path.dirname(targetPath), { allowMissingLeaf: true });
  if (!safeExistsSync(targetDir)) {
    safeMkdir(targetDir, { recursive: true });
  }
  if (safeExistsSync(targetPath)) safeRmSync(targetPath, { recursive: true, force: true });
  safeExec('cp', ['-r', missionDir, targetPath]);
  safeRmSync(missionDir, { recursive: true, force: true });
  appendMissionPurgeAudit({
    event: 'MISSION_PURGE_ARCHIVED',
    mission,
    from: missionDir,
    to: targetPath,
    policy: policy.name,
    explicit: true,
  });
  // AL-04: scope-linked GC — the mission's runtime residue follows its tree
  // into the archive. Best-effort: never fails an archive that succeeded.
  gcMissionRuntimeResidue({ missionId: mission });
  // NI-05: auto-offboard the mission's identities (idempotent with finish).
  retireIdentitiesForScopeBestEffort({
    scope: 'mission',
    scopeId: mission,
    reason: `mission ${mission} archived (explicit)`,
  });
  logger.success(`📦 Mission ${mission} archived to ${targetPath} (policy: ${policy.name}).`);
  return { status: 'archived', mission, from: missionDir, to: targetPath, policy: policy.name };
}
