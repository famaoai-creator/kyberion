import { createStandardYargs } from '@agent/core/cli-utils';
import { agentLifecycle } from '@agent/core/agent-lifecycle';
import { agentRegistry } from '@agent/core/agent-registry';
import { getAgentManifest, loadAgentManifests } from '@agent/core/agent-manifest';
import { logger } from '@agent/core/core';
import { auditChain } from '@agent/core/audit-chain';
import { classifyError } from '@agent/core/error-classifier';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

type AgentAction = 'ps' | 'spawn' | 'shutdown' | 'list-manifests' | 'inspect';
type Print = (value: unknown) => void;

export const main = async (args: string[] = [], print: Print = () => undefined) => {
  const argv = await createStandardYargs(['node', 'agent_runtime_manager', ...args])
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
      await listRunningAgents(print);
      break;
    case 'spawn':
      if (!argv['agent-id']) throw new Error('--agent-id (manifest ID) is required for spawn');
      await spawnAgent(
        argv['agent-id'] as string,
        {
          provider: argv.provider as any,
          modelId: argv.model as string,
          missionId: argv['mission-id'] as string,
        },
        print
      );
      break;
    case 'shutdown':
      if (!argv['agent-id']) throw new Error('--agent-id is required for shutdown');
      await shutdownAgent(argv['agent-id'] as string);
      break;
    case 'list-manifests':
      await listManifests(print);
      break;
    case 'inspect':
      if (!argv['agent-id']) throw new Error('--agent-id is required for inspect');
      await inspectAgent(argv['agent-id'] as string, print);
      break;
    default:
      throw new Error(`Unsupported action: ${action}`);
  }
};

export async function listRunningAgents(print: Print) {
  const agents = agentRegistry.list();
  if (agents.length === 0) {
    print('\nNo agents currently running.\n');
    return;
  }

  print('');
  const header = `${'AGENT_ID'.padEnd(30)} ${'STATUS'.padEnd(12)} ${'PROVIDER'.padEnd(12)} ${'MODEL'.padEnd(25)} MISSION_ID`;
  print(header);
  print('-'.repeat(header.length + 10));

  for (const agent of agents) {
    const statusIcon =
      {
        ready: '🟢',
        busy: '🟡',
        booting: '⚪',
        error: '🔴',
        shutdown: '📁',
      }[agent.status] || '  ';

    print(
      `${agent.agentId.padEnd(30)} ${statusIcon} ${agent.status.padEnd(10)} ${agent.provider.padEnd(12)} ${agent.modelId.padEnd(25)} ${agent.missionId || '-'}`
    );
  }
  print('');
}

export async function listManifests(print: Print) {
  const manifests = loadAgentManifests();
  if (manifests.length === 0) {
    print('\nNo agent manifests found in knowledge/product/agents/.\n');
    return;
  }

  print('');
  const header = `${'MANIFEST_ID'.padEnd(30)} ${'AUTO'.padEnd(6)} ${'TRUST'.padEnd(6)} DESCRIPTION`;
  print(header);
  print('-'.repeat(header.length + 20));

  for (const m of manifests) {
    const autoIcon = m.autoSpawn ? '✅' : '  ';
    const description =
      m.systemPrompt.split('\n')[0].slice(0, 50) + (m.systemPrompt.length > 50 ? '...' : '');
    print(
      `${m.agentId.padEnd(30)} ${autoIcon} ${String(m.trustRequired).padEnd(6)} ${description}`
    );
  }
  print('');
}

export async function spawnAgent(
  manifestId: string,
  overrides: { provider?: any; modelId?: string; missionId?: string },
  print: Print
) {
  const manifest = getAgentManifest(manifestId);
  if (!manifest) throw new Error(`Agent manifest "${manifestId}" not found.`);

  logger.info(`Spawning agent from manifest: ${manifestId}...`);
  let handle;
  try {
    handle = await agentLifecycle.spawn({
      agentId: `${manifestId}-${Math.random().toString(36).slice(2, 10)}`,
      provider: overrides.provider || manifest.selection_hints?.preferred_provider || 'gemini',
      modelId: overrides.modelId || manifest.selection_hints?.preferred_modelId,
      systemPrompt: manifest.systemPrompt,
      capabilities: manifest.capabilities,
      missionId: overrides.missionId,
    });
  } catch (err: any) {
    const classification = classifyError(err);
    auditChain.record({
      agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
      action: 'agent.manual_spawn',
      operation: manifestId,
      result: 'failed',
      metadata: { manifestId, overrides, classification },
    });
    logger.error(
      `[AGENT_RUNTIME] spawn failed (${classification.category}): ${err?.message || err}`
    );
    throw err;
  }

  auditChain.record({
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
    action: 'agent.manual_spawn',
    operation: handle.agentId,
    result: 'completed',
    metadata: { manifestId, overrides },
  });

  logger.success(`✅ Agent spawned: ${handle.agentId}`);
  print(JSON.stringify(handle.getRecord(), null, 2));
}

export async function shutdownAgent(agentId: string) {
  const agent = agentRegistry.get(agentId);
  if (!agent) throw new Error(`Agent "${agentId}" not found.`);

  await agentLifecycle.shutdown(agentId);

  auditChain.record({
    agentId: getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
    action: 'agent.manual_shutdown',
    operation: agentId,
    result: 'completed',
  });

  logger.success(`✅ Agent "${agentId}" shut down.`);
}

export async function inspectAgent(agentId: string, print: Print) {
  const snapshot = agentLifecycle.getSnapshot(agentId);
  if (!snapshot) {
    // Try to find in registry even if lifecycle handle is gone
    const record = agentRegistry.get(agentId);
    if (!record) throw new Error(`Agent "${agentId}" not found.`);
    print(
      JSON.stringify(
        {
          record,
          note: 'Agent is registered but not actively managed by lifecycle (likely shutdown or error)',
        },
        null,
        2
      )
    );
    return;
  }

  print('\n--- Agent Inspection ---');
  print(`  ID:       ${snapshot.agent.agentId}`);
  print(`  Status:   ${snapshot.agent.status}`);
  print(`  Provider: ${snapshot.agent.provider}`);
  print(`  Model:    ${snapshot.agent.modelId}`);
  print(`  Mission:  ${snapshot.agent.missionId || '-'}`);

  if (snapshot.metrics) {
    print('\n  Metrics:');
    print(`    Turns:           ${snapshot.metrics.turnCount}`);
    print(`    Errors:          ${snapshot.metrics.errorCount}`);
    print(`    Total Tokens:    ${snapshot.metrics.usage?.totalTokens || '-'}`);
  }

  if (snapshot.logs && snapshot.logs.length > 0) {
    print('\n  Recent Logs (last 5):');
    for (const log of snapshot.logs.slice(-5)) {
      print(
        `    [${new Date(log.ts).toISOString().slice(11, 19)}] [${log.type}] ${log.content.slice(0, 80)}`
      );
    }
  }
  print('');
}

export const runAgentRuntimeManager = defineScript({
  name: 'agent-runtime:manage',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'agent_runtime_manager.ts') ||
  isDirectScript(import.meta.url, 'agent_runtime_manager.js')
)
  void runAgentRuntimeManager();
