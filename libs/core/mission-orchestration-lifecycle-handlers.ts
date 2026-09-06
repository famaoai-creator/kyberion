import {
  buildMissionTeamView,
  resolveMissionTeamPlan,
  resolveMissionTeamReceiver,
} from './mission-team-plan-composer.js';
import {
  ensureMissionTeamRuntimeViaSupervisor,
  shutdownAllAgentRuntimes,
} from './agent-runtime-supervisor.js';
import {
  enqueueMissionOrchestrationEvent,
  startMissionOrchestrationWorker,
  type MissionOrchestrationEvent,
} from './mission-orchestration-events.js';
import { buildExecutionEnv } from './authority.js';
import { logger } from './core.js';
import { resolveMissionPlanningPacket } from './mission-orchestration-planning.js';
import { summarizeMissionGateState } from './mission-orchestration-phase-gates.js';
import * as nodePath from 'node:path';
import { missionEvidenceDir, pathResolver } from './path-resolver.js';
import {
  evaluateMissionPhaseExitGates,
  resolvePhaseGateMode,
} from './mission-orchestration-phase-gates.js';
import { summarizeHeuristics } from './heuristic-feedback.js';
import { notifyOperator } from './operator-notifications.js';
import {
  loadMissionOrchestrationReplayPlan,
  provisionMissionEntry,
  writeProvisionedJson,
} from './mission-orchestration-journal.js';
import { recoverMissionRequestedTasks } from './mission-task-recovery.js';
import { emitMissionOrchestrationObservation } from './mission-orchestration-events.js';
import { payloadSurface } from './mission-orchestration-worker-contracts.js';
import {
  enqueueChronosOutboxMessage,
  enqueueSurfaceOutboxMessage,
} from './surface-coordination-store.js';
import { safeExec } from './secure-io.js';
import type { PlanningPacket } from './channel-surface.js';
import type {
  MissionControlPayload,
  MissionWorkerRecoveryPayload,
  PlannedNextTask,
  SlackPayload,
  SurfaceControlPayload,
} from './mission-orchestration-worker-contracts.js';
import type { MissionDispatchOptions } from './mission-orchestration-worker-part-results.js';

const MISSION_CONTROLLER_TIMEOUT_MS = 600_000;

export interface MissionLifecycleHandlerDeps {
  runMissionController: (env: NodeJS.ProcessEnv, args: string[]) => void;
  emitSlackMissionEvent: (
    payload: SlackPayload,
    missionId: string,
    decision: string,
    why: string,
    extra?: Record<string, unknown>
  ) => void;
  resolveMissionType: (payload: SlackPayload) => string;
  emitWorkerKickoffSnapshot: (missionId: string, payload: SlackPayload) => Promise<void>;
  persistPlanningPacket: (missionId: string, packet: PlanningPacket) => void;
  syncPlanningArtifacts: (missionId: string) => void;
  reconcileMissionProgress: (missionId: string) => void;
  dispatchMissionNextTasks: (
    missionId: string,
    graphRunId?: string,
    options?: MissionDispatchOptions
  ) => Promise<Array<{ task_id: string; team_role: string; agent_id: string }>>;
  emitWorkerTransitionSnapshot: (missionId: string, stageKey: string, goalHint?: string) => void;
  summarizeMissionTaskOutcomes: (missionId: string) => {
    acceptedCount: number;
    reviewedCount: number;
    completedCount: number;
    requestedCount: number;
  };
  notifyRequestingSurface: (payload: SlackPayload, missionId: string, text: string) => void;
  loadPlannedNextTasks: (missionId: string) => PlannedNextTask[];
}

export async function handleMissionIssueRequested(
  event: MissionOrchestrationEvent<SlackPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const payload = event.payload;
  const missionId = event.mission_id;
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const tier = payload.tier || 'public';
  const persona = payload.persona || 'Ecosystem Architect';
  const missionType = deps.resolveMissionType(payload);

  deps.runMissionController(env, ['start', missionId, tier, persona, 'default', missionType]);
  deps.emitSlackMissionEvent(
    payload,
    missionId,
    'mission_issued',
    'Mission was issued from an orchestration event.',
    {
      mission_type: missionType,
      tier,
    }
  );

  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_team_prewarm_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    scope: event.scope,
    payload: {
      ...payload,
      teamRoles: payload.teamRoles?.length ? payload.teamRoles : ['planner'],
    },
  });
  startMissionOrchestrationWorker(nextEvent);
}

