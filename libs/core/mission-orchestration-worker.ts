import { a2aBridge } from './a2a-bridge.js';
import { buildMissionTeamView, resolveMissionTeamPlan, resolveMissionTeamReceiver } from './mission-team-plan-composer.js';
import { validateDelegatedTaskPreflight } from './delegation-preflight.js';
import {
  emitChannelSurfaceEvent,
  enqueueChronosOutboxMessage,
  enqueueSlackOutboxMessage,
  extractSurfaceBlocks,
  type PlanningPacket,
} from './channel-surface.js';
import { ensureMissionTeamRuntimeViaSupervisor, shutdownAllAgentRuntimes } from './agent-runtime-supervisor.js';
import { ledger } from './ledger.js';
import { logger } from './core.js';
import { buildExecutionEnv } from './authority.js';
import { missionDir, missionEvidenceDir } from './path-resolver.js';
import { pathResolver } from './path-resolver.js';
import * as nodePath from 'node:path';
import { safeExec, safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { emitMissionTaskEvent } from './mission-task-events.js';
import {
  enqueueMissionOrchestrationEvent,
  emitMissionOrchestrationObservation,
  loadMissionOrchestrationEvent,
  startMissionOrchestrationWorker,
  type MissionOrchestrationEvent,
} from './mission-orchestration-events.js';
import { emitIntentSnapshot, mapStageToLoopPhase } from './intent-snapshot-store.js';
import { summarizeHeuristics } from './heuristic-feedback.js';
import { getIntentExtractor } from './intent-extractor.js';
import { installAnthropicBackendsIfAvailable } from './reasoning-bootstrap.js';

// Install Anthropic-backed reasoning + intent extractor at worker import.
// No-op when ANTHROPIC_API_KEY is unset (stubs remain active).
installAnthropicBackendsIfAvailable();

/**
 * Emit a lifecycle intent snapshot for a worker-driven stage transition.
 * Failures are swallowed so the worker's main work path is never blocked
 * by an evidence-writing mishap (e.g. mission evidence dir still being
 * created). The snapshot produces an append-only trail in
 * active/missions/<id>/evidence/intent-snapshots.jsonl and, as soon as
 * two snapshots exist, paired deltas in intent-deltas.jsonl.
 */
function emitWorkerTransitionSnapshot(
  missionId: string,
  stageKey: string,
  goalHint?: string,
): void {
  if (!missionId) return;
  try {
    emitIntentSnapshot({
      missionId,
      stage: stageKey,
      source: 'worker_transition',
      intent: {
        goal: goalHint ?? `Mission ${missionId} progressing through ${mapStageToLoopPhase(stageKey)}`,
      },
    });
  } catch (err: any) {
    // evidence dir may not yet exist on very first events; keep worker non-blocking
    logger.warn(`[worker] intent snapshot skipped for ${missionId}/${stageKey}: ${err?.message ?? err}`);
  }
}

/**
 * Like `emitWorkerTransitionSnapshot` but pulls a real IntentBody out of the
 * Slack payload text via the registered IntentExtractor. Use on the entry
 * transition (`intake`) where the user's original utterance is available —
 * this is the baseline against which later snapshots are compared for drift.
 */
async function emitWorkerKickoffSnapshot(
  missionId: string,
  payload: SlackPayload,
): Promise<void> {
  if (!missionId) return;
  const text = (payload as any)?.text;
  if (!text || typeof text !== 'string' || !text.trim()) {
    emitWorkerTransitionSnapshot(missionId, 'intake', `Mission ${missionId} kickoff requested`);
    return;
  }
  try {
    const intent = await getIntentExtractor().extract({ text });
    emitIntentSnapshot({
      missionId,
      stage: 'intake',
      source: 'user_prompt',
      intent,
    });
  } catch (err: any) {
    logger.warn(`[worker] kickoff intent extraction failed for ${missionId}: ${err?.message ?? err}`);
    emitWorkerTransitionSnapshot(missionId, 'intake', `Mission ${missionId} kickoff requested`);
  }
}

const MISSION_CONTROLLER_TIMEOUT_MS = 600_000;

interface SlackPayload {
  channel: string;
  threadTs: string;
  sourceText?: string;
  proposal?: Record<string, unknown>;
  tier?: 'personal' | 'confidential' | 'public';
  persona?: string;
  missionType?: string;
  teamRoles?: string[];
}

interface MissionControlPayload {
  operation: 'resume' | 'refresh_team' | 'prewarm_team' | 'staff_team' | 'finish';
  requested_by_surface?: 'chronos';
}

interface SurfaceControlPayload {
  operation: 'reconcile' | 'status' | 'start' | 'stop';
  surfaceId?: string;
  requested_by_surface?: 'chronos';
}

interface PlannedNextTask {
  task_id: string;
  status?: string;
  assigned_to?: {
    role?: string;
    agent_id?: string;
  };
  description?: string;
  deliverable?: string;
  target_path?: string;
}

const TASK_EVENT_STATUS_MAP: Partial<Record<NonNullable<PlannedNextTask['status']>, 'task_reviewed' | 'task_completed' | 'task_accepted'>> = {
  reviewed: 'task_reviewed',
  completed: 'task_completed',
  accepted: 'task_accepted',
};

function resolveMissionType(payload: SlackPayload): string {
  if (typeof payload.missionType === 'string' && payload.missionType.trim()) {
    return payload.missionType;
  }
  const proposalMissionType = payload.proposal?.mission_type;
  return typeof proposalMissionType === 'string' && proposalMissionType.trim()
    ? proposalMissionType
    : 'development';
}

function runMissionController(env: NodeJS.ProcessEnv, args: string[]) {
  return safeExec(
    'node',
    ['dist/scripts/mission_controller.js', ...args],
    { env, timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS },
  );
}

function syncPlanningArtifacts(missionId: string): void {
  const missionPath = missionDir(missionId, 'public');
  const planPath = `${missionPath}/PLAN.md`;
  const nextTasksPath = `${missionPath}/NEXT_TASKS.json`;
  const taskBoardPath = `${missionPath}/TASK_BOARD.md`;

  if (!safeExistsSync(planPath) || !safeExistsSync(nextTasksPath) || !safeExistsSync(taskBoardPath)) {
    return;
  }

  const currentTaskBoard = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
  const updatedTaskBoard = currentTaskBoard
    .replace('## Status: Planned', '## Status: Planning Ready')
    .replace('- [ ] Step 1: Research and Strategy', '- [x] Step 1: Research and Strategy');

  if (updatedTaskBoard !== currentTaskBoard) {
    safeWriteFile(taskBoardPath, updatedTaskBoard);
  }

  const nextTasks = JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string);
  ledger.record('MISSION_PLAN_READY', {
    mission_id: missionId,
    role: 'planner',
    summary_path: 'PLAN.md',
    next_tasks_path: 'NEXT_TASKS.json',
    planned_task_count: Array.isArray(nextTasks) ? nextTasks.length : 0,
  });
  emitMissionTaskEvent({
    event_type: 'task_submitted',
    mission_id: missionId,
    task_id: 'planner-initial-plan',
    agent_id: 'nerve-agent',
    team_role: 'planner',
    decision: 'task_submitted',
    why: 'Planner produced PLAN.md and NEXT_TASKS.json for the mission kickoff.',
    policy_used: 'mission_orchestration_control_plane_v1',
    evidence: ['PLAN.md', 'NEXT_TASKS.json'],
    payload: {
      summary_path: 'PLAN.md',
      next_tasks_path: 'NEXT_TASKS.json',
    },
  });
  emitMissionTaskEvent({
    event_type: 'task_completed',
    mission_id: missionId,
    task_id: 'planner-initial-plan',
    agent_id: 'nerve-agent',
    team_role: 'planner',
    decision: 'task_completed',
    why: 'Planner initial planning task completed with mission plan and next tasks.',
    policy_used: 'mission_orchestration_control_plane_v1',
    evidence: ['PLAN.md', 'NEXT_TASKS.json'],
    payload: {
      completion: 'planning_artifacts_ready',
    },
  });
}

