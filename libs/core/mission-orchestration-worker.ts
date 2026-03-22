import { a2aBridge } from './a2a-bridge.js';
import { buildMissionTeamView, resolveMissionTeamPlan, resolveMissionTeamReceiver } from './mission-team-composer.js';
import { emitChannelSurfaceEvent, enqueueChronosOutboxMessage, enqueueSlackOutboxMessage } from './channel-surface.js';
import { ensureMissionTeamRuntimeViaSupervisor, shutdownAllAgentRuntimes } from './agent-runtime-supervisor.js';
import { ledger } from './ledger.js';
import { logger } from './core.js';
import { buildExecutionEnv } from './authority.js';
import { missionDir } from './path-resolver.js';
import { safeExec, safeExistsSync, safeReadFile, safeWriteFile } from './secure-io.js';
import { emitMissionTaskEvent } from './mission-task-events.js';
import {
  enqueueMissionOrchestrationEvent,
  emitMissionOrchestrationObservation,
  loadMissionOrchestrationEvent,
  startMissionOrchestrationWorker,
  type MissionOrchestrationEvent,
} from './mission-orchestration-events.js';

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

  logger.info(`[MISSION_ORCHESTRATION] Planner kickoff complete for ${missionId}: ${String(kickoff.payload?.text || '').slice(0, 240)}`);
  syncPlanningArtifacts(missionId);
  reconcileMissionProgress(missionId);
  emitSlackMissionEvent(payload, missionId, 'mission_kickoff_completed', 'Planner kickoff request was delivered.', {
    planner_agent_id: plannerAssignment.agent_id,
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

  safeExec('node', args, { cwd: process.cwd(), env, timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS });
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
