import { logger } from '@agent/core/core';
import { processMissionTeamPrewarmRequest } from '@agent/core/agent-runtime-supervisor';
import { killSwitch } from '@agent/core/kill-switch';
import { defineScript, isDirectScript } from './lib/harness.js';

function parseRequestPath(argv: string[]): string {
  const index = argv.findIndex((arg) => arg === '--request');
  if (index === -1 || !argv[index + 1]) {
    throw new Error('Usage: run_agent_runtime_supervisor --request <REQUEST_PATH>');
  }
  return argv[index + 1];
}

async function main(argv: string[]) {
  killSwitch.startMonitor();
  const requestPath = parseRequestPath(argv);
  const result = await processMissionTeamPrewarmRequest(requestPath);
  logger.info(`[AGENT_RUNTIME_SUPERVISOR] Completed ${result.request_id} for ${result.mission_id}`);
}

export const runAgentRuntimeSupervisor = defineScript({
  name: 'agent-runtime-supervisor',
  flags: [],
  run(context) {
    return main(context.argv);
  },
});

if (
  isDirectScript(import.meta.url, 'run_agent_runtime_supervisor.ts') ||
  isDirectScript(import.meta.url, 'run_agent_runtime_supervisor.js')
)
  void runAgentRuntimeSupervisor();
