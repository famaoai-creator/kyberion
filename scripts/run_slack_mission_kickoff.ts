import {
  enqueueMissionOrchestrationEvent,
  logger,
  startMissionOrchestrationWorker,
} from '@agent/core';
import { readJsonFile } from './refactor/cli-input.js';

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

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath || jobPath === '--help' || jobPath === '-h') {
    printUsage();
    process.exit(jobPath ? 0 : 2);
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

main().catch((error) => {
  logger.error(`[SLACK_KICKOFF_COMPAT] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
