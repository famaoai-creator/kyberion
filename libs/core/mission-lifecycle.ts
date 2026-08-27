/**
 * scripts/refactor/mission-lifecycle.ts
 * Delegation, verification, import, and finalization helpers for missions.
 */

import * as path from 'node:path';
import { addInboxEntry } from './deliverable-inbox.js';
import { notifyOperator } from './operator-notifications.js';
import { runMissionRetrospective } from './mission-retrospective.js';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { getRegisteredEnvBool, getRegisteredEnvText } from './foundation/env.js';
import { createActuatorTrace, finalizeActuatorTrace } from './actuator-trace.js';
import { buildCompletionNextAction, type CompletionReconciliation } from './next-action.js';
import {
  buildReviewGapText,
  listPendingReviewReentryRequests,
  markReviewReentryProcessed,
} from './review-reentry.js';
import { ledger } from './ledger.js';
import { logger } from './core.js';
import { latestSnapshot } from './intent-snapshot-store.js';
import { queueMissionMemoryPromotionCandidate } from './memory-promotion-queue.js';
import { summarizeReviewGateVerdicts } from './mission-review-gates.js';
import { safeExec, safeExistsSync, safeMkdir, safeReadFile, safeRmSync } from './secure-io.js';
import { recordMissionGateOverride, writeMissionGateRecord } from './mission-gate-engine.js';
import { closeMissionArtifacts } from './mission-artifact-closure.js';
import { reconcileCompletion, reconcileCompletionStructurally } from './intent-reconciliation.js';
import { loadState, saveState } from './mission-state.js';
import {
  buildMissionCompletionReconciliationInput,
  collectMissionEvidence,
  extractPromotableMissionMemory,
  isTaskDeliverableSatisfied,
  MISSION_TASK_COMPLETED_STATUSES,
  publishMeetingDeliverablesIfNeeded,
  readMissionNextTasks,
  tryAutoCompleteTaskFromEvidence,
  updateMissionMemorySidecar,
  upsertGoalGapTasks,
  upsertMissionGateRepairTask,
  writeMissionNextTasks,
} from './mission-lifecycle-completion.js';

export {
  buildMissionCompletionReconciliationInput,
  collectMissionEvidence,
  readMissionNextTasks,
  writeMissionNextTasks,
  MISSION_TASK_COMPLETED_STATUSES,
  tryAutoCompleteTaskFromEvidence,
};
export type { MissionCompletionReconciliationContext } from './mission-lifecycle-completion.js';
export {
  delegateMission,
  importMission,
  pauseMission,
  cancelMission,
  repairLegacyMissionState,
  grantMissionAccess,
  grantMissionSudo,
} from './mission-lifecycle-operator-actions.js';
import {
  recordAgentRuntimeEvent,
  updateTrustScore,
  validateMissionQuality,
} from './mission-governance.js';
import {
  emitMissionLifecycleIntentSnapshot,
  evaluateMissionIntentDrift,
} from './mission-intent-delta.js';

function isLifecycleClosureGap(gap: string): boolean {
  const normalized = gap.toLowerCase();
  const mentionsLifecycle =
    /mission\s+lifecycle|mission.*(?:完了|終了)|ミッション.*ライフサイクル/u.test(normalized);
  const mentionsCompletion = /complet|finish|archive|完了|終了/u.test(normalized);
  const mentionsVerification = /verif|検証/u.test(normalized);
  const mentionsDistillation = /distill|蒸留/u.test(normalized);
  return mentionsLifecycle && mentionsCompletion && mentionsVerification && mentionsDistillation;
}

function hasLifecycleClosureEvidence(state: {
  status?: string;
  history?: Array<{ event?: string }>;
}): boolean {
  const historyEvents = new Set(
    (state.history || []).map((entry) => String(entry.event || '').toUpperCase())
  );
  return (
    ['completed', 'distilling', 'validating'].includes(String(state.status || '').toLowerCase()) &&
    historyEvents.has('VERIFY') &&
    historyEvents.has('DISTILL')
  );
}

/**
 * Completion reconciliation runs immediately before the lifecycle transitions
 * to archived. A success condition that asks the mission itself to be
 * completed/verified/distilled is therefore circular if it is judged only
 * from deliverable text. Resolve that process-only criterion from canonical
 * lifecycle state and history, while leaving real outcome gaps untouched.
 */
export function reconcileLifecycleClosureCriteria(
  reconciliation: CompletionReconciliation,
  state: { status?: string; history?: Array<{ event?: string }> }
): CompletionReconciliation {
  if (!hasLifecycleClosureEvidence(state)) {
    return reconciliation;
  }

  const remainingGaps = reconciliation.gaps.filter((gap) => !isLifecycleClosureGap(gap));
  if (remainingGaps.length === reconciliation.gaps.length) return reconciliation;

  return {
    ...reconciliation,
    satisfied: remainingGaps.length === 0,
    delivered: Array.from(
      new Set([
        ...reconciliation.delivered,
        'mission lifecycle verification and distillation recorded',
      ])
    ),
    gaps: remainingGaps,
    confidence: remainingGaps.length === 0 ? Math.max(reconciliation.confidence, 0.92) : 0.62,
  };
}