function validatePlanningPacket(packet: PlanningPacket, missionId: string): asserts packet is PlanningPacket {
  if (!packet || typeof packet !== 'object') {
    throw new Error(`Planner did not return a planning packet for ${missionId}`);
  }
  if (typeof packet.plan_markdown !== 'string' || !packet.plan_markdown.trim()) {
    throw new Error(`Planner returned an invalid plan_markdown for ${missionId}`);
  }
  if (!Array.isArray(packet.next_tasks) || packet.next_tasks.length === 0) {
    throw new Error(`Planner returned no next_tasks for ${missionId}`);
  }
}

export function persistPlanningPacket(missionId: string, packet: PlanningPacket): void {
  validatePlanningPacket(packet, missionId);
  const missionPath = missionDir(missionId, 'public');
  safeWriteFile(`${missionPath}/PLAN.md`, packet.plan_markdown.trimEnd() + '\n');
  const nextTasks = packet.next_tasks.map((task, index) => ({
    task_id: typeof task.task_id === 'string' && task.task_id.trim() ? task.task_id : `task-${index + 1}`,
    status: 'planned',
    assigned_to: {
      role: task.team_role,
    },
    description: task.description,
    deliverable: task.deliverable,
    target_path: task.target_path,
  }));
  safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify(nextTasks, null, 2));
}

