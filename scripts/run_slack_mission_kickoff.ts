import {
  enqueueMissionOrchestrationEvent,
  startMissionOrchestrationWorker,
} from '@agent/core/mission-orchestration-events';
import { logger } from '@agent/core/core';
import { defineCatalog } from '@agent/core/foundation/governed-catalog';
import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeLstat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

interface LegacySlackKickoffInput {
  missionId: string;
  channel: string;
  threadTs: string;
  sourceText?: string;
  proposal?: Record<string, unknown>;
}

const SLACK_MISSION_KICKOFF_INPUT_SCHEMA = pathResolver.knowledge(
  'product/schemas/slack-mission-kickoff-input.schema.json'
);

function printUsage(): void {
  logger.info('Usage: run_slack_mission_kickoff <job-path>');
}

export function resolveSlackMissionKickoffInputPath(inputPath: string): string {
  const resolved = assertSafeRepositoryPath(inputPath);
  if (!safeLstat(resolved).isFile()) {
    throw new Error(`Slack kickoff input must be a regular file: ${inputPath}`);
  }
  return resolved;
}

export function loadSlackMissionKickoffInputAtPath(inputPath: string): LegacySlackKickoffInput {
  const resolved = resolveSlackMissionKickoffInputPath(inputPath);
  return defineCatalog<LegacySlackKickoffInput>({
    id: 'slack-mission-kickoff-input',
    path: resolved,
    schema: SLACK_MISSION_KICKOFF_INPUT_SCHEMA,
  }).load();
}

async function main(argv: string[]) {
  const jobPath = argv[0];
  if (!jobPath || jobPath === '--help' || jobPath === '-h') {
    printUsage();
    throw new ScriptExitError(jobPath ? 0 : 2);
  }

  const input = loadSlackMissionKickoffInputAtPath(jobPath);
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