export function evaluateMissionFinishExitGate(
  missionDir: string,
  state?: { status?: string; history?: Array<{ event?: string }> }
): {
  ok: boolean;
  reason?: string;
  pendingTasks: string[];
} {
  const nextTasks = readMissionNextTasks(missionDir);
  const completedStatuses = MISSION_TASK_COMPLETED_STATUSES;
  const statusByTaskId = new Map(
    nextTasks.map((task) => [
      String(task.task_id || ''),
      String(task.status || 'planned').toLowerCase(),
    ])
  );
  let autoResolvedTaskState = false;
  for (const task of nextTasks) {
    const taskId = String(task.task_id || '');
    if (!taskId.startsWith('repair-') && !taskId.startsWith('goal-gap-')) continue;
    const staleCircularGoalRepair =
      taskId === 'repair-goal-satisfaction' &&
      Boolean(state) &&
      hasLifecycleClosureEvidence(state || {}) &&
      isLifecycleClosureGap(String(task.description || ''));
    if (isTaskDeliverableSatisfied(missionDir, task, statusByTaskId) || staleCircularGoalRepair) {
      task.status = 'completed';
      statusByTaskId.set(taskId, 'completed');
      autoResolvedTaskState = true;
    }
  }
  if (autoResolvedTaskState) {
    writeMissionNextTasks(missionDir, nextTasks);
  }
  const pendingTasks = nextTasks
    .filter((task) => {
      const status = String(task.status || 'planned').toLowerCase();
      return !completedStatuses.has(status);
    })
    .map((task) => String(task.task_id || task.description || 'unknown-task'));

  if (pendingTasks.length > 0) {
    return {
      ok: false,
      reason:
        `Pending tasks remain: ${pendingTasks.join(', ')}. ` +
        'checkpoint/record-evidence only append to the execution ledger — they do not flip ' +
        'NEXT_TASKS.json task status. If this work was completed directly (not dispatched via ' +
        'dispatch-workitems), run `mission_controller reconcile-work <MISSION_ID> --manifest <path>` ' +
        '(see knowledge/product/governance/phases/execution.md) to adopt it before finishing.',
      pendingTasks,
    };
  }

  return { ok: true, pendingTasks: [] };
}

function recordMissionFinishGateFailure(input: {
  missionId: string;
  state: any;
  missionDir: string;
  gateId: string;
  reason: string;
  agentRuntimeEventPath: string;
  pendingTasks: string[];
  repairStrategy?: 'task' | 'operator' | 'existing_tasks' | 'artifact_review';
  actionTaskIds?: string[];
}): string {
  const now = new Date().toISOString();
  const context = input.state.context || {};
  const failureCount = Number(context.mission_finish_gate_failure_count || 0) + 1;
  const requiresOperator = input.repairStrategy === 'operator';
  const resumesExistingWork =
    input.repairStrategy === 'existing_tasks' || input.repairStrategy === 'artifact_review';
  const shouldRealign =
    !requiresOperator &&
    !resumesExistingWork &&
    failureCount >= 2 &&
    input.state.status === 'validating';
  const nextStatus = requiresOperator
    ? 'paused'
    : resumesExistingWork || shouldRealign
      ? 'active'
      : 'validating';

  input.state.context = {
    ...context,
    mission_finish_gate_failure_count: failureCount,
    mission_finish_gate_last_reason: input.reason,
    mission_finish_gate_last_checked_at: now,
    mission_finish_gate_requires_operator: requiresOperator,
  };
  const repairTaskIds =
    requiresOperator || resumesExistingWork
      ? []
      : upsertMissionGateRepairTask({
          missionDir: input.missionDir,
          gateId: input.gateId,
          reason: input.reason,
          pendingTasks: input.pendingTasks,
        });
  const actionTaskIds = input.actionTaskIds || repairTaskIds;
  input.state.status = nextStatus;
  input.state.history.push({
    ts: now,
    event: requiresOperator
      ? 'OPERATOR_DECISION_REQUIRED'
      : input.repairStrategy === 'artifact_review'
        ? 'ARTIFACT_REVIEW_REQUIRED'
        : input.repairStrategy === 'existing_tasks'
          ? 'WORK_REMAINS'
          : shouldRealign
            ? 'REALIGN'
            : 'EXIT_GATE_FAIL',
    note: requiresOperator
      ? `Autonomous finish retries exhausted; operator decision required. Reason: ${input.reason}`
      : input.repairStrategy === 'artifact_review'
        ? `Artifact review task reopened without changing its reviewed implementation. Reason: ${input.reason}`
        : input.repairStrategy === 'existing_tasks'
          ? `Finish stopped because existing work remains; no synthetic repair task was created. Reason: ${input.reason}`
          : shouldRealign
            ? `Finish gate failed ${failureCount} times; realigning to active. Reason: ${input.reason}`
            : `Finish gate failed. Reason: ${input.reason}`,
  });
  recordAgentRuntimeEvent(input.agentRuntimeEventPath, {
    event: requiresOperator
      ? 'MISSION_FINISH_OPERATOR_DECISION_REQUIRED'
      : input.repairStrategy === 'artifact_review'
        ? 'MISSION_ARTIFACT_REVIEW_REQUIRED'
        : input.repairStrategy === 'existing_tasks'
          ? 'MISSION_WORK_REMAINS'
          : shouldRealign
            ? 'MISSION_REALIGN_REQUESTED'
            : 'MISSION_FINISH_GATE_FAILED',
    mission_id: input.missionId,
    gate_id: input.gateId,
    failure_count: failureCount,
    reason: input.reason,
    next_status: input.state.status,
    repair_task_ids: repairTaskIds,
    action_task_ids: actionTaskIds,
  });
  void notifyOperator('mission_failed', {
    title: `Mission ${input.missionId} blocked at ${input.gateId}`,
    body: input.reason,
    link_hint: `pnpm mission status ${input.missionId}`,
    correlation_id: `${input.missionId}:${input.gateId}`,
  });
  const gatePath = recordMissionGateOverride({
    missionId: input.missionId,
    gateId: input.gateId,
    outcome: 'rejected',
    note: input.reason,
    actorId: 'mission_controller',
    evidenceDir: path.join(input.missionDir, 'gates'),
  });
  input.state.context = {
    ...(input.state.context || {}),
    mission_finish_gate_last_path: gatePath,
  };
  return gatePath;
}

