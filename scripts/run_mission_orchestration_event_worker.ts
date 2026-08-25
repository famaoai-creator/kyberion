import { logger, processMissionOrchestrationEventPath } from '@agent/core';
import { defineScript, isDirectScript } from './lib/harness.js';

function parseEventPath(argv: string[]): string {
  const index = argv.findIndex((arg) => arg === '--event');
  if (index === -1 || !argv[index + 1]) {
    throw new Error('Usage: run_mission_orchestration_event_worker --event <EVENT_PATH>');
  }
  return argv[index + 1];
}

async function main(argv: string[]) {
  const eventPath = parseEventPath(argv);
  await processMissionOrchestrationEventPath(eventPath);
  logger.info(`[MISSION_ORCHESTRATION_WORKER] Completed event: ${eventPath}`);
}

export const runMissionOrchestrationEventWorker = defineScript({
  name: 'mission-orchestration-event-worker',
  flags: [],
  run(context) {
    return main(context.argv);
  },
});

if (
  isDirectScript(import.meta.url, 'run_mission_orchestration_event_worker.ts') ||
  isDirectScript(import.meta.url, 'run_mission_orchestration_event_worker.js')
)
  void runMissionOrchestrationEventWorker();
