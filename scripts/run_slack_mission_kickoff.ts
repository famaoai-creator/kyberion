import {
  a2aBridge,
  agentLifecycle,
  buildMissionTeamView,
  ensureMissionTeamRuntimeViaSupervisor,
  emitChannelSurfaceEvent,
  ledger,
  logger,
  missionDir,
  resolveMissionTeamPlan,
  resolveMissionTeamReceiver,
  safeExistsSync,
  safeExec,
  safeReadFile,
  safeWriteFile,
} from '../libs/core/index.js';

interface SlackKickoffInput {
  missionId: string;
  channel: string;
  threadTs: string;
  sourceText?: string;
  proposal?: Record<string, unknown>;
}

const MISSION_CONTROLLER_TIMEOUT_MS = 600_000;

function runMissionController(env: NodeJS.ProcessEnv, args: string[]) {
  return safeExec(
    'node',
    ['dist/scripts/mission_controller.js', ...args],
    {
      env,
      timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
    },
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
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) {
    throw new Error('Missing orchestration job path argument');
  }

  const input = JSON.parse(safeReadFile(jobPath, { encoding: 'utf8' }) as string) as SlackKickoffInput;
  const missionId = input.missionId.toUpperCase();
  process.env.MISSION_ROLE ||= 'mission_controller';
  const env = { ...process.env, MISSION_ROLE: 'mission_controller' };

  emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
    correlation_id: missionId,
    decision: 'mission_orchestration_started',
    why: 'Slack mission orchestration worker started background team preparation.',
    policy_used: 'slack_mission_orchestration_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    slack_channel: input.channel,
    thread_ts: input.threadTs,
  });

  const plan = resolveMissionTeamPlan({ missionId });
  const runtimePlan = await ensureMissionTeamRuntimeViaSupervisor({
    missionId,
    teamRoles: ['planner'],
    requestedBy: 'slack_mission_kickoff',
    reason: 'Prewarm planner runtime before Slack mission kickoff routing.',
    timeoutMs: MISSION_CONTROLLER_TIMEOUT_MS,
  });
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
    correlation_id: missionId,
    decision: 'mission_team_staffed',
    why: 'Mission team runtime was ensured in-process by the orchestration worker.',
    policy_used: 'slack_mission_orchestration_v1',
    agent_id: 'mission_controller',
    resource_id: missionId,
    slack_channel: input.channel,
    thread_ts: input.threadTs,
    assignments: runtimePlan.runtime_plan.assignments.map((assignment) => ({
      team_role: assignment.team_role,
      agent_id: assignment.agent_id,
      runtime_status: assignment.runtime_status,
    })),
  });

  runMissionController(env, [
    'record-task',
    missionId,
    'Initial planning kickoff from Slack mission issuance',
    JSON.stringify({
      source: 'slack',
      channel: input.channel,
      threadTs: input.threadTs,
      sourceText: input.sourceText,
      proposal: input.proposal,
    }),
  ]);

  const plannerAssignment = resolveMissionTeamReceiver({ missionId, teamRole: 'planner' });
  if (!plan || !plannerAssignment?.agent_id) {
    logger.warn(`[SLACK_KICKOFF] Planner assignment not found for ${missionId}.`);
    emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
      correlation_id: missionId,
      decision: 'mission_orchestration_failed',
      why: 'Planner assignment was not available after mission staffing.',
      policy_used: 'slack_mission_orchestration_v1',
      agent_id: 'mission_controller',
      resource_id: missionId,
      slack_channel: input.channel,
      thread_ts: input.threadTs,
    });
    return;
  }

  const teamView = buildMissionTeamView(plan);
  const kickoff = await a2aBridge.route({
    a2a_version: '1.0',
    header: {
      msg_id: `REQ-${Date.now().toString(36).toUpperCase()}`,
      sender: 'kyberion:slack-bridge',
      receiver: plannerAssignment.agent_id,
      performative: 'request',
      timestamp: new Date().toISOString(),
    },
    payload: {
      intent: 'mission_kickoff_planning',
      text: [
        `Kick off planning for mission ${missionId}.`,
        `Mission type: ${plan.mission_type}.`,
        `Original Slack request: ${input.sourceText || ''}`,
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
        slack_channel: input.channel,
        thread: input.threadTs,
        execution_mode: 'task',
        mission_id: missionId,
        team_role: 'planner',
      },
    },
  });

  logger.info(`[SLACK_KICKOFF] Planner kickoff complete for ${missionId}: ${String(kickoff.payload?.text || '').slice(0, 240)}`);
  syncPlanningArtifacts(missionId);
  emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
    correlation_id: missionId,
    decision: 'mission_kickoff_completed',
    why: 'Planner kickoff request was delivered after background team preparation.',
    policy_used: 'slack_mission_orchestration_v1',
    agent_id: plannerAssignment.agent_id,
    resource_id: missionId,
    slack_channel: input.channel,
    thread_ts: input.threadTs,
  });

  await agentLifecycle.shutdownAll();
}

main().catch((error) => {
  logger.error(`[SLACK_KICKOFF] ${error instanceof Error ? error.message : String(error)}`);
  try {
    const jobPath = process.argv[2];
    if (jobPath) {
      const input = JSON.parse(safeReadFile(jobPath, { encoding: 'utf8' }) as string) as SlackKickoffInput;
      emitChannelSurfaceEvent('slack_bridge', 'slack', 'missions', {
        correlation_id: input.missionId,
        decision: 'mission_orchestration_failed',
        why: error instanceof Error ? error.message : String(error),
        policy_used: 'slack_mission_orchestration_v1',
        agent_id: 'mission_controller',
        resource_id: input.missionId,
        slack_channel: input.channel,
        thread_ts: input.threadTs,
      });
    }
  } catch {
    // Best-effort observability only.
  }
  process.exit(1);
});