export async function handleMissionTeamPrewarmRequested(
  event: MissionOrchestrationEvent<SlackPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const payload = event.payload;
  const missionId = event.mission_id;

  deps.emitSlackMissionEvent(
    payload,
    missionId,
    'mission_orchestration_started',
    'Background mission orchestration started.'
  );

  // Prewarm the whole required team, not just the planner: lazily-spawned
  // roles used to pay their spawn latency inside the first work dispatch.
  let prewarmRoles = payload.teamRoles?.length ? payload.teamRoles : [];
  if (prewarmRoles.length === 0 || (prewarmRoles.length === 1 && prewarmRoles[0] === 'planner')) {
    try {
      const teamPlan = resolveMissionTeamPlan({ missionId });
      const requiredRoles = teamPlan.assignments
        .filter((assignment) => assignment.required && assignment.agent_id)
        .map((assignment) => assignment.team_role);
      if (requiredRoles.length > 0) prewarmRoles = requiredRoles;
    } catch (error: any) {
      logger.warn(
        `[worker] team plan resolution for prewarm failed (falling back to planner): ${error?.message ?? error}`
      );
    }
  }
  const runtimePlan = await ensureMissionTeamRuntimeViaSupervisor({
    missionId,
    teamRoles: prewarmRoles.length > 0 ? prewarmRoles : ['planner'],
    requestedBy: 'mission_orchestration_worker',
    reason: 'Prewarm agent runtime before kickoff.',
    timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
  });

  deps.emitSlackMissionEvent(
    payload,
    missionId,
    'mission_team_staffed',
    'Required team runtimes were prewarmed.',
    {
      assignments: runtimePlan.runtime_plan.assignments.map((assignment) => ({
        team_role: assignment.team_role,
        agent_id: assignment.agent_id,
        runtime_status: assignment.runtime_status,
      })),
    }
  );

  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_kickoff_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    scope: event.scope,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
}

