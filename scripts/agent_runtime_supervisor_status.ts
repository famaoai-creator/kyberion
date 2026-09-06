import { createStandardYargs } from '@agent/core/cli-utils';
import {
  ensureAgentRuntimeSupervisorDaemon,
  getAgentRuntimeStatusViaDaemon,
  getAgentRuntimeSupervisorHealth,
  listAgentRuntimesViaDaemon,
} from '@agent/core/agent-runtime-supervisor-client';
import { defineScript, isDirectScript } from './lib/harness.js';

async function main(args: string[] = []) {
  const argv = await createStandardYargs(['node', 'agent_runtime_supervisor_status', ...args])
    .option('agent-id', {
      type: 'string',
      description: 'Inspect a single agent runtime instead of listing all runtimes',
    })
    .help()
    .parseAsync();

  try {
    await ensureAgentRuntimeSupervisorDaemon();
  } catch (_) {
    // fallback: getAgentRuntimeSupervisorHealth below retries through the same path
  }
  const health = await getAgentRuntimeSupervisorHealth();
  if (argv.agentId) {
    const status = await getAgentRuntimeStatusViaDaemon(String(argv.agentId));
    return { health, status };
  }

  const runtimes = await listAgentRuntimesViaDaemon();
  return { health, runtimes };
}

function degradedStatus(error: unknown) {
  return {
    health: {
      ok: false,
      degraded: true,
      reason: error instanceof Error ? error.message : String(error),
    },
    runtimes: [],
  };
}

export const runAgentRuntimeSupervisorStatus = defineScript({
  name: 'agent-runtime:status',
  flags: [],
  run: async ({ argv, print }) => {
    try {
      const result = await main(argv);
      print(result);
      return result;
    } catch (error) {
      // The status command is a readiness probe: an unavailable daemon is a
      // degraded, successful response so callers can still inspect the JSON.
      const result = degradedStatus(error);
      print(result);
      return result;
    }
  },
});

if (
  isDirectScript(import.meta.url, 'agent_runtime_supervisor_status.ts') ||
  isDirectScript(import.meta.url, 'agent_runtime_supervisor_status.js')
)
  void runAgentRuntimeSupervisorStatus();