function reopenArtifactReviewTasks(input: {
  missionDir: string;
  taskIds: string[];
  reason: string;
}): string[] {
  const taskIds = new Set(input.taskIds);
  const tasks = readMissionNextTasks(input.missionDir);
  const reopened: string[] = [];
  const invalidatedAt = new Date().toISOString();
  for (const task of tasks) {
    const taskId = String(task.task_id || '');
    if (!taskIds.has(taskId)) continue;
    task.status = 'planned';
    delete task.artifact_review_receipt;
    delete task.reconciliation;
    task.last_review_invalidation = {
      invalidated_at: invalidatedAt,
      reason: input.reason,
    };
    reopened.push(taskId);
  }
  if (reopened.length > 0) writeMissionNextTasks(input.missionDir, tasks);
  return reopened;
}

function recordMissionIntentDriftGateFailure(input: {
  missionId: string;
  state: any;
  missionDir: string;
  reason: string;
  agentRuntimeEventPath: string;
}): string {
  const now = new Date().toISOString();
  const context = input.state.context || {};
  const failureCount = Number(context.intent_drift_gate_failure_count || 0) + 1;
  const nextStatus =
    input.state.status === 'active' || input.state.status === 'validating'
      ? 'validating'
      : input.state.status;

  input.state.context = {
    ...context,
    intent_drift_gate_failure_count: failureCount,
    intent_drift_gate_last_reason: input.reason,
    intent_drift_gate_last_checked_at: now,
  };
  const repairTaskIds = upsertMissionGateRepairTask({
    missionDir: input.missionDir,
    gateId: 'intent-drift',
    reason: input.reason,
    pendingTasks: [],
  });
  input.state.status = nextStatus;
  input.state.history.push({
    ts: now,
    event: 'REALIGN',
    note: `Intent drift detected; realigning mission. Reason: ${input.reason}`,
  });
  recordAgentRuntimeEvent(input.agentRuntimeEventPath, {
    event: 'MISSION_INTENT_DRIFT_BLOCKED',
    mission_id: input.missionId,
    gate_id: 'intent-drift',
    failure_count: failureCount,
    reason: input.reason,
    next_status: input.state.status,
    repair_task_ids: repairTaskIds,
  });
  const gatePath = recordMissionGateOverride({
    missionId: input.missionId,
    gateId: 'intent-drift',
    outcome: 'rejected',
    note: input.reason,
    actorId: 'mission_controller',
    evidenceDir: path.join(input.missionDir, 'gates'),
  });
  input.state.context = {
    ...(input.state.context || {}),
    intent_drift_gate_last_path: gatePath,
  };
  return gatePath;
}

function maybeRunVolatileGc(
  upperId: string,
  traceCtx: ReturnType<typeof createActuatorTrace>
): void {
  try {
    const runnerPath = pathResolver.rootResolve('dist/scripts/run_pipeline.js');
    if (!safeExistsSync(runnerPath)) {
      logger.warn(
        `⚠️ [VOLATILE_GC] skipped for ${upperId}: dist/scripts/run_pipeline.js not found.`
      );
      traceCtx.addEvent('volatile_gc.skipped', { reason: 'runner_not_built' });
      return;
    }
    traceCtx.startSpan('mission:volatile-gc');
    safeExec(process.execPath, [runnerPath, '--input', 'pipelines/volatile-gc.json'], {
      cwd: pathResolver.rootDir(),
      timeoutMs: 120000,
    });
    traceCtx.endSpan('ok');
  } catch (err: any) {
    logger.warn(`⚠️ [VOLATILE_GC] skipped for ${upperId}: ${err?.message || err}`);
    traceCtx.endSpan('error', err?.message || String(err));
  }
}

