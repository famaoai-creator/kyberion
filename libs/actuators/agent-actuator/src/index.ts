import {
  logger,
  createStandardYargs,
  agentRegistry,
  agentLifecycle,
  a2aBridge,
} from '@agent/core';
import type { AgentProvider } from '@agent/core/agent-registry';
import type { A2AMessage } from '@agent/core/a2a-bridge';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

/**
 * Agent-Actuator v1.0.0
 *
 * ADF-driven multi-agent lifecycle management.
 * Canonical interface for spawning, querying, and managing agents
 * within the Kyberion ecosystem.
 *
 * Actions:
 *   spawn        - Boot a new agent (gemini/claude/codex)
 *   ask          - Send a prompt to a running agent
 *   shutdown     - Terminate a specific agent
 *   shutdown_all - Terminate all agents
 *   list         - List all registered agents
 *   health       - Health snapshot of all agents
 *   a2a          - Route an A2A envelope to the target agent
 */

interface AgentAction {
  action: 'spawn' | 'ask' | 'shutdown' | 'shutdown_all' | 'list' | 'health' | 'a2a' | 'snapshot' | 'refresh' | 'restart';
  params: {
    agentId?: string;
    provider?: AgentProvider;
    modelId?: string;
    systemPrompt?: string;
    capabilities?: string[];
    cwd?: string;
    parentAgentId?: string;
    missionId?: string;
    trustRequired?: number;
    query?: string;
    envelope?: A2AMessage;
    filter?: { status?: string; provider?: string };
  };
}

export async function handleAction(input: AgentAction) {
  const { action, params } = input;

  switch (action) {
    case 'spawn': {
      if (!params.provider) throw new Error('provider is required for spawn');

      const handle = await agentLifecycle.spawn({
        agentId: params.agentId,
        provider: params.provider,
        modelId: params.modelId,
        systemPrompt: params.systemPrompt,
        capabilities: params.capabilities,
        cwd: params.cwd,
        parentAgentId: params.parentAgentId,
        missionId: params.missionId,
        trustRequired: params.trustRequired,
      });

      const record = handle.getRecord();
      logger.info(`[AGENT_ACTUATOR] Spawned: ${record?.agentId} (${record?.provider}/${record?.modelId})`);
      return { status: 'spawned', agent: record };
    }

    case 'ask': {
      if (!params.agentId) throw new Error('agentId is required for ask');
      if (!params.query) throw new Error('query is required for ask');

      const record = agentRegistry.get(params.agentId);
      if (!record) throw new Error(`Agent ${params.agentId} not found`);
      if (record.status !== 'ready' && record.status !== 'busy') {
        throw new Error(`Agent ${params.agentId} is ${record.status}, not ready`);
      }

      const mediator = agentLifecycle.getMediator(params.agentId);
      if (!mediator) throw new Error(`No mediator for ${params.agentId}`);

      agentRegistry.updateStatus(params.agentId, 'busy');
      agentRegistry.touch(params.agentId);

      try {
        const response = await mediator.ask(params.query);
        agentRegistry.updateStatus(params.agentId, 'ready');
        return { status: 'ok', agentId: params.agentId, response };
      } catch (e: any) {
        agentRegistry.updateStatus(params.agentId, 'error');
        throw e;
      }
    }

    case 'shutdown': {
      if (!params.agentId) throw new Error('agentId is required for shutdown');
      await agentLifecycle.shutdown(params.agentId);
      return { status: 'shutdown', agentId: params.agentId };
    }

    case 'shutdown_all': {
      await agentLifecycle.shutdownAll();
      return { status: 'all_shutdown' };
    }

    case 'list': {
      const agents = agentRegistry.list(params.filter as any);
      return { status: 'ok', agents, count: agents.length };
    }

    case 'health': {
      const snapshot = agentRegistry.getHealthSnapshot();
      const agents = agentLifecycle.listSnapshots().map(entry => ({
        agentId: entry.agent.agentId,
        provider: entry.agent.provider,
        modelId: entry.agent.modelId,
        status: entry.agent.status,
        capabilities: entry.agent.capabilities,
        trustScore: entry.agent.trustScore,
        uptimeMs: Date.now() - entry.agent.spawnedAt,
        idleMs: Date.now() - entry.agent.lastActivity,
        runtime: entry.runtime,
        metrics: entry.metrics,
        process: entry.process,
        supportsSoftRefresh: entry.supportsSoftRefresh,
      }));
      return { status: 'ok', ...snapshot, agents };
    }

    case 'snapshot': {
      if (!params.agentId) throw new Error('agentId is required for snapshot');
      const snapshot = agentLifecycle.getSnapshot(params.agentId);
      if (!snapshot) throw new Error(`Agent ${params.agentId} not found`);
      return { status: 'ok', snapshot };
    }

    case 'refresh': {
      if (!params.agentId) throw new Error('agentId is required for refresh');
      const result = await agentLifecycle.refreshContext(params.agentId);
      return { status: 'ok', agentId: params.agentId, ...result };
    }

    case 'restart': {
      if (!params.agentId) throw new Error('agentId is required for restart');
      const handle = await agentLifecycle.restart(params.agentId);
      return { status: 'ok', agentId: params.agentId, agent: handle.getRecord(), snapshot: agentLifecycle.getSnapshot(params.agentId) };
    }

    case 'a2a': {
      if (!params.envelope) throw new Error('envelope is required for a2a');
      const response = await a2aBridge.route(params.envelope);
      return { status: 'ok', response };
    }

    default:
      throw new Error(`Unsupported agent action: ${action}`);
  }
}

// CLI entry point
const main = async () => {
  const argv = await createStandardYargs()
    .option('input', { alias: 'i', type: 'string', required: true })
    .parseSync();

  const inputPath = path.resolve(process.cwd(), argv.input as string);
  const inputContent = safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