function loadPlannedNextTasks(missionId: string): PlannedNextTask[] {
  return loadAllNextTasks(missionId).filter((task) => (task.status || 'planned') === 'planned');
}

function loadAllNextTasks(missionId: string): PlannedNextTask[] {
  const missionPath = missionDir(missionId, 'public');
  const nextTasksPath = `${missionPath}/NEXT_TASKS.json`;
  if (!safeExistsSync(nextTasksPath)) return [];
  const tasks = JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string) as PlannedNextTask[];
  return Array.isArray(tasks) ? tasks : [];
}

function writeNextTasks(missionId: string, tasks: PlannedNextTask[]): void {
  const missionPath = missionDir(missionId, 'public');
  safeWriteFile(`${missionPath}/NEXT_TASKS.json`, JSON.stringify(tasks, null, 2));
}

function readExistingTaskEventKeys(missionId: string): Set<string> {
  const taskEventsPath = `${missionDir(missionId, 'public')}/coordination/events/task-events.jsonl`;
  if (!safeExistsSync(taskEventsPath)) return new Set();
  const raw = safeReadFile(taskEventsPath, { encoding: 'utf8' }) as string;
  return new Set(
    raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const parsed = JSON.parse(line) as { event_type?: string; task_id?: string };
          return parsed.event_type && parsed.task_id ? `${parsed.event_type}:${parsed.task_id}` : null;
        } catch {
          return null;
        }
      })
      .filter((value): value is string => Boolean(value)),
  );
}

function reconcileTaskOutcomeEvents(missionId: string): void {
  const tasks = loadAllNextTasks(missionId).filter((task) => task.status && task.status !== 'planned' && task.status !== 'requested');
  const seen = readExistingTaskEventKeys(missionId);

  for (const task of tasks) {
    const eventType = task.status ? TASK_EVENT_STATUS_MAP[task.status] : undefined;
    const teamRole = task.assigned_to?.role;
    if (!eventType || !teamRole) continue;
    const dedupeKey = `${eventType}:${task.task_id}`;
    if (seen.has(dedupeKey)) continue;
    emitMissionTaskEvent({
      event_type: eventType,
      mission_id: missionId,
      task_id: task.task_id,
      agent_id: task.assigned_to?.agent_id,
      team_role: teamRole,
      decision: eventType,
      why: `Task ${task.task_id} transitioned to ${task.status}.`,
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: task.deliverable ? [String(task.deliverable)] : [],
      payload: {
        description: task.description,
        deliverable: task.deliverable,
        status: task.status,
      },
    });
    seen.add(dedupeKey);
  }
}