export async function verifyMission(
  id: string,
  result: 'verified' | 'rejected',
  note: string,
  transitionStatus: (current: string, next: string) => any,
  syncProjectLedgerIfLinked: (missionId: string) => Promise<void>
): Promise<void> {
  if (!id || !result || !['verified', 'rejected'].includes(result)) {
    logger.error('Usage: mission_controller verify <MISSION_ID> <verified|rejected> <note>');
    return;
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }

  if (state.status !== 'active' && state.status !== 'validating') {
    logger.error(
      `❌ Cannot verify mission ${upperId} (status: ${state.status}). Only active or validating missions can be verified.`
    );
    return;
  }

  const missionDir = findMissionPath(upperId);
  if (!missionDir) {
    logger.error(`Mission directory for ${upperId} not found.`);
    return;
  }
  const runtimeEventPath = path.join(missionDir, 'runtime-events.jsonl');

  logger.info(`🛡️ Verifying Mission ${upperId}: Result = ${result.toUpperCase()}`);

  if (result === 'verified') {
    const driftSummary = evaluateMissionIntentDrift(upperId);
    const driftReview = summarizeReviewGateVerdicts({
      reviewMode: 'standard',
      results: [
        driftSummary
          ? {
              gate_id: 'INTENT_DRIFT',
              verdict: driftSummary.passed ? 'ready' : 'blocked',
              reason: driftSummary.message,
            }
          : {
              gate_id: 'INTENT_DRIFT',
              verdict: 'concerns',
              reason: 'Intent drift gate unavailable.',
            },
      ],
    });
    const driftGate = driftReview.gate_results[0];
    if (driftReview.overall_verdict === 'blocked') {
      logger.error(
        `❌ [INTENT_DRIFT] Mission ${upperId} blocked: ${driftGate.reason || 'drift gate blocked'}`
      );
      recordMissionIntentDriftGateFailure({
        missionId: upperId,
        state,
        missionDir,
        reason: driftGate.reason || 'intent drift gate blocked',
        agentRuntimeEventPath: runtimeEventPath,
      });
      await saveState(upperId, state);
      await syncProjectLedgerIfLinked(upperId);
      return;
    }
    state.context = {
      ...(state.context || {}),
      intent_review_summary: driftReview,
    } as any;
    writeMissionGateRecord({
      missionId: upperId,
      gateId: 'intent-drift',
      evidenceDir: path.join(missionDir, 'gates'),
      payload: {
        verdict: 'pass',
        checked_at: new Date().toISOString(),
        reason: driftGate.reason || 'intent drift gate passed',
        review_summary: driftReview,
      },
    });
    state.status = transitionStatus(state.status, 'distilling');
  } else if (state.status !== 'active') {
    state.status = transitionStatus(state.status, 'active');
  }

  if (state.delegation) {
    state.delegation.verification_status = result;
    updateTrustScore(state.delegation.agent_id, result);
  }

  state.verification = {
    status: result,
    verified_at: new Date().toISOString(),
    note,
  };

  state.history.push({
    ts: new Date().toISOString(),
    event: 'VERIFY',
    note: `Verification ${result}: ${note}`,
  });

  await saveState(upperId, state);
  await syncProjectLedgerIfLinked(upperId);
  await emitMissionLifecycleIntentSnapshot({
    missionId: upperId,
    stage: 'verification',
    text: note,
    source: 'mission_state',
    traceRef: state.correlation_id,
  });
  logger.success(`✅ Mission ${upperId} verification complete. Status: ${state.status}`);
}

