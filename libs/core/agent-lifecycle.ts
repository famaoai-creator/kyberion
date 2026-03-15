import { logger } from './core';
import { ACPMediator, ACPMediatorOptions } from './acp-mediator';
import { CodexAdapter, CodexAppServerAdapter, ClaudeAdapter } from './agent-adapter';
import { agentRegistry, AgentRecord, AgentProvider, AgentStatus } from './agent-registry';
import { getAgentManifest, validateRequirements } from './agent-manifest';
import * as crypto from 'node:crypto';
import { safeExistsSync } from './secure-io';
import * as path from 'node:path';
import { runtimeSupervisor } from './runtime-supervisor';
import { spawnSync } from 'node:child_process';

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

export interface AgentUsageMetrics {
  promptChars: number;
  responseChars: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  raw?: Record<string, unknown>;
}

export interface AgentRuntimeMetrics {
  turnCount: number;
  errorCount: number;
  restartCount: number;
  refreshCount: number;
  lastPromptChars: number;
  totalPromptChars: number;
  lastResponseChars: number;
  totalResponseChars: number;
  lastStopReason?: string;
  lastError?: string;
  lastRefreshedAt?: number;
  lastRestartedAt?: number;
  usage?: AgentUsageMetrics;
}

export interface AgentProcessStats {
  rssKb?: number;
  cpuPercent?: number;
}

export interface AgentRuntimeSnapshot {
  agent: AgentRecord;
  runtime?: ReturnType<typeof runtimeSupervisor.snapshot>[number];
  metrics: AgentRuntimeMetrics;
  logs: { ts: number; type: string; content: string }[];
  process?: AgentProcessStats;
  providerRuntime?: Record<string, unknown>;
  supportsSoftRefresh: boolean;
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
  private spawnOptions: Map<string, SpawnOptions> = new Map();
  private runtimeMetrics: Map<string, AgentRuntimeMetrics> = new Map();

  private ensureMetrics(agentId: string): AgentRuntimeMetrics {
    let metrics = this.runtimeMetrics.get(agentId);
    if (!metrics) {
      metrics = {
        turnCount: 0,
        errorCount: 0,
        restartCount: 0,
        refreshCount: 0,
        lastPromptChars: 0,
        totalPromptChars: 0,
        lastResponseChars: 0,
        totalResponseChars: 0,
      };
      this.runtimeMetrics.set(agentId, metrics);
    }
    return metrics;
  }

  private getProviderRuntime(agentId: string): Record<string, unknown> | undefined {
    const mediator = this.mediators.get(agentId) as any;
    if (mediator?.getRuntimeInfo) return mediator.getRuntimeInfo();
    const adapter = this.execAdapters.get(agentId) as any;
    if (adapter?.getRuntimeInfo) return adapter.getRuntimeInfo();
    return undefined;
  }

  private recordUsage(metrics: AgentRuntimeMetrics, providerRuntime?: Record<string, unknown>): void {
    const usage = providerRuntime?.usage as Record<string, unknown> | undefined;
    if (!usage) return;
    metrics.usage = {
      promptChars: metrics.lastPromptChars,
      responseChars: metrics.lastResponseChars,
      inputTokens: coerceUsageNumber(usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens),
      outputTokens: coerceUsageNumber(usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.completion_tokens),
      totalTokens: coerceUsageNumber(usage.totalTokens ?? usage.total_tokens),
      raw: usage,
    };
  }

  private observeSuccess(agentId: string, prompt: string, responseText: string, stopReason: string): void {
    const metrics = this.ensureMetrics(agentId);
    metrics.turnCount += 1;
    metrics.lastPromptChars = prompt.length;
    metrics.totalPromptChars += prompt.length;
    metrics.lastResponseChars = responseText.length;
    metrics.totalResponseChars += responseText.length;
    metrics.lastStopReason = stopReason;
    metrics.lastError = undefined;
    this.recordUsage(metrics, this.getProviderRuntime(agentId));
  }

  private observeFailure(agentId: string, prompt: string, error: Error): void {
    const metrics = this.ensureMetrics(agentId);
    metrics.turnCount += 1;
    metrics.errorCount += 1;
    metrics.lastPromptChars = prompt.length;
    metrics.totalPromptChars += prompt.length;
    metrics.lastResponseChars = 0;
    metrics.lastStopReason = 'error';
    metrics.lastError = error.message;
  }

