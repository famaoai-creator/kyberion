import {
  enqueueMissionOrchestrationEvent,
  logger,
  startMissionOrchestrationWorker,
} from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

interface LegacySlackKickoffInput {
  missionId: string;
  channel: string;
  threadTs: string;
  sourceText?: string;
  proposal?: Record<string, unknown>;
}

function printUsage(): void {
  logger.info('Usage: run_slack_mission_kickoff <job-path>');
}

async function main(argv: string[]) {
  const jobPath = argv[0];
  if (!jobPath || jobPath === '--help' || jobPath === '-h') {
    printUsage();
    throw new ScriptExitError(jobPath ? 0 : 2);
  }

  const input = readJsonFile<LegacySlackKickoffInput>(jobPath);
  const event = enqueueMissionOrchestrationEvent({
    eventType: 'mission_team_prewarm_requested',
    missionId: input.missionId,
    requestedBy: 'slack_kickoff_compat',
    payload: {
      channel: input.channel,
      threadTs: input.threadTs,
      sourceText: input.sourceText,
      proposal: input.proposal,
      teamRoles: ['planner'],
    },
  });
  startMissionOrchestrationWorker(event);
  logger.info(`[SLACK_KICKOFF_COMPAT] Enqueued ${event.event_id} for ${input.missionId}`);
}

export const runSlackMissionKickoff = defineScript({
  name: 'slack:mission-kickoff',
  flags: [],
  run(context) {
    return main(context.argv);
  },
});

if (
  isDirectScript(import.meta.url, 'run_slack_mission_kickoff.ts') ||
  isDirectScript(import.meta.url, 'run_slack_mission_kickoff.js')
)
  void runSlackMissionKickoff();