export async function handleMissionKickoffRequested(
  event: MissionOrchestrationEvent<SlackPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const payload = event.payload;
  const missionId = event.mission_id;
  await deps.emitWorkerKickoffSnapshot(missionId, payload);
  const env = buildExecutionEnv(process.env, 'mission_controller');

  deps.runMissionController(env, [
    'record-task',
    missionId,
    'Initial planning kickoff from mission orchestration event',
    JSON.stringify({
      source: 'slack',
      channel: payload.channel,
      threadTs: payload.threadTs,
      sourceText: payload.sourceText,
      proposal: payload.proposal,
    }),
  ]);

  const plan = resolveMissionTeamPlan({ missionId });
  const plannerAssignment = resolveMissionTeamReceiver({ missionId, teamRole: 'planner' });
  if (!plannerAssignment?.agent_id) {
    throw new Error(`Planner assignment not found for ${missionId}`);
  }

  const teamView = buildMissionTeamView(plan);
  const planningPacket = await resolveMissionPlanningPacket(
    missionId,
    plan,
    payload,
    plannerAssignment.agent_id,
    teamView
  );
  const kickoffExcerpt = JSON.stringify(planningPacket).slice(0, 240);
  logger.info(
    `[MISSION_ORCHESTRATION] Planner kickoff complete for ${missionId}: ${kickoffExcerpt}`
  );
  deps.persistPlanningPacket(missionId, planningPacket);
  deps.syncPlanningArtifacts(missionId);
  deps.reconcileMissionProgress(missionId);
  deps.emitSlackMissionEvent(
    payload,
    missionId,
    'mission_kickoff_completed',
    'Planner kickoff request was delivered.',
    {
      planner_agent_id: plannerAssignment.agent_id,
      planned_task_count: planningPacket.next_tasks.length,
    }
  );
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_followup_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    scope: event.scope,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

export async function handleMissionFollowupRequested(
  event: MissionOrchestrationEvent<SlackPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const payload = event.payload;
  const missionId = event.mission_id;
  deps.emitWorkerTransitionSnapshot(
    missionId,
    'execution',
    `Mission ${missionId} follow-up dispatched`
  );
  deps.emitSlackMissionEvent(
    payload,
    missionId,
    'mission_followup_requested',
    'Planner artifacts were reconciled and follow-up delegation started.'
  );
  const dispatched = await deps.dispatchMissionNextTasks(missionId, event.event_id);
  deps.emitSlackMissionEvent(
    payload,
    missionId,
    'mission_followup_dispatched',
    'Planner-produced follow-up tasks were delegated.',
    {
      dispatched_tasks: dispatched,
    }
  );
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_reconciliation_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    scope: event.scope,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

export async function handleMissionReconciliationRequested(
  event: MissionOrchestrationEvent<SlackPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const payload = event.payload;
  const missionId = event.mission_id;
  deps.emitWorkerTransitionSnapshot(
    missionId,
    'verification',
    `Mission ${missionId} reconciling outcomes`
  );
  deps.reconcileMissionProgress(missionId);
  deps.emitSlackMissionEvent(
    payload,
    missionId,
    'mission_reconciliation_completed',
    'Mission task outcomes were reconciled into mission state.'
  );
  const summary = deps.summarizeMissionTaskOutcomes(missionId);
  const gateSummary = summarizeMissionGateState(missionId);
  deps.emitSlackMissionEvent(
    payload,
    missionId,
    'mission_owner_notified',
    'Owner summary emitted after reconciliation.',
    {
      accepted_count: summary.acceptedCount,
      reviewed_count: summary.reviewedCount,
      completed_count: summary.completedCount,
      requested_count: summary.requestedCount,
      gate_rework_count: gateSummary.reworkCount,
      gate_statuses: gateSummary.lines,
    }
  );
  deps.notifyRequestingSurface(
    payload,
    missionId,
    [
      `Mission ${missionId} progress update.`,
      `Accepted: ${summary.acceptedCount}`,
      `Reviewed: ${summary.reviewedCount}`,
      `Completed: ${summary.completedCount}`,
      `Requested: ${summary.requestedCount}`,
      `Gate rework count: ${gateSummary.reworkCount}`,
      ...(gateSummary.lines.length > 0 ? ['Gate status:', ...gateSummary.lines] : []),
    ].join('\n')
  );
  // Work-loop closure: while dispatchable work remains, loop back to followup
  // instead of racing ahead to distillation. This converges: acceptance-gate
  // rework is requested at most once per task, and undispatchable tasks are
  // marked blocked (terminal for the automated chain), so the planned/rework
  // pool strictly shrinks.
  const remainingPlanned = deps.loadPlannedNextTasks(missionId).length;
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType:
      remainingPlanned > 0 ? 'mission_followup_requested' : 'mission_distillation_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    scope: event.scope,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

export async function handleMissionDistillationRequested(
  event: MissionOrchestrationEvent<SlackPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const payload = event.payload;
  const missionId = event.mission_id;
  deps.emitWorkerTransitionSnapshot(
    missionId,
    'retrospective',
    `Mission ${missionId} distilling knowledge`
  );

  // Capture a heuristic validation snapshot alongside CLI distillation so
  // the retrospective phase closes the intent-loop "learn" stage even if
  // no heuristics have been validated yet.
  try {
    const report = summarizeHeuristics(10);
    const evidenceDir = missionEvidenceDir(missionId);
    if (evidenceDir) {
      writeProvisionedJson({
        missionId,
        filePath: nodePath.join(evidenceDir, 'heuristic-feedback-report.json'),
        targetPath: 'evidence/heuristic-feedback-report.json',
        provisioned: provisionMissionEntry(report),
      });
    }
  } catch (err: any) {
    logger.warn(`[worker] heuristic summary skipped for ${missionId}: ${err?.message ?? err}`);
  }

  // Run distillation via mission controller CLI
  const env = buildExecutionEnv(process.env, 'mission_controller');
  try {
    deps.runMissionController(env, ['distill', missionId]);
    deps.emitSlackMissionEvent(
      payload,
      missionId,
      'mission_distillation_completed',
      'Mission knowledge was distilled into reusable learnings.'
    );
  } catch (error: any) {
    deps.emitSlackMissionEvent(
      payload,
      missionId,
      'mission_distillation_failed',
      `Distillation failed: ${error.message}. Manual review recommended.`
    );
  }

  // MO-02: phase exit gates guard the completion event.
  const gateMode = resolvePhaseGateMode();
  if (gateMode !== 'off') {
    const exitGates = await evaluateMissionPhaseExitGates(missionId);
    if (!exitGates.passed) {
      const circuitBreak = exitGates.failures.some((failure) => failure.prior_failures >= 2);
      const failureLines = exitGates.failures
        .map((failure) => `${failure.gate_id} (${failure.phase}): ${failure.reasons.join('; ')}`)
        .join(' | ');
      deps.emitSlackMissionEvent(
        payload,
        missionId,
        circuitBreak ? 'mission_phase_gate_circuit_breaker' : 'mission_phase_gate_failed',
        circuitBreak
          ? `Phase exit gates failed repeatedly (${failureLines}). Realignment recommended: review the plan with the owner before completing.`
          : `Phase exit gates not satisfied (${failureLines}).${gateMode === 'enforce' ? ' Completion is blocked until the gates pass or an operator overrides via gate-pass.' : ' (warn mode: completion continues; set KYBERION_PHASE_GATE_MODE=enforce to block)'}`
      );
      if (gateMode === 'enforce') {
        logger.warn(
          `[worker] completion blocked for ${missionId}: ${exitGates.failures.length} exit gate(s) failing`
        );
        await shutdownAllAgentRuntimes('mission_orchestration_worker');
        return;
      }
    }
  }

  // Continue to completion
  const nextEvent2 = enqueueMissionOrchestrationEvent({
    eventType: 'mission_completion_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    scope: event.scope,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent2);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

export async function handleMissionCompletionRequested(
  event: MissionOrchestrationEvent<SlackPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const payload = event.payload;
  const missionId = event.mission_id;
  deps.emitWorkerTransitionSnapshot(
    missionId,
    'delivery',
    `Mission ${missionId} completing lifecycle`
  );

  const env = buildExecutionEnv(process.env, 'mission_controller');
  try {
    deps.runMissionController(env, ['finish', missionId]);
    deps.emitSlackMissionEvent(
      payload,
      missionId,
      'mission_completed',
      'Mission lifecycle completed. Artifacts and learnings are archived.'
    );
  } catch (error: any) {
    deps.emitSlackMissionEvent(
      payload,
      missionId,
      'mission_completion_failed',
      `Completion failed: ${error.message}. Manual intervention required.`
    );
    // finish requires the owner's verify — surface the pending decision to
    // the operator instead of leaving the mission silently unfinishable.
    void notifyOperator('approval_required', {
      title: `Mission ${missionId}: completion blocked — owner action needed`,
      body: [
        `mission_controller finish failed: ${error.message}`,
        `If work is done, verify first: pnpm mission verify ${missionId} verified "<note>" then finish.`,
      ].join('\n'),
      correlation_id: `${missionId}:completion-blocked`,
    });
  }

  deps.notifyRequestingSurface(payload, missionId, `Mission ${missionId} lifecycle completed.`);
  // Completion is high-signal for every surface: push it to the operator's
  // configured channel too (deduped by correlation id; best-effort).
  void notifyOperator('mission_completed', {
    title: `Mission ${missionId} lifecycle completed`,
    body: `Requested via ${payloadSurface(payload)} (${payload.channel}). Artifacts and learnings are archived.`,
    correlation_id: `${missionId}:completed`,
  });
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

/**
 * SN-01: deliver a mission progress/result message back to the surface the
 * request originated from, plus the Chronos mirror. Best-effort on both legs —
 * a denied outbox write must never stall the mission lifecycle.
 */
export function notifyRequestingSurface(
  payload: SlackPayload,
  missionId: string,
  text: string
): void {
  const surface = payloadSurface(payload);
  try {
    enqueueSurfaceOutboxMessage({
      surface,
      correlationId: missionId,
      channel: payload.channel,
      threadTs: payload.threadTs,
      text,
      source: 'system',
    });
  } catch (error: any) {
    logger.warn(
      `[worker] ${surface} outbox notification skipped for ${missionId}: ${error?.message ?? error}`
    );
  }
  if (surface !== 'chronos') {
    try {
      enqueueChronosOutboxMessage({
        correlationId: missionId,
        threadTs: missionId,
        source: 'system',
        text,
      });
    } catch (error: any) {
      logger.warn(
        `[worker] chronos outbox notification skipped for ${missionId}: ${error?.message ?? error}`
      );
    }
  }
}

export async function handleMissionControlRequested(
  event: MissionOrchestrationEvent<MissionControlPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const missionId = event.mission_id;
  const operation = event.payload.operation;

  switch (operation) {
    case 'resume':
      {
        const replayPlan = loadMissionOrchestrationReplayPlan(missionId, event.scope);
        const recovery = recoverMissionRequestedTasks(missionId);
        if (replayPlan.next_event) {
          startMissionOrchestrationWorker(replayPlan.next_event);
        }
        emitMissionOrchestrationObservation({
          decision: 'mission_resume_replay_planned',
          event_type: 'mission_control_requested',
          requested_by: event.requested_by,
          mission_id: missionId,
          next_event_id: replayPlan.next_event?.event_id,
          next_event_type: replayPlan.next_event?.event_type,
          replay_count: replayPlan.replay_count,
          recovery_required: replayPlan.recovery_required,
          recovery_reason: replayPlan.recovery_reason,
          unverified_provisioned_entry_count: replayPlan.unverified_provisioned_entries.length,
          missing_provisioned_entry_count: replayPlan.missing_provisioned_entries.length,
          recovered_task_count: recovery.reissued_count,
          waiting_task_count: recovery.waiting_count,
        });
      }
      deps.runMissionController(env, ['resume', missionId]);
      break;
    case 'pause':
      deps.runMissionController(env, ['pause', missionId]);
      break;
    case 'cancel':
      deps.runMissionController(env, ['cancel', missionId]);
      break;
    case 'refresh_team':
      deps.runMissionController(env, ['team', missionId, '--refresh']);
      break;
    case 'prewarm_team':
      deps.runMissionController(env, ['prewarm', missionId]);
      break;
    case 'staff_team':
      deps.runMissionController(env, ['staff', missionId]);
      break;
    case 'finish':
      deps.runMissionController(env, ['finish', missionId]);
      break;
    default:
      throw new Error(`Unsupported mission control operation: ${String(operation)}`);
  }

  emitMissionOrchestrationObservation({
    decision: 'mission_control_action_applied',
    event_type: 'mission_control_action_applied',
    requested_by: event.requested_by,
    mission_id: missionId,
    operation,
    why: 'Event-driven mission control action executed by the orchestration worker.',
  });
}

/**
 * Recovery ceremony owned by the mission worker, not the provider runtime
 * supervisor. The dispatch layer selects only tasks with a persisted paused
 * goal journal and passes the explicit resume bit to the goal driver.
 */
export async function handleMissionWorkerRecoveryRequested(
  event: MissionOrchestrationEvent<MissionWorkerRecoveryPayload>,
  deps: MissionLifecycleHandlerDeps
): Promise<void> {
  if (event.payload.operation !== 'resume_goal_driven') {
    throw new Error(`Unsupported mission worker recovery operation: ${event.payload.operation}`);
  }
  const dispatched = await deps.dispatchMissionNextTasks(event.mission_id, event.event_id, {
    resumeGoalDriven: true,
  });
  emitMissionOrchestrationObservation({
    decision: 'mission_worker_recovery_completed',
    event_type: event.event_type,
    event_id: event.event_id,
    mission_id: event.mission_id,
    requested_by: event.requested_by,
    recovered_task_count: dispatched.length,
    recovered_task_ids: dispatched.map((task) => task.task_id),
    recovery_kind: 'goal_driven_resume',
  });
  await shutdownAllAgentRuntimes('mission_worker_recovery');
}

export async function handleSurfaceControlRequested(
  event: MissionOrchestrationEvent<SurfaceControlPayload>,
  deps: MissionLifecycleHandlerDeps
) {
  const operation = event.payload.operation;
  const surfaceId = event.payload.surfaceId;
  const env = buildExecutionEnv(process.env, 'surface_runtime');
  const args = ['dist/scripts/surface_runtime.js', '--action'];

  if (operation === 'reconcile' || operation === 'status') {
    args.push(operation);
  } else if ((operation === 'start' || operation === 'stop') && surfaceId) {
    args.push(operation, '--surface', surfaceId);
  } else {
    throw new Error(`Unsupported surface control operation: ${String(operation)}`);
  }

  safeExec('node', args, {
    cwd: pathResolver.rootDir(),
    env,
    timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
  });
  emitMissionOrchestrationObservation({
    decision: 'surface_control_action_applied',
    event_type: 'surface_control_action_applied',
    requested_by: event.requested_by,
    resource_id: surfaceId || 'surface-runtime',
    mission_id: event.mission_id,
    operation,
    why: 'Event-driven surface control action executed by the orchestration worker.',
  });
}