export function reconcileMissionProgress(missionId: string): void {
  const missionPath = missionDir(missionId, 'public');
  const taskBoardPath = `${missionPath}/TASK_BOARD.md`;
  if (!safeExistsSync(taskBoardPath)) return;

  const tasks = loadAllNextTasks(missionId);
  const acceptedCount = tasks.filter((task) => task.status === 'accepted').length;
  const reviewedCount = tasks.filter((task) => task.status === 'reviewed').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const requestedCount = tasks.filter((task) => task.status === 'requested').length;

  reconcileTaskOutcomeEvents(missionId);

  const currentTaskBoard = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
  let updatedTaskBoard = currentTaskBoard;

  if (acceptedCount > 0) {
    updatedTaskBoard = updatedTaskBoard
      .replace(/## Status: .+/u, '## Status: Review Accepted')
      .replace('- [~] Step 2: Implementation', '- [x] Step 2: Implementation')
      .replace('- [ ] Step 2: Implementation', '- [x] Step 2: Implementation')
      .replace('- [ ] Step 3: Validation', '- [x] Step 3: Validation');
  } else if (reviewedCount > 0 || completedCount > 0) {
    updatedTaskBoard = updatedTaskBoard
      .replace(/## Status: .+/u, '## Status: Validation Ready')
      .replace('- [~] Step 2: Implementation', '- [x] Step 2: Implementation')
      .replace('- [ ] Step 2: Implementation', '- [x] Step 2: Implementation')
      .replace('- [ ] Step 3: Validation', '- [~] Step 3: Validation');
  } else if (requestedCount > 0) {
    updatedTaskBoard = updatedTaskBoard
      .replace(/## Status: .+/u, '## Status: Execution Ready')
      .replace('- [ ] Step 2: Implementation', '- [~] Step 2: Implementation');
  }

  if (updatedTaskBoard !== currentTaskBoard) {
    safeWriteFile(taskBoardPath, updatedTaskBoard);
  }

  if (acceptedCount > 0 || reviewedCount > 0 || completedCount > 0) {
    ledger.record('MISSION_TASK_OUTCOMES_RECONCILED', {
      mission_id: missionId,
      accepted_count: acceptedCount,
      reviewed_count: reviewedCount,
      completed_count: completedCount,
      requested_count: requestedCount,
    });
  }
}

function markTaskBoardInProgress(missionId: string): void {
  const missionPath = missionDir(missionId, 'public');
  const taskBoardPath = `${missionPath}/TASK_BOARD.md`;
  if (!safeExistsSync(taskBoardPath)) return;
  const currentTaskBoard = safeReadFile(taskBoardPath, { encoding: 'utf8' }) as string;
  const updatedTaskBoard = currentTaskBoard
    .replace('## Status: Planning Ready', '## Status: Execution Ready')
    .replace('- [ ] Step 2: Implementation', '- [~] Step 2: Implementation');
  if (updatedTaskBoard !== currentTaskBoard) {
    safeWriteFile(taskBoardPath, updatedTaskBoard);
  }
}

export async function dispatchMissionNextTasks(missionId: string): Promise<Array<{ task_id: string; team_role: string; agent_id: string }>> {
  const nextTasksPath = `${missionDir(missionId, 'public')}/NEXT_TASKS.json`;
  if (!safeExistsSync(nextTasksPath)) return [];
  const allTasks = JSON.parse(safeReadFile(nextTasksPath, { encoding: 'utf8' }) as string) as PlannedNextTask[];
  const plannedTasks = Array.isArray(allTasks) ? allTasks.filter((task) => (task.status || 'planned') === 'planned') : [];
  if (plannedTasks.length === 0) return [];

  const uniqueRoles = Array.from(new Set(plannedTasks.map((task) => task.assigned_to?.role).filter((role): role is string => Boolean(role))));
  if (uniqueRoles.length > 0) {
    await ensureMissionTeamRuntimeViaSupervisor({
      missionId,
      teamRoles: uniqueRoles,
      requestedBy: 'mission_orchestration_worker',
      reason: 'Prewarm roles required by planner-produced NEXT_TASKS.',
      timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
    });
  }

  const dispatched: Array<{ task_id: string; team_role: string; agent_id: string }> = [];
  const plan = resolveMissionTeamPlan({ missionId });
  const teamView = buildMissionTeamView(plan);

  for (const task of plannedTasks) {
    const teamRole = task.assigned_to?.role;
    if (!teamRole) continue;
    const assignment = resolveMissionTeamReceiver({ missionId, teamRole });
    if (!assignment?.agent_id) continue;
    const preflight = validateDelegatedTaskPreflight({
      task: {
        task_id: task.task_id,
        team_role: teamRole,
        deliverable: task.deliverable,
        target_path: task.target_path,
      },
      assignment,
    });
    emitMissionOrchestrationObservation({
      decision: preflight.allowed ? 'delegation_preflight_passed' : 'delegation_preflight_blocked',
      event_type: 'delegation_preflight_checked',
      requested_by: 'mission_orchestration_worker',
      mission_id: missionId,
      resource_id: task.task_id,
      operation: preflight.allowed ? 'allow' : 'block',
      why: preflight.reason,
      evidence: preflight.target_path ? [preflight.target_path] : [],
      payload: {
        team_role: teamRole,
        target_path: preflight.target_path,
        target_scope_class: preflight.target_scope_class,
        warnings: preflight.warnings,
      },
    });
    if (!preflight.allowed) {
      task.status = 'blocked';
      continue;
    }

    await a2aBridge.route({
      a2a_version: '1.0',
      header: {
        msg_id: `REQ-${Date.now().toString(36).toUpperCase()}-${task.task_id}`,
        sender: 'kyberion:mission-orchestrator',
        receiver: assignment.agent_id,
        performative: 'request',
        timestamp: new Date().toISOString(),
      },
      payload: {
        intent: 'mission_task_execution',
        text: [
          `Execute task ${task.task_id} for mission ${missionId}.`,
          `Assigned team role: ${teamRole}.`,
          `Description: ${task.description || ''}`,
          `Deliverable: ${task.deliverable || ''}`,
          `Target path: ${task.target_path || preflight.target_path || '(unspecified)'}`,
          '',
          'Mission team context:',
          JSON.stringify({
            mission_id: missionId,
            team: teamView,
          }, null, 2),
        ].join('\n'),
        context: {
          mission_id: missionId,
          team_role: teamRole,
          task_id: task.task_id,
          execution_mode: 'task',
          deliverable: task.deliverable,
        },
      },
    });

    task.status = 'requested';
    emitMissionTaskEvent({
      event_type: 'task_issued',
      mission_id: missionId,
      task_id: task.task_id,
      agent_id: assignment.agent_id,
      team_role: teamRole,
      decision: 'task_issued',
      why: 'Planner-produced follow-up task was delegated to the assigned mission team role.',
      policy_used: 'mission_orchestration_control_plane_v1',
      evidence: task.deliverable ? [String(task.deliverable)] : [],
      payload: {
        description: task.description,
        deliverable: task.deliverable,
      },
    });
    dispatched.push({
      task_id: task.task_id,
      team_role: teamRole,
      agent_id: assignment.agent_id,
    });
  }

  writeNextTasks(missionId, allTasks);
  markTaskBoardInProgress(missionId);
  reconcileMissionProgress(missionId);
  ledger.record('MISSION_FOLLOWUP_DISPATCHED', {
    mission_id: missionId,
    dispatched_task_count: dispatched.length,
    task_ids: dispatched.map((task) => task.task_id),
  });
  return dispatched;
}

function emitSlackMissionEvent(
  payload: SlackPayload,
  missionId: string,
  decision: string,
  why: string,
  extra: Record<string, unknown> = {},
): void {
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
    correlation_id: missionId,
    decision,
    why,
    policy_used: 'mission_orchestration_control_plane_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    slack_channel: payload.channel,
    thread_ts: payload.threadTs,
    ...extra,
  });
}

function summarizeMissionTaskOutcomes(missionId: string): {
  acceptedCount: number;
  reviewedCount: number;
  completedCount: number;
  requestedCount: number;
} {
  const tasks = loadAllNextTasks(missionId);
  return {
    acceptedCount: tasks.filter((task) => task.status === 'accepted').length,
    reviewedCount: tasks.filter((task) => task.status === 'reviewed').length,
    completedCount: tasks.filter((task) => task.status === 'completed').length,
    requestedCount: tasks.filter((task) => task.status === 'requested').length,
  };
}

async function handleMissionIssueRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const tier = payload.tier || 'public';
  const persona = payload.persona || 'Ecosystem Architect';
  const missionType = resolveMissionType(payload);

  runMissionController(env, ['start', missionId, tier, persona, 'default', missionType]);
  emitSlackMissionEvent(payload, missionId, 'mission_issued', 'Mission was issued from an orchestration event.', {
    mission_type: missionType,
    tier,
  });

  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_team_prewarm_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload: {
      ...payload,
      teamRoles: payload.teamRoles?.length ? payload.teamRoles : ['planner'],
    },
  });
  startMissionOrchestrationWorker(nextEvent);
}

async function handleMissionTeamPrewarmRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;

  emitSlackMissionEvent(payload, missionId, 'mission_orchestration_started', 'Background mission orchestration started.');

  const runtimePlan = await ensureMissionTeamRuntimeViaSupervisor({
    missionId,
    teamRoles: payload.teamRoles?.length ? payload.teamRoles : ['planner'],
    requestedBy: 'mission_orchestration_worker',
    reason: 'Prewarm agent runtime before kickoff.',
    timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
  });

  emitSlackMissionEvent(payload, missionId, 'mission_team_staffed', 'Required team runtimes were prewarmed.', {
    assignments: runtimePlan.runtime_plan.assignments.map((assignment) => ({
      team_role: assignment.team_role,
      agent_id: assignment.agent_id,
      runtime_status: assignment.runtime_status,
    })),
  });

  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_kickoff_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
}

async function handleMissionKickoffRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  await emitWorkerKickoffSnapshot(missionId, payload);
  const env = buildExecutionEnv(process.env, 'mission_controller');

  runMissionController(env, [
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
  const kickoff = await a2aBridge.route({
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}`,
      sender: 'kyberion:mission-orchestrator',
      receiver: plannerAssignment.agent_id,
      performative: 'request',
      timestamp: new Date().toISOString(),
    },
    payload: {
      intent: 'mission_kickoff_planning',
      text: [
        `Kick off planning for mission ${missionId}.`,
        `Mission type: ${plan.mission_type}.`,
        `Original source request: ${payload.sourceText || ''}`,
        'Create the initial plan, define deliverables, and prepare the next delegated tasks.',
        '',
        'Mission team context:',
        JSON.stringify({
          mission_id: plan.mission_id,
          mission_type: plan.mission_type,
          team: teamView,
        }, null, 2),
      ].join('\n'),
      context: {
        channel: 'slack',
        slack_channel: payload.channel,
        thread: payload.threadTs,
        execution_mode: 'task',
        mission_id: missionId,
        team_role: 'planner',
      },
    },
  });

  const kickoffText = String(kickoff.payload?.text || '');
  logger.info(`[MISSION_ORCHESTRATION] Planner kickoff complete for ${missionId}: ${kickoffText.slice(0, 240)}`);
  const kickoffBlocks = extractSurfaceBlocks(kickoffText);
  const planningPacket = kickoffBlocks.planningPackets?.[0];
  if (!planningPacket) {
    throw new Error(`Planner response for ${missionId} did not include a planning_packet block`);
  }
  persistPlanningPacket(missionId, planningPacket);
  syncPlanningArtifacts(missionId);
  reconcileMissionProgress(missionId);
  emitSlackMissionEvent(payload, missionId, 'mission_kickoff_completed', 'Planner kickoff request was delivered.', {
    planner_agent_id: plannerAssignment.agent_id,
    planned_task_count: planningPacket.next_tasks.length,
  });
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_followup_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionFollowupRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  emitWorkerTransitionSnapshot(missionId, 'execution', `Mission ${missionId} follow-up dispatched`);
  emitSlackMissionEvent(payload, missionId, 'mission_followup_requested', 'Planner artifacts were reconciled and follow-up delegation started.');
  const dispatched = await dispatchMissionNextTasks(missionId);
  emitSlackMissionEvent(payload, missionId, 'mission_followup_dispatched', 'Planner-produced follow-up tasks were delegated.', {
    dispatched_tasks: dispatched,
  });
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_reconciliation_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionReconciliationRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  emitWorkerTransitionSnapshot(missionId, 'verification', `Mission ${missionId} reconciling outcomes`);
  reconcileMissionProgress(missionId);
  emitSlackMissionEvent(payload, missionId, 'mission_reconciliation_completed', 'Mission task outcomes were reconciled into mission state.');
  const summary = summarizeMissionTaskOutcomes(missionId);
  emitSlackMissionEvent(
    payload,
    missionId,
    'mission_owner_notified',
    'Owner summary emitted after reconciliation.',
    {
      accepted_count: summary.acceptedCount,
      reviewed_count: summary.reviewedCount,
      completed_count: summary.completedCount,
      requested_count: summary.requestedCount,
    },
  );
  enqueueSlackOutboxMessage({
    correlationId: missionId,
    channel: payload.channel,
    threadTs: payload.threadTs,
    source: 'system',
    text: [
      `Mission ${missionId} progress update.`,
      `Accepted: ${summary.acceptedCount}`,
      `Reviewed: ${summary.reviewedCount}`,
      `Completed: ${summary.completedCount}`,
      `Requested: ${summary.requestedCount}`,
    ].join('\n'),
  });
  enqueueChronosOutboxMessage({
    correlationId: missionId,
    threadTs: missionId,
    source: 'system',
    text: [
      `Mission ${missionId} progress update.`,
      `Accepted: ${summary.acceptedCount}`,
      `Reviewed: ${summary.reviewedCount}`,
      `Completed: ${summary.completedCount}`,
      `Requested: ${summary.requestedCount}`,
    ].join('\n'),
  });
  // Continue lifecycle: enqueue distillation
  const nextEvent = enqueueMissionOrchestrationEvent({
    eventType: 'mission_distillation_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionDistillationRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  emitWorkerTransitionSnapshot(missionId, 'retrospective', `Mission ${missionId} distilling knowledge`);

  // Capture a heuristic validation snapshot alongside CLI distillation so
  // the retrospective phase closes the intent-loop "learn" stage even if
  // no heuristics have been validated yet.
  try {
    const report = summarizeHeuristics(10);
    const evidenceDir = missionEvidenceDir(missionId);
    if (evidenceDir) {
      safeWriteFile(
        nodePath.join(evidenceDir, 'heuristic-feedback-report.json'),
        `${JSON.stringify(report, null, 2)}\n`,
        { mkdir: true },
      );
    }
  } catch (err: any) {
    logger.warn(`[worker] heuristic summary skipped for ${missionId}: ${err?.message ?? err}`);
  }

  // Run distillation via mission controller CLI
  const env = buildExecutionEnv(process.env, 'mission_controller');
  try {
    runMissionController(env, ['distill', missionId]);
    emitSlackMissionEvent(payload, missionId, 'mission_distillation_completed', 'Mission knowledge was distilled into reusable learnings.');
  } catch (error: any) {
    emitSlackMissionEvent(payload, missionId, 'mission_distillation_failed', `Distillation failed: ${error.message}. Manual review recommended.`);
  }

  // Continue to completion
  const nextEvent2 = enqueueMissionOrchestrationEvent({
    eventType: 'mission_completion_requested',
    missionId,
    requestedBy: 'mission_orchestration_worker',
    correlationId: event.correlation_id || event.event_id,
    causationId: event.event_id,
    payload,
  });
  startMissionOrchestrationWorker(nextEvent2);
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionCompletionRequested(event: MissionOrchestrationEvent<SlackPayload>) {
  const payload = event.payload;
  const missionId = event.mission_id;
  emitWorkerTransitionSnapshot(missionId, 'delivery', `Mission ${missionId} completing lifecycle`);

  const env = buildExecutionEnv(process.env, 'mission_controller');
  try {
    runMissionController(env, ['finish', missionId]);
    emitSlackMissionEvent(payload, missionId, 'mission_completed', 'Mission lifecycle completed. Artifacts and learnings are archived.');
  } catch (error: any) {
    emitSlackMissionEvent(payload, missionId, 'mission_completion_failed', `Completion failed: ${error.message}. Manual intervention required.`);
  }

  enqueueSlackOutboxMessage({
    correlationId: missionId,
    channel: payload.channel,
    threadTs: payload.threadTs,
    source: 'system',
    text: `Mission ${missionId} lifecycle completed.`,
  });
  enqueueChronosOutboxMessage({
    correlationId: missionId,
    threadTs: missionId,
    source: 'system',
    text: `Mission ${missionId} lifecycle completed.`,
  });
  await shutdownAllAgentRuntimes('mission_orchestration_worker');
}

async function handleMissionControlRequested(event: MissionOrchestrationEvent<MissionControlPayload>) {
  const env = buildExecutionEnv(process.env, 'mission_controller');
  const missionId = event.mission_id;
  const operation = event.payload.operation;

  switch (operation) {
    case 'resume':
      runMissionController(env, ['start', missionId]);
      break;
    case 'refresh_team':
      runMissionController(env, ['team', missionId, '--refresh']);
      break;
    case 'prewarm_team':
      runMissionController(env, ['prewarm', missionId]);
      break;
    case 'staff_team':
      runMissionController(env, ['staff', missionId]);
      break;
    case 'finish':
      runMissionController(env, ['finish', missionId]);
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

async function handleSurfaceControlRequested(event: MissionOrchestrationEvent<SurfaceControlPayload>) {
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

  safeExec('node', args, { cwd: pathResolver.rootDir(), env, timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS });
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

export async function processMissionOrchestrationEventPath(eventPath: string): Promise<void> {
  const event = loadMissionOrchestrationEvent<SlackPayload>(eventPath);
  emitMissionOrchestrationObservation({
    decision: 'mission_orchestration_event_started',
    event_id: event.event_id,
    event_type: event.event_type,
    mission_id: event.mission_id,
  });

  try {
    switch (event.event_type) {
      case 'mission_issue_requested':
        await handleMissionIssueRequested(event);
        break;
      case 'mission_team_prewarm_requested':
        await handleMissionTeamPrewarmRequested(event);
        break;
      case 'mission_kickoff_requested':
        await handleMissionKickoffRequested(event);
        break;
      case 'mission_followup_requested':
        await handleMissionFollowupRequested(event);
        break;
      case 'mission_reconciliation_requested':
        await handleMissionReconciliationRequested(event);
        break;
      case 'mission_distillation_requested':
        await handleMissionDistillationRequested(event);
        break;
      case 'mission_completion_requested':
        await handleMissionCompletionRequested(event);
        break;
      case 'mission_control_requested':
        await handleMissionControlRequested(event as unknown as MissionOrchestrationEvent<MissionControlPayload>);
        break;
      case 'surface_control_requested':
        await handleSurfaceControlRequested(event as unknown as MissionOrchestrationEvent<SurfaceControlPayload>);
        break;
      default:
        throw new Error(`Unsupported orchestration event type: ${event.event_type}`);
    }
    emitMissionOrchestrationObservation({
      decision: 'mission_orchestration_event_completed',
      event_id: event.event_id,
      event_type: event.event_type,
      mission_id: event.mission_id,
    });
  } catch (error) {
    emitMissionOrchestrationObservation({
      decision: 'mission_orchestration_event_failed',
      event_id: event.event_id,
      event_type: event.event_type,
      mission_id: event.mission_id,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
