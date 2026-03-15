import {
  a2aBridge,
  buildMissionTeamView,
  emitChannelSurfaceEvent,
  loadMissionTeamPlan,
  logger,
  resolveMissionTeamReceiver,
  safeExec,
  safeReadFile,
} from '../libs/core/index.js';

interface SlackKickoffInput {
  missionId: string;
  channel: string;
  threadTs: string;
  sourceText?: string;
  proposal?: Record<string, unknown>;
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

  safeExec(
    'node',
    ['dist/scripts/mission_controller.js', 'team', missionId, '--refresh'],
    { env },
  );
  safeExec(
    'node',
    ['dist/scripts/mission_controller.js', 'staff', missionId],
    { env },
  );

  safeExec(
    'node',
    [
      'dist/scripts/mission_controller.js',
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
    ],
    {
      env,
    },
  );

  const plan = loadMissionTeamPlan(missionId);
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
