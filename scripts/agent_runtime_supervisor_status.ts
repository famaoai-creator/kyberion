import { createStandardYargs } from '@agent/core';
import {
  getAgentRuntimeStatusViaDaemon,
  getAgentRuntimeSupervisorHealth,
  listAgentRuntimesViaDaemon,
} from '@agent/core';

async function main() {
  const argv = await createStandardYargs()
    .option('agent-id', {
      type: 'string',
      description: 'Inspect a single agent runtime instead of listing all runtimes',
    })
    .help()
    .parseAsync();

  const health = await getAgentRuntimeSupervisorHealth();
  if (argv.agentId) {
    const status = await getAgentRuntimeStatusViaDaemon(String(argv.agentId));
    console.log(JSON.stringify({ health, status }, null, 2));
    return;
  }

  const runtimes = await listAgentRuntimesViaDaemon();
  console.log(JSON.stringify({ health, runtimes }, null, 2));
}

main().catch((error: any) => {
  console.error(error?.message || String(error));
  process.exit(1);
});
