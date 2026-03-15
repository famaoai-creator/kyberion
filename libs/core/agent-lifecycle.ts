import { logger } from './core';
import { ACPMediator, ACPMediatorOptions } from './acp-mediator';
import { CodexAdapter, CodexAppServerAdapter, ClaudeAdapter } from './agent-adapter';
import { agentRegistry, AgentRecord, AgentProvider, AgentStatus } from './agent-registry';
import { getAgentManifest, validateRequirements } from './agent-manifest';
import * as crypto from 'node:crypto';
import { safeExistsSync } from './secure-io';
import * as path from 'node:path';
import { runtimeSupervisor } from './runtime-supervisor';

/** Walk up from cwd to find the project root (contains AGENTS.md) */
function resolveProjectRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (safeExistsSync(path.join(dir, 'AGENTS.md'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}
const PROJECT_ROOT = resolveProjectRoot();
const AGENT_IDLE_TIMEOUT_MS = Number(process.env.KYBERION_AGENT_IDLE_TIMEOUT_MS || 20 * 60 * 1000);

/**
 * Agent Lifecycle Manager v1.0
 * Manages spawn/shutdown/health of multiple agent instances.
 */

export interface SpawnOptions {
  agentId?: string;
  provider: AgentProvider;
  modelId?: string;
  systemPrompt?: string;
  capabilities?: string[];
  cwd?: string;
  parentAgentId?: string;
  missionId?: string;
  trustRequired?: number;
}

export interface AgentHandle {
  agentId: string;
  ask(prompt: string): Promise<string>;
  shutdown(): Promise<void>;
  getRecord(): AgentRecord | undefined;
}

const PROVIDER_CONFIG: Record<string, { bootCommand: string; bootArgs: string[]; defaultModel: string }> = {
  gemini: { bootCommand: 'gemini', bootArgs: ['--acp', '-y'], defaultModel: 'gemini-2.5-flash' },
  copilot: { bootCommand: 'gh', bootArgs: ['copilot', '--', '--acp', '--allow-all'], defaultModel: 'claude-sonnet-4' },
};

class AgentLifecycleManagerImpl {
  private mediators: Map<string, ACPMediator> = new Map();
  private execAdapters: Map<string, CodexAdapter | CodexAppServerAdapter | ClaudeAdapter> = new Map();
  private handles: Map<string, AgentHandle> = new Map();
  private healthInterval: ReturnType<typeof setInterval> | null = null;

  async spawn(options: SpawnOptions): Promise<AgentHandle> {
    const agentId = options.agentId || `${options.provider}-${crypto.randomUUID().slice(0, 8)}`;

    // Requirements gate: check manifest prerequisites
    const manifest = getAgentManifest(agentId);
    if (manifest) {
      const { ok, reasons } = validateRequirements(manifest);
      if (!ok) {
        throw new Error(`Cannot spawn ${agentId}: ${reasons.join('; ')}`);
      }
    }

    // Trust gate
    const trustRequired = options.trustRequired ?? manifest?.trustRequired ?? 0;
    if (trustRequired > 0) {
      const existing = agentRegistry.get(agentId);
      const score = existing?.trustScore ?? 5.0;
      if (score < trustRequired) {
        throw new Error(`Trust score ${score} below required ${trustRequired} for ${agentId}`);
      }
    }

    const config = PROVIDER_CONFIG[options.provider];

    // Register in registry
    agentRegistry.register({
      agentId,
      provider: options.provider,
      modelId: options.modelId || config?.defaultModel || options.provider,
      capabilities: options.capabilities || [],
      trustScore: 5.0,
      sessionId: null,
      threadId: agentId,
      parentAgentId: options.parentAgentId,
      missionId: options.missionId,
    });

    agentRegistry.updateStatus(agentId, 'booting');

    // Codex and Claude use exec mode, not ACP
    if (options.provider === 'codex' || options.provider === 'claude') {
      let adapter: CodexAdapter | CodexAppServerAdapter | ClaudeAdapter;

      if (options.provider === 'claude') {
        // Resolve tool restrictions from manifest
        const { allowedTools, disallowedTools } = ClaudeAdapter.resolveToolRestrictions(
          manifest?.allowedActuators || [],
          manifest?.deniedActuators || []
        );
        adapter = new ClaudeAdapter({
          systemPrompt: options.systemPrompt,
          cwd: options.cwd || PROJECT_ROOT,
          model: options.modelId,
          allowedTools: allowedTools.length > 0 ? allowedTools : undefined,
          disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
          permissionMode: 'auto',
        });
      } else {
        const mode = (process.env.KYBERION_CODEX_MODE || 'app-server').toLowerCase();
        if (mode === 'exec' || mode === 'legacy') {
          adapter = new CodexAdapter();
        } else {
          adapter = new CodexAppServerAdapter({
            model: options.modelId,
            modelProvider: process.env.KYBERION_CODEX_MODEL_PROVIDER,
            cwd: options.cwd || PROJECT_ROOT,
            systemPrompt: options.systemPrompt,
            approvalMode: (process.env.KYBERION_CODEX_APPROVAL || 'strict').toLowerCase() === 'relaxed' ? 'relaxed' : 'strict',
          });
        }
      }

      await adapter.boot();
      this.execAdapters.set(agentId, adapter);
      runtimeSupervisor.register({
        resourceId: agentId,
        kind: 'agent',
        ownerId: options.missionId || agentId,
        ownerType: options.missionId ? 'mission' : 'agent',
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        shutdownPolicy: 'idle',
        metadata: { provider: options.provider, modelId: options.modelId || config?.defaultModel || options.provider },
        cleanup: async () => this.shutdown(agentId),
      });
      agentRegistry.updateStatus(agentId, 'ready');
      logger.info(`[LIFECYCLE] Agent ${agentId} (${options.provider}) ready.`);

      const handle: AgentHandle = {
        agentId,
        ask: async (prompt: string) => {
          agentRegistry.updateStatus(agentId, 'busy');
          agentRegistry.touch(agentId);
          runtimeSupervisor.touch(agentId);
          try {
            const res = await adapter.ask(prompt);
            agentRegistry.updateStatus(agentId, 'ready');
            return res.text;
          } catch (e: any) {
            agentRegistry.updateStatus(agentId, 'error');
            throw e;
          }
        },
        shutdown: async () => {
          await adapter.shutdown();
          this.execAdapters.delete(agentId);
          this.handles.delete(agentId);
          runtimeSupervisor.unregister(agentId);
          agentRegistry.updateStatus(agentId, 'shutdown');
          agentRegistry.unregister(agentId);
        },
        getRecord: () => agentRegistry.get(agentId),
      };
      this.handles.set(agentId, handle);
      return handle;
    }

    // ACP-based agents (gemini, claude, etc.)
    if (!config) {
      agentRegistry.updateStatus(agentId, 'error');
      throw new Error(`Unknown provider: ${options.provider}. Supported: ${Object.keys(PROVIDER_CONFIG).join(', ')}, codex`);
    }

    const mediatorOpts: ACPMediatorOptions = {
      threadId: agentId,
      bootCommand: config.bootCommand,
      bootArgs: [...config.bootArgs],
      modelId: options.modelId || config.defaultModel,
      systemPrompt: options.systemPrompt,
      cwd: options.cwd || PROJECT_ROOT,
    };

    const mediator = new ACPMediator(mediatorOpts);
    this.mediators.set(agentId, mediator);

    try {
      await mediator.boot();
      runtimeSupervisor.register({
        resourceId: agentId,
        kind: 'agent',
        ownerId: options.missionId || agentId,
        ownerType: options.missionId ? 'mission' : 'agent',
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        shutdownPolicy: 'idle',
        metadata: { provider: options.provider, modelId: mediatorOpts.modelId },
        cleanup: async () => this.shutdown(agentId),
      });
      agentRegistry.updateStatus(agentId, 'ready');
      logger.info(`[LIFECYCLE] Agent ${agentId} (${options.provider}/${mediatorOpts.modelId}) ready.`);
    } catch (e: any) {
      agentRegistry.updateStatus(agentId, 'error');
      this.mediators.delete(agentId);
      throw new Error(`Failed to boot ${agentId}: ${e.message}`);
    }

    const handle: AgentHandle = {
      agentId,
      ask: async (prompt: string) => {
        agentRegistry.updateStatus(agentId, 'busy');
        agentRegistry.touch(agentId);
        runtimeSupervisor.touch(agentId);
        try {
          const result = await mediator.ask(prompt);
          agentRegistry.updateStatus(agentId, 'ready');
          return result;
        } catch (e: any) {
          agentRegistry.updateStatus(agentId, 'error');
          throw e;
        }
      },
      shutdown: async () => this.shutdown(agentId),
      getRecord: () => agentRegistry.get(agentId),
    };
    this.handles.set(agentId, handle);
    return handle;
  }

  async shutdown(agentId: string): Promise<void> {
    const mediator = this.mediators.get(agentId);
    if (mediator) {
      await mediator.shutdown();
      this.mediators.delete(agentId);
    }
    const exec = this.execAdapters.get(agentId);
    if (exec) {
      await exec.shutdown();
      this.execAdapters.delete(agentId);
    }
    this.handles.delete(agentId);
    runtimeSupervisor.unregister(agentId);
    agentRegistry.updateStatus(agentId, 'shutdown');
    agentRegistry.unregister(agentId);
    logger.info(`[LIFECYCLE] Agent ${agentId} shutdown.`);
  }

  async shutdownAll(): Promise<void> {
    const agents = agentRegistry.list();
    await Promise.allSettled(agents.map(a => this.shutdown(a.agentId)));
    this.stopHealthMonitor();
    logger.info(`[LIFECYCLE] All agents shutdown.`);
  }

  async healthCheck(): Promise<Map<string, AgentStatus>> {
    const results = new Map<string, AgentStatus>();
    for (const record of agentRegistry.list()) {
      const mediator = this.mediators.get(record.agentId);
      if (record.status === 'shutdown') continue;

      if (mediator) {
        // Check if child process is still alive
        results.set(record.agentId, record.status);
      } else if (this.execAdapters.has(record.agentId)) {
        results.set(record.agentId, record.status);
      } else if (record.status !== 'error') {
        agentRegistry.updateStatus(record.agentId, 'error');
        results.set(record.agentId, 'error');
      }
    }
    return results;
  }

  startHealthMonitor(intervalMs = 30000): void {
    if (this.healthInterval) return;
    this.healthInterval = setInterval(() => this.healthCheck(), intervalMs);
    logger.info(`[LIFECYCLE] Health monitor started (${intervalMs}ms).`);
  }

  stopHealthMonitor(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  getMediator(agentId: string): ACPMediator | undefined {
    return this.mediators.get(agentId);
  }

  /** Get a unified handle for any agent type (ACP or exec mode) */
  getHandle(agentId: string): AgentHandle | undefined {
    return this.handles.get(agentId);
  }

  /** Get terminal log for an agent */
  getLog(agentId: string, limit = 50): { ts: number; type: string; content: string }[] {
    const mediator = this.mediators.get(agentId);
    if (mediator) return mediator.getLog(limit);

    const exec = this.execAdapters.get(agentId);
    if (exec && 'getLog' in exec) return (exec as any).getLog(limit);

    return [];
  }
}

const GLOBAL_KEY = Symbol.for('@kyberion/agent-lifecycle');
if (!(globalThis as any)[GLOBAL_KEY]) {
  (globalThis as any)[GLOBAL_KEY] = new AgentLifecycleManagerImpl();
  runtimeSupervisor.startSweep(Number(process.env.KYBERION_RUNTIME_SWEEP_INTERVAL_MS || 30_000));

  // Cleanup on process exit to prevent orphaned child processes
  const cleanup = () => {
    const instance: AgentLifecycleManagerImpl = (globalThis as any)[GLOBAL_KEY];
    if (instance) {
      logger.info('[LIFECYCLE] Process exit — shutting down all agents...');
      instance.shutdownAll().catch(() => {});
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}
export const agentLifecycle: AgentLifecycleManagerImpl = (globalThis as any)[GLOBAL_KEY];