export async function finishMission(
  id: string,
  seal: boolean,
  args: {
    archiveDir: string;
    agentRuntimeEventPath: string;
    getGitHash: (cwd: string) => string;
    sealMission: (missionId: string) => Promise<string | undefined>;
    syncProjectLedgerIfLinked: (missionId: string) => Promise<void>;
    transitionStatus: (current: string, next: string) => any;
  }
): Promise<void> {
  if (!id) {
    logger.error('Usage: mission_controller finish <MISSION_ID> [--seal]');
    return;
  }
  const upperId = id.toUpperCase();
  const preState = loadState(upperId);
  if (!preState) {
    logger.error(`❌ Mission ${upperId} not found. Run "list" to see available missions.`);
    return;
  }
  if (preState.status === 'archived') {
    logger.info(`Mission ${upperId} is already archived.`);
    return;
  }
  if (
    preState.status !== 'completed' &&
    preState.status !== 'distilling' &&
    preState.status !== 'validating'
  ) {
    const steps: Record<string, string> = {
      planned: 'Run "start" to activate the mission first.',
      active: 'Run "verify" → "distill" to complete the mission lifecycle first.',
      validating: 'Re-run finish after addressing the validation gap.',
      paused: 'Run "start" to resume, then complete the lifecycle.',
      failed: 'Run "start" to retry, then complete the lifecycle.',
    };
    logger.error(
      `❌ Cannot finish mission ${upperId} (status: ${preState.status}). ${steps[preState.status] || ''}`
    );
    return;
  }

  await emitMissionLifecycleIntentSnapshot({
    missionId: upperId,
    stage: 'delivery',
    text: latestSnapshot(upperId)?.intent.goal || `Mission ${upperId} progressing through learn`,
    source: 'mission_state',
    traceRef: preState.correlation_id,
  });
  const missionDir = findMissionPath(upperId);
  if (!missionDir) return;
  const missionHead = args.getGitHash(missionDir);
  if (preState.git?.latest_commit !== missionHead) {
    const headSubject = safeExec('git', ['log', '-1', '--pretty=%s'], { cwd: missionDir }).trim();
    const interruptedFinishSubject = `feat: complete mission ${upperId}`;
    if (headSubject === interruptedFinishSubject && hasLifecycleClosureEvidence(preState)) {
      preState.git.latest_commit = missionHead;
      preState.context = {
        ...(preState.context || {}),
        mission_finish_recovered_commit: missionHead,
      };
      preState.history.push({
        ts: new Date().toISOString(),
        event: 'FINISH_RECOVER',
        note: `Recovered interrupted finish commit ${missionHead.slice(0, 8)} before resuming gates.`,
      });
      await saveState(upperId, preState);
    }
  }
  const driftSummary = evaluateMissionIntentDrift(upperId);
  if (driftSummary && !driftSummary.passed) {
    logger.error(`❌ [INTENT_DRIFT] Mission ${upperId} blocked: ${driftSummary.message}`);
    const state = loadState(upperId);
    if (state) {
      recordMissionFinishGateFailure({
        missionId: upperId,
        state,
        missionDir,
        gateId: 'intent-drift',
        reason: driftSummary.message,
        agentRuntimeEventPath: args.agentRuntimeEventPath,
        pendingTasks: [],
      });
      await saveState(upperId, state);
    }
    return;
  }
  writeMissionGateRecord({
    missionId: upperId,
    gateId: 'intent-drift',
    evidenceDir: path.join(missionDir, 'gates'),
    payload: {
      verdict: 'pass',
      checked_at: new Date().toISOString(),
      reason: driftSummary?.message || 'intent drift gate passed',
    },
  });

  const exitGate = evaluateMissionFinishExitGate(missionDir, preState);
  if (!exitGate.ok) {
    logger.error(`❌ [EXIT_GATE] Mission ${upperId} blocked: ${exitGate.reason}`);
    const state = loadState(upperId);
    if (state) {
      recordMissionFinishGateFailure({
        missionId: upperId,
        state,
        missionDir,
        gateId: 'finish-exit',
        reason: exitGate.reason || 'exit gate blocked',
        agentRuntimeEventPath: args.agentRuntimeEventPath,
        pendingTasks: exitGate.pendingTasks,
        repairStrategy: 'existing_tasks',
        actionTaskIds: exitGate.pendingTasks,
      });
      await saveState(upperId, state);
    }
    return;
  }
  writeMissionGateRecord({
    missionId: upperId,
    gateId: 'finish-exit',
    evidenceDir: path.join(missionDir, 'gates'),
    payload: {
      verdict: 'pass',
      checked_at: new Date().toISOString(),
      reason: 'No pending tasks remain',
    },
  });

  const quality = await validateMissionQuality(upperId);
  if (!quality.ok) {
    logger.error(
      `❌ [QUALITY_REJECTION] Mission ${upperId} does not meet governance requirements: ${quality.reason}`
    );
    const state = loadState(upperId);
    if (state) {
      const reopenedReviewTaskIds = quality.reviewTaskIds?.length
        ? reopenArtifactReviewTasks({
            missionDir,
            taskIds: quality.reviewTaskIds,
            reason: quality.reason || 'artifact review gate blocked',
          })
        : [];
      recordMissionFinishGateFailure({
        missionId: upperId,
        state,
        missionDir,
        gateId: 'finish-quality',
        reason: quality.reason || 'quality gate blocked',
        agentRuntimeEventPath: args.agentRuntimeEventPath,
        pendingTasks: [],
        repairStrategy: reopenedReviewTaskIds.length > 0 ? 'artifact_review' : 'operator',
        actionTaskIds: reopenedReviewTaskIds,
      });
      await saveState(upperId, state);
    }
    return;
  }
  writeMissionGateRecord({
    missionId: upperId,
    gateId: 'finish-quality',
    evidenceDir: path.join(missionDir, 'gates'),
    payload: {
      verdict: 'pass',
      checked_at: new Date().toISOString(),
      reason: 'Mission quality validation passed',
    },
  });

  const state = loadState(upperId);
  if (!state) throw new Error(`Mission ${upperId} not found.`);
  if (driftSummary) {
    state.context = {
      ...(state.context || {}),
      intent_delta_summary: driftSummary,
    };
  }

  const reconciliationContext = buildMissionCompletionReconciliationInput(upperId, {
    state,
    missionDir,
  });
  if (!reconciliationContext) throw new Error(`Mission ${upperId} not found.`);
  const { reconciliationInput, completionGoal, evidence, evidenceRefs } = reconciliationContext;
  const structuralReconciliation = reconcileLifecycleClosureCriteria(
    reconcileCompletionStructurally(reconciliationInput),
    state
  );
  // SO-05: this is an orchestrator-judgment call (finish decision), not a
  // conversation-front call — declare 'deep' explicitly rather than leaving
  // it at intent-reconciliation.ts's undeclared default.
  const rawCompletionReconciliation = structuralReconciliation.satisfied
    ? structuralReconciliation
    : reconcileLifecycleClosureCriteria(
        await reconcileCompletion(reconciliationInput, { model_tier: 'deep' }),
        state
      );

  // LC-11: pending human review rejections are goal gaps too — merge them so
  // the goal loop below converts "the reviewer said no" into rework tasks
  // with the reviewer's reason as the brief, instead of finishing anyway.
  let pendingReviewReentries: ReturnType<typeof listPendingReviewReentryRequests> = [];
  try {
    pendingReviewReentries = listPendingReviewReentryRequests(upperId);
  } catch {
    pendingReviewReentries = [];
  }
  const completionReconciliation =
    pendingReviewReentries.length > 0
      ? {
          ...rawCompletionReconciliation,
          satisfied: false,
          gaps: [
            ...rawCompletionReconciliation.gaps,
            ...pendingReviewReentries.map((request) => buildReviewGapText(request)),
          ],
          confidence: Math.min(rawCompletionReconciliation.confidence, 0.5),
        }
      : rawCompletionReconciliation;
  const completionNextAction = buildCompletionNextAction({
    goal: completionGoal,
    reconciliation: completionReconciliation,
  });

  // Goal Satisfaction Loop (E2E series follow-up): "completed" must mean the
  // USER'S goal is satisfied, not that all planned tasks ran. Unsatisfied
  // reconciliation feeds its gaps back into the team as work — the mission
  // only finishes when the outcome contract holds or the operator decides.
  const goalLoopMaxRounds = Number(getRegisteredEnvText('KYBERION_GOAL_LOOP_MAX_ROUNDS') ?? 2);
  if (
    goalLoopMaxRounds > 0 &&
    !completionReconciliation.satisfied &&
    completionReconciliation.gaps.length > 0
  ) {
    const currentRound = Number(state.context?.goal_reconciliation_round || 0);
    const gapSummary = completionReconciliation.gaps.slice(0, 3).join(' / ');
    if (currentRound < goalLoopMaxRounds) {
      const nextRound = currentRound + 1;
      const gapTaskIds = upsertGoalGapTasks({
        missionDir,
        round: nextRound,
        gaps: completionReconciliation.gaps,
        goal: completionGoal,
      });
      for (const request of pendingReviewReentries) {
        try {
          markReviewReentryProcessed('mission_controller', upperId, request.request_id, gapTaskIds);
        } catch {
          // Best-effort: an unprocessable marker leaves the request pending,
          // which re-merges it next round instead of losing it.
        }
      }
      state.context = {
        ...(state.context || {}),
        goal_reconciliation_round: nextRound,
        goal_reconciliation_last_gaps: completionReconciliation.gaps.slice(0, 5),
      };
      state.status = 'active';
      state.history.push({
        ts: new Date().toISOString(),
        event: 'GOAL_GAP_REALIGN',
        note: `Goal not yet satisfied (round ${nextRound}/${goalLoopMaxRounds}). Gap tasks dispatched: ${gapTaskIds.join(', ')} — ${gapSummary}`,
      });
      writeMissionGateRecord({
        missionId: upperId,
        gateId: 'goal-satisfaction',
        evidenceDir: path.join(missionDir, 'gates'),
        payload: {
          verdict: 'fail',
          checked_at: new Date().toISOString(),
          reason: `goal gaps remain (round ${nextRound}/${goalLoopMaxRounds}): ${gapSummary}`,
        },
      });
      recordAgentRuntimeEvent(args.agentRuntimeEventPath, {
        event: 'MISSION_GOAL_GAP_REALIGN',
        mission_id: upperId,
        round: nextRound,
        max_rounds: goalLoopMaxRounds,
        gaps: completionReconciliation.gaps.slice(0, 5),
        gap_task_ids: gapTaskIds,
      });
      await saveState(upperId, state);
      logger.warn(
        `🔁 [GOAL_LOOP] Mission ${upperId} not yet satisfying its goal — dispatched ${gapTaskIds.length} gap task(s) (round ${nextRound}/${goalLoopMaxRounds}). Re-run the orchestration worker, then finish again.`
      );
      return;
    }
    // Rounds exhausted: the team could not close the gap autonomously —
    // block finish and put the decision in front of the operator.
    recordMissionFinishGateFailure({
      missionId: upperId,
      state,
      missionDir,
      gateId: 'goal-satisfaction',
      reason: `goal not satisfied after ${goalLoopMaxRounds} gap-closing rounds: ${gapSummary}`,
      agentRuntimeEventPath: args.agentRuntimeEventPath,
      pendingTasks: [],
      repairStrategy: 'operator',
    });
    await saveState(upperId, state);
    return;
  }
  writeMissionGateRecord({
    missionId: upperId,
    gateId: 'goal-satisfaction',
    evidenceDir: path.join(missionDir, 'gates'),
    payload: {
      verdict: 'pass',
      checked_at: new Date().toISOString(),
      reason: completionReconciliation.satisfied
        ? `goal satisfied (confidence=${completionReconciliation.confidence})`
        : 'goal loop disabled or no actionable gaps — completing with reported next action',
    },
  });

  const traceCtx = createActuatorTrace('mission-controller', 'finish', {
    pipelineId: upperId,
    missionId: upperId,
  });
  traceCtx.startSpan('mission:finish', {
    evidence_count: evidence.length,
    tier: state.tier,
  });

  logger.info(`🏁 Finishing Mission: ${upperId}...`);

  try {
    traceCtx.startSpan('mission:commit');
    safeExec('git', ['add', '.'], { cwd: missionDir });
    safeExec('git', ['commit', '-m', `feat: complete mission ${upperId}`], { cwd: missionDir });
    state.git.latest_commit = args.getGitHash(missionDir);
    traceCtx.endSpan('ok');
  } catch (_) {
    logger.info('No changes to commit in mission repo.');
    traceCtx.endSpan('ok');
  }

  if (state.status !== 'completed') {
    traceCtx.startSpan('mission:complete-state');
    if (state.status === 'validating') {
      state.status = args.transitionStatus(state.status, 'distilling');
    }
    state.status = args.transitionStatus(state.status, 'completed');
    state.history.push({
      ts: new Date().toISOString(),
      event: 'FINISH',
      note: 'Mission completed.',
    });
    traceCtx.endSpan('ok');
  }
  traceCtx.startSpan('mission:evidence');
  for (const item of evidence) {
    traceCtx.addArtifact('file', item.ref, 'mission evidence ref');
  }
  traceCtx.endSpan('ok');
  await saveState(upperId, state);
  await args.syncProjectLedgerIfLinked(upperId);
  traceCtx.addEvent('ledger.synced', { evidence_count: evidence.length });

  // E2E-04 Tasks 2+3: deliverables land in the operator inbox and the
  // completion is pushed to the configured channel (failure-tolerant).
  try {
    if (evidenceRefs.length > 0) {
      addInboxEntry({
        missionId: upperId,
        title: completionGoal.summary,
        artifactPaths: evidenceRefs,
        summary:
          (typeof completionNextAction === 'string'
            ? completionNextAction
            : completionNextAction?.next_step) || `Mission ${upperId} completed.`,
      });
      void notifyOperator('deliverable_ready', {
        title: completionGoal.summary,
        body: `成果物 ${evidenceRefs.length} 件が inbox に届きました。`,
        link_hint: 'pnpm kyberion inbox',
        correlation_id: upperId,
      });
    }
    void notifyOperator('mission_completed', {
      title: `Mission ${upperId} completed`,
      body: completionGoal.summary,
      link_hint: `pnpm mission status ${upperId}`,
      correlation_id: upperId,
    });
  } catch (err: any) {
    logger.warn(
      `⚠️ [NOTIFY] Completion notification failed for ${upperId}: ${err?.message || err}`
    );
  }

  // Retrospective Loop (⑤ Review の自動化): measure how the team worked,
  // persist token/cost statistics, and queue process/team improvement
  // proposals for operator ratification. The mission is already completed
  // above, so the caller receives a completed mission only after this
  // post-success evidence has been attempted.
  try {
    await runMissionRetrospective(upperId);
  } catch (err: unknown) {
    logger.warn(
      `⚠️ [RETROSPECTIVE] skipped for ${upperId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  traceCtx.startSpan('mission:customer-delivery');
  try {
    publishMeetingDeliverablesIfNeeded({
      missionId: upperId,
      missionDir,
      state,
      completionNextAction,
      traceCtx,
    });
    traceCtx.endSpan('ok');
  } catch (err: any) {
    logger.warn(`⚠️ [DELIVERY] Meeting deliverables failed for ${upperId}: ${err?.message || err}`);
    traceCtx.endSpan('error', err?.message || String(err));
  }

  if (seal || (state.tier === 'personal' && getRegisteredEnvBool('KYBERION_AUTO_SEAL') === true)) {
    traceCtx.startSpan('mission:seal');
    await args.sealMission(upperId);
    traceCtx.endSpan('ok');
  }

  try {
    traceCtx.startSpan('mission:memory-promotion');
    const memoryPath = path.join(
      pathResolver.volatile('mission', upperId, { tier: state.tier }),
      'MEMORY.md'
    );
    const memorySummary = safeExistsSync(memoryPath)
      ? extractPromotableMissionMemory(safeReadFile(memoryPath, { encoding: 'utf8' }) as string)
      : null;
    const memoryEvidenceRefs = memorySummary
      ? [...evidence.map((item) => item.ref), memoryPath]
      : evidence.map((item) => item.ref);
    const queued = queueMissionMemoryPromotionCandidate({
      missionId: upperId,
      missionType: state.mission_type,
      tier: state.tier,
      summary:
        memorySummary ||
        state.outcome_contract?.requested_result ||
        `Mission ${upperId} completed and yielded reusable operational memory.`,
      evidenceRefs: memoryEvidenceRefs,
    });
    if (memorySummary) updateMissionMemorySidecar(memoryPath, queued.candidate_id);
    logger.info(
      `🧠 [MEMORY_PROMOTION] queued candidate ${queued.candidate_id} (${queued.proposed_memory_kind}).`
    );
    traceCtx.endSpan('ok');
  } catch (err: any) {
    logger.warn(`⚠️ [MEMORY_PROMOTION] queue skipped for ${upperId}: ${err?.message || err}`);
    traceCtx.endSpan('error', err?.message || String(err));
  }

  maybeRunVolatileGc(upperId, traceCtx);

  if (!ledger.verifyIntegrity()) {
    logger.warn(
      `⚠️ [LEDGER_INTEGRITY] Global ledger integrity check failed for mission ${upperId}. The ledger may be corrupted — review ${upperId} audit trail before relying on it.`
    );
    traceCtx.addEvent('ledger.integrity_failed');
  }

  traceCtx.startSpan('mission:ledger-record');
  ledger.record('MISSION_FINISH', {
    mission_id: upperId,
    status: 'completed',
    sealed: seal,
    archive_path: args.archiveDir,
  });
  traceCtx.endSpan('ok');

  recordAgentRuntimeEvent(args.agentRuntimeEventPath, {
    event: 'MISSION_FINISH_REFRESH_RECOMMENDED',
    mission_id: upperId,
    tier: state.tier,
    note: 'Mission finished. Control surfaces may refresh or restart mission-bound agents to reduce stale context.',
  });

  // AL-03: retention closure — reached only on a successful finish (every
  // gate above passed and the state already transitioned to `completed`), so
  // failed finishes never touch the tree. Deletes disposable classes
  // (cache/tmp) per the retention catalog, bundles the per-mission git repo
  // into evidence/ and removes the nested `.git` (KM-04), and audits the
  // deletions. Idempotent and best-effort: closure must never fail a finish
  // that already succeeded.
  traceCtx.startSpan('mission:artifact-closure');
  try {
    const closure = closeMissionArtifacts({ missionId: upperId, missionDir });
    state.context = {
      ...(state.context || {}),
      mission_artifact_closure: {
        status: closure.status,
        deleted_directories: closure.deleted_directories,
        deleted_index_entry_count: closure.deleted_index_entries.length,
        bundle_status: closure.bundle?.status,
      },
    };
    traceCtx.endSpan('ok');
  } catch (err: any) {
    logger.warn(`⚠️ [ARTIFACT_CLOSURE] skipped for ${upperId}: ${err?.message || err}`);
    traceCtx.endSpan('error', err?.message || String(err));
  }

  const missionTmpDir = pathResolver.sharedTmp(path.join('missions', upperId));
  if (safeExistsSync(missionTmpDir)) {
    traceCtx.startSpan('mission:purge-temp');
    logger.info('🧹 Purging mission runtime temp...');
    safeRmSync(missionTmpDir, { recursive: true, force: true });
    traceCtx.endSpan('ok');
  }

  if (!safeExistsSync(args.archiveDir)) safeMkdir(args.archiveDir, { recursive: true });
  const archivePath = path.join(args.archiveDir, upperId);
  traceCtx.startSpan('mission:archive');
  if (safeExistsSync(archivePath)) safeExec('rm', ['-rf', archivePath]);
  safeExec('cp', ['-r', missionDir, archivePath]);
  safeExec('rm', ['-rf', missionDir]);
  traceCtx.endSpan('ok');

  state.status = args.transitionStatus(state.status, 'archived');
  state.history.push({
    ts: new Date().toISOString(),
    event: 'ARCHIVE',
    note: `Mission archived to ${archivePath}.`,
  });
  await saveState(upperId, state);
  traceCtx.endSpan('ok');
  const traceResult = finalizeActuatorTrace(traceCtx);
  state.context = {
    ...(state.context || {}),
    mission_completion_next_action: completionNextAction,
    mission_completion_summary: {
      requested_result: completionNextAction.request,
      satisfied: completionNextAction.satisfied,
      delivered: completionNextAction.delivered,
      gaps: completionNextAction.gaps,
      next_step: completionNextAction.next_step,
      confidence: completionNextAction.confidence,
    },
    mission_completion_reconciliation: completionReconciliation,
    mission_finish_trace_summary: traceResult.trace_summary,
    mission_finish_trace_persisted_path: traceResult.trace_persisted_path,
  };
  await saveState(upperId, state);
  logger.success(`📦 Mission ${upperId} archived and finalized.`);
}

/**
 * LC-11: process pending human review re-entry requests for a mission that
 * already finished (or is otherwise idle). Rides the IL-04 goal loop: each
 * request becomes goal-gap rework tasks whose brief carries the reviewer's
 * verdict, category, and comment; the mission returns to `active` for the
 * orchestration worker. In-flight missions don't need this command — finish
 * merges pending requests into reconciliation automatically.
 */
export async function reenterMissionFromReview(
  id: string
): Promise<{ status: 'no_pending' | 'reentered'; gapTaskIds: string[] }> {
  if (!id) {
    logger.error('Usage: mission_controller review-reenter <MISSION_ID>');
    return { status: 'no_pending', gapTaskIds: [] };
  }
  const upperId = id.toUpperCase();
  const state = loadState(upperId);
  if (!state) {
    logger.error(`Mission ${upperId} not found.`);
    return { status: 'no_pending', gapTaskIds: [] };
  }
  const pending = listPendingReviewReentryRequests(upperId);
  if (pending.length === 0) {
    logger.info(`Mission ${upperId} has no pending review re-entry requests.`);
    return { status: 'no_pending', gapTaskIds: [] };
  }
  const missionDir = findMissionPath(upperId);
  if (!missionDir) {
    logger.error(`Mission directory not found for ${upperId}.`);
    return { status: 'no_pending', gapTaskIds: [] };
  }

  const goal = {
    summary:
      state.intent?.goal_summary ||
      state.outcome_contract?.requested_result ||
      `Mission ${upperId}`,
    success_condition:
      state.intent?.success_condition ||
      state.outcome_contract?.success_criteria?.join('; ') ||
      state.outcome_contract?.requested_result ||
      `Mission ${upperId}`,
  };
  // Share the goal-loop round counter so task ids never collide with
  // finish-time gap tasks; an operator-invoked re-entry is deliberate, so it
  // is not capped by KYBERION_GOAL_LOOP_MAX_ROUNDS.
  const nextRound = Number(state.context?.goal_reconciliation_round || 0) + 1;
  const gaps = pending.map((request) => buildReviewGapText(request));
  const gapTaskIds = upsertGoalGapTasks({ missionDir, round: nextRound, gaps, goal });
  for (const request of pending) {
    try {
      markReviewReentryProcessed('mission_controller', upperId, request.request_id, gapTaskIds);
    } catch {
      // Leaving the request pending re-merges it at the next finish attempt.
    }
  }

  const previousStatus = state.status;
  state.status = 'active';
  state.context = {
    ...(state.context || {}),
    goal_reconciliation_round: nextRound,
    review_reentry_last_gaps: gaps.slice(0, 5),
  };
  state.history.push({
    ts: new Date().toISOString(),
    event: 'REVIEW_GAP_REALIGN',
    note: `Human review re-entry (${pending.length} request(s), was ${previousStatus}). Rework tasks: ${gapTaskIds.join(', ')}`,
  });
  await saveState(upperId, state);
  recordAgentRuntimeEvent(
    pathResolver.shared('observability/mission-control/agent-runtime-events.jsonl'),
    {
      event: 'MISSION_REVIEW_GAP_REALIGN',
      mission_id: upperId,
      round: nextRound,
      requests: pending.map((request) => request.request_id),
      gap_task_ids: gapTaskIds,
    }
  );
  logger.warn(
    `🔁 [REVIEW_LOOP] Mission ${upperId} re-entered from human review (${pending.length} request(s)) — dispatched ${gapTaskIds.length} rework task(s). Run the orchestration worker, then finish again.`
  );
  return { status: 'reentered', gapTaskIds };
}