  async spawn(options: SpawnOptions): Promise<AgentHandle> {
    const agentId = options.agentId || `${options.provider}-${crypto.randomUUID().slice(0, 8)}`;
    this.spawnOptions.set(agentId, { ...options, agentId });
    this.ensureMetrics(agentId);

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
            this.observeSuccess(agentId, prompt, res.text, res.stopReason);
            return res.text;
          } catch (e: any) {
            agentRegistry.updateStatus(agentId, 'error');
            this.observeFailure(agentId, prompt, e);
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
          this.spawnOptions.delete(agentId);
          this.runtimeMetrics.delete(agentId);
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
          this.observeSuccess(agentId, prompt, result, 'completed');
          return result;
        } catch (e: any) {
          agentRegistry.updateStatus(agentId, 'error');
          this.observeFailure(agentId, prompt, e);
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
    this.spawnOptions.delete(agentId);
    this.runtimeMetrics.delete(agentId);
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

  getSnapshot(agentId: string, logLimit = 50): AgentRuntimeSnapshot | undefined {
    const agent = agentRegistry.get(agentId);
    if (!agent) return undefined;
    const runtime = runtimeSupervisor.get(agentId);
    const providerRuntime = this.getProviderRuntime(agentId);
    const pid = typeof providerRuntime?.pid === 'number' ? providerRuntime.pid : runtime?.pid;
    return {
      agent,
      runtime: runtime ? {
        ...runtime,
        idleForMs: Math.max(0, Date.now() - runtime.lastActiveAt),
      } : undefined,
      metrics: { ...this.ensureMetrics(agentId) },
      logs: this.getLog(agentId, logLimit),
      process: probeProcessStats(pid),
      providerRuntime,
      supportsSoftRefresh: Boolean(providerRuntime?.supportsSoftRefresh),
    };
  }

  listSnapshots(logLimit = 20): AgentRuntimeSnapshot[] {
    return agentRegistry.list().map((agent) => this.getSnapshot(agent.agentId, logLimit)).filter(Boolean) as AgentRuntimeSnapshot[];
  }

  async refreshContext(agentId: string): Promise<{ mode: 'soft' | 'restart' | 'stateless'; snapshot: AgentRuntimeSnapshot | undefined }> {
    const mediator: any = this.mediators.get(agentId);
    const adapter: any = this.execAdapters.get(agentId);
    const metrics = this.ensureMetrics(agentId);

    if (mediator?.refreshContext) {
      await mediator.refreshContext();
      metrics.refreshCount += 1;
      metrics.lastRefreshedAt = Date.now();
      return { mode: 'soft', snapshot: this.getSnapshot(agentId) };
    }

    if (adapter?.refreshContext) {
      const result = await adapter.refreshContext();
      metrics.refreshCount += 1;
      metrics.lastRefreshedAt = Date.now();
      const mode = result?.mode === 'stateless' ? 'stateless' : 'soft';
      return { mode, snapshot: this.getSnapshot(agentId) };
    }

    await this.restart(agentId);
    return { mode: 'restart', snapshot: this.getSnapshot(agentId) };
  }

  async restart(agentId: string): Promise<AgentHandle> {
    const options = this.spawnOptions.get(agentId);
    if (!options) throw new Error(`No spawn options available for ${agentId}`);
    const previousMetrics = { ...this.ensureMetrics(agentId) };
    await this.shutdown(agentId);
    const handle = await this.spawn(options);
    const metrics: AgentRuntimeMetrics = {
      ...previousMetrics,
      restartCount: previousMetrics.restartCount + 1,
      lastRestartedAt: Date.now(),
    };
    this.runtimeMetrics.set(agentId, metrics);
    return handle;
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

function probeProcessStats(pid?: number): AgentProcessStats | undefined {
  if (!pid) return undefined;
  try {
    const result = spawnSync('ps', ['-o', 'rss=,%cpu=', '-p', String(pid)], { encoding: 'utf8' });
    if (result.status !== 0) return undefined;
    const [rss, cpu] = (result.stdout || '').trim().split(/\s+/, 2);
    return {
      rssKb: rss ? Number(rss) : undefined,
      cpuPercent: cpu ? Number(cpu) : undefined,
    };
  } catch {
    return undefined;
  }
}

function coerceUsageNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
