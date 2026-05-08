import * as path from 'node:path';
import {
  createStandardYargs,
  agentLifecycle,
  agentRegistry,
  loadAgentManifests,
  getAgentManifest,
  logger,
  pathResolver,
  auditChain,
} from '@agent/core';

type AgentAction = 'ps' | 'spawn' | 'shutdown' | 'list-manifests' | 'inspect';

const main = async () => {
  const argv = await createStandardYargs()
    .option('action', {
      type: 'string',
      choices: ['ps', 'spawn', 'shutdown', 'list-manifests', 'inspect'] as const,
      required: true,
      description: 'Action to perform on agent runtimes',
    })
    .option('agent-id', {
      type: 'string',
      description: 'Agent ID (for shutdown/inspect) or Manifest ID (for spawn)',
    })
    .option('provider', {
      type: 'string',
      description: 'Override provider for spawn',
    })
    .option('model', {
      type: 'string',
      description: 'Override model for spawn',
    })
    .option('mission-id', {
      type: 'string',
      description: 'Associate with a mission ID',
    })
    .parseSync();

  const action = argv.action as AgentAction;

  switch (action) {
    case 'ps':
      await listRunningAgents();
      break;
    case 'spawn':
      if (!argv['agent-id']) throw new Error('--agent-id (manifest ID) is required for spawn');
      await spawnAgent(argv['agent-id'] as string, {
        provider: argv.provider as any,
        modelId: argv.model as string,
        missionId: argv['mission-id'] as string,
      });
      break;
    case 'shutdown':
      if (!argv['agent-id']) throw new Error('--agent-id is required for shutdown');
      await shutdownAgent(argv['agent-id'] as string);
      break;
    case 'list-manifests':
      await listManifests();
      break;
    case 'inspect':
      if (!argv['agent-id']) throw new Error('--agent-id is required for inspect');
      await inspectAgent(argv['agent-id'] as string);
      break;
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
};

async function listRunningAgents() {
  const agents = agentRegistry.list();
  if (agents.length === 0) {
    console.log('\nNo agents currently running.\n');
    return;
  }

  console.log('');
  const header = `${'AGENT_ID'.padEnd(30)} ${'STATUS'.padEnd(12)} ${'PROVIDER'.padEnd(12)} ${'MODEL'.padEnd(25)} MISSION_ID`;
  console.log(header);
  console.log('-'.repeat(header.length + 10));

  for (const agent of agents) {
    const statusIcon = {
      ready: '🟢',
      busy: '🟡',
      booting: '⚪',
      error: '🔴',
      shutdown: '📁',
    }[agent.status] || '  ';

    console.log(
      `${agent.agentId.padEnd(30)} ${statusIcon} ${agent.status.padEnd(10)} ${agent.provider.padEnd(12)} ${agent.modelId.padEnd(25)} ${agent.missionId || '-'}`
    );
  }
  console.log('');
}

async function listManifests() {
  const manifests = loadAgentManifests();
  if (manifests.length === 0) {
    console.log('\nNo agent manifests found in knowledge/agents/.\n');
    return;
  }

  console.log('');
  const header = `${'MANIFEST_ID'.padEnd(30)} ${'AUTO'.padEnd(6)} ${'TRUST'.padEnd(6)} DESCRIPTION`;
  console.log(header);
  console.log('-'.repeat(header.length + 20));

  for (const m of manifests) {
    const autoIcon = m.autoSpawn ? '✅' : '  ';
    const description = m.systemPrompt.split('\n')[0].slice(0, 50) + (m.systemPrompt.length > 50 ? '...' : '');
    console.log(
      `${m.agentId.padEnd(30)} ${autoIcon} ${String(m.trustRequired).padEnd(6)} ${description}`
    );
  }
  console.log('');
}

async function spawnAgent(manifestId: string, overrides: { provider?: any, modelId?: string, missionId?: string }) {
  const manifest = getAgentManifest(manifestId);
  if (!manifest) throw new Error(`Agent manifest "${manifestId}" not found.`);

  logger.info(`Spawning agent from manifest: ${manifestId}...`);
  
  const handle = await agentLifecycle.spawn({
    agentId: `${manifestId}-${Math.random().toString(36).slice(2, 10)}`,
    provider: overrides.provider || manifest.selection_hints?.preferred_provider || 'gemini',
    modelId: overrides.modelId || manifest.selection_hints?.preferred_modelId,
    systemPrompt: manifest.systemPrompt,
    capabilities: manifest.capabilities,
    missionId: overrides.missionId,
  });

  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'operator',
    action: 'agent.manual_spawn',
    operation: handle.agentId,
    result: 'completed',
    metadata: { manifestId, overrides }
  });

  logger.success(`✅ Agent spawned: ${handle.agentId}`);
  console.log(JSON.stringify(handle.getRecord(), null, 2));
}

async function shutdownAgent(agentId: string) {
  const agent = agentRegistry.get(agentId);
  if (!agent) throw new Error(`Agent "${agentId}" not found.`);

  await agentLifecycle.shutdown(agentId);
  
  auditChain.record({
    agentId: process.env.KYBERION_PERSONA || 'operator',
    action: 'agent.manual_shutdown',
    operation: agentId,
    result: 'completed',
  });

  logger.success(`✅ Agent "${agentId}" shut down.`);
}

async function inspectAgent(agentId: string) {
  const snapshot = agentLifecycle.getSnapshot(agentId);
  if (!snapshot) {
    // Try to find in registry even if lifecycle handle is gone
    const record = agentRegistry.get(agentId);
    if (!record) throw new Error(`Agent "${agentId}" not found.`);
    console.log(JSON.stringify({ record, note: 'Agent is registered but not actively managed by lifecycle (likely shutdown or error)' }, null, 2));
    return;
  }

  console.log('\n--- Agent Inspection ---');
  console.log(`  ID:       ${snapshot.agent.agentId}`);
  console.log(`  Status:   ${snapshot.agent.status}`);
  console.log(`  Provider: ${snapshot.agent.provider}`);
  console.log(`  Model:    ${snapshot.agent.modelId}`);
  console.log(`  Mission:  ${snapshot.agent.missionId || '-'}`);
  
  if (snapshot.metrics) {
    console.log('\n  Metrics:');
    console.log(`    Turns:           ${snapshot.metrics.turnCount}`);
    console.log(`    Errors:          ${snapshot.metrics.errorCount}`);
    console.log(`    Total Tokens:    ${snapshot.metrics.usage?.totalTokens || '-'}`);
  }

  if (snapshot.logs && snapshot.logs.length > 0) {
    console.log('\n  Recent Logs (last 5):');
    for (const log of snapshot.logs.slice(-5)) {
      console.log(`    [${new Date(log.ts).toISOString().slice(11, 19)}] [${log.type}] ${log.content.slice(0, 80)}`);
    }
  }
  console.log('');
}

main().catch((err: any) => {
  logger.error(err.message);
  process.exit(1);
});
