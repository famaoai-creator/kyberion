import { logger, processMissionTeamPrewarmRequest } from '../libs/core/index.js';

function parseRequestPath(argv: string[]): string {
  const index = argv.findIndex((arg) => arg === '--request');
  if (index === -1 || !argv[index + 1]) {
    throw new Error('Usage: run_agent_runtime_supervisor --request <REQUEST_PATH>');
  }
  return argv[index + 1];
}

async function main() {
  const requestPath = parseRequestPath(process.argv.slice(2));
  const result = await processMissionTeamPrewarmRequest(requestPath);
  logger.info(`[AGENT_RUNTIME_SUPERVISOR] Completed ${result.request_id} for ${result.mission_id}`);
}

main().catch((error) => {
  logger.error(`[AGENT_RUNTIME_SUPERVISOR] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
