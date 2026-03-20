import { logger, processMissionOrchestrationEventPath } from '@agent/core';

function parseEventPath(argv: string[]): string {
  const index = argv.findIndex((arg) => arg === '--event');
  if (index === -1 || !argv[index + 1]) {
    throw new Error('Usage: run_mission_orchestration_event_worker --event <EVENT_PATH>');
  }
  return argv[index + 1];
}

async function main() {
  const eventPath = parseEventPath(process.argv.slice(2));
  await processMissionOrchestrationEventPath(eventPath);
  logger.info(`[MISSION_ORCHESTRATION_WORKER] Completed event: ${eventPath}`);
}

main().catch((error) => {
  logger.error(`[MISSION_ORCHESTRATION_WORKER] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
