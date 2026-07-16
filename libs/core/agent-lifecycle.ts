/* eslint-disable no-restricted-imports -- IP-08 で safeExec/managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { logger } from './core.js';
import { pathResolver } from './path-resolver.js';
import { ACPMediator, ACPMediatorOptions } from './acp-mediator.js';
import { CodexAdapter, CodexAppServerAdapter, ClaudeAdapter, AgyAdapter } from './agent-adapter.js';
import {
  agentRegistry,
  AgentRecord,
  AgentProvider,
  AgentStatus,
  resolveAgentTrustScore,
} from './agent-registry.js';
import { getAgentManifest, validateRequirements } from './agent-manifest.js';
import * as crypto from 'node:crypto';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import * as path from 'node:path';
import { runtimeSupervisor } from './runtime-supervisor.js';
import { spawnSync } from 'node:child_process';
import { resolveAgentProviderTarget } from './agent-provider-resolution.js';
import { loadProviderConfig } from './provider-config.js';
import { resolveRuntimeModelId } from './runtime-model-defaults.js';
import type { TaskModelHint } from './reasoning-model-routing.js';

const PROJECT_ROOT = pathResolver.rootDir();
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
  turnTimeoutMs?: number;
  runtimeMetadata?: Record<string, unknown>;
  restartPolicy?: {
    maxRestarts: number;
    windowMs: number;
  };
}

export interface AgentHandle {
  agentId: string;
  ask(prompt: string, options?: { timeoutMs?: number }): Promise<string>;
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

function readTaskModelHint(runtimeMetadata?: Record<string, unknown>): TaskModelHint | undefined {
  const candidate = runtimeMetadata?.task_model_hint;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const hint = candidate as Partial<TaskModelHint>;
  if (
    typeof hint.model_id !== 'string' ||
    typeof hint.tier !== 'string' ||
    typeof hint.effort !== 'string' ||
    typeof hint.route_reason !== 'string'
  ) {
    return undefined;
  }
  if (hint.tier !== 'small' && hint.tier !== 'standard' && hint.tier !== 'large') return undefined;
  if (hint.effort !== 'low' && hint.effort !== 'medium' && hint.effort !== 'high') return undefined;
  return {
    model_id: hint.model_id.trim(),
    tier: hint.tier,
    effort: hint.effort,
    route_reason: hint.route_reason,
  };
}

export function resolveAgentLifecycleModelId(
  options: Pick<SpawnOptions, 'modelId' | 'runtimeMetadata'>,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const taskRoutingMode = String(env.KYBERION_TASK_MODEL_ROUTING || 'advisory').toLowerCase();
  const taskModelHint = readTaskModelHint(options.runtimeMetadata);
  if (taskRoutingMode === 'enforce' && taskModelHint?.model_id) {
    return taskModelHint.model_id;
  }
  return options.modelId;
}

const loadProviderLifecycle = () => loadProviderConfig().lifecycle;

class AgentLifecycleManagerImpl {
  private mediators: Map<string, ACPMediator> = new Map();
  private execAdapters: Map<
    string,
    CodexAdapter | CodexAppServerAdapter | ClaudeAdapter | AgyAdapter
  > = new Map();
  private handles: Map<string, AgentHandle> = new Map();
  private pendingSpawns: Map<string, Promise<AgentHandle>> = new Map();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private spawnOptions: Map<string, SpawnOptions> = new Map();
  private runtimeMetrics: Map<string, AgentRuntimeMetrics> = new Map();
  private restartHistory: Map<string, number[]> = new Map();

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

  private recordUsage(
    metrics: AgentRuntimeMetrics,
    providerRuntime?: Record<string, unknown>
  ): void {
    const usage = providerRuntime?.usage as Record<string, unknown> | undefined;
    if (!usage) return;
    metrics.usage = {
      promptChars: metrics.lastPromptChars,
      responseChars: metrics.lastResponseChars,
      inputTokens: coerceUsageNumber(
        usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.prompt_tokens
      ),
      outputTokens: coerceUsageNumber(
        usage.outputTokens ??
          usage.output_tokens ??
          usage.completionTokens ??
          usage.completion_tokens
      ),
      totalTokens: coerceUsageNumber(usage.totalTokens ?? usage.total_tokens),
      raw: usage,
    };
  }

  private recordAutoRestart(agentId: string): number[] {
    const now = Date.now();
    const history = this.restartHistory.get(agentId) || [];
    history.push(now);
    this.restartHistory.set(agentId, history);
    return history;
  }

  private canAutoRestart(
    agentId: string,
    policy: NonNullable<SpawnOptions['restartPolicy']>
  ): boolean {
    const now = Date.now();
    const history = (this.restartHistory.get(agentId) || []).filter(
      (ts) => now - ts <= policy.windowMs
    );
    this.restartHistory.set(agentId, history);
    return history.length < policy.maxRestarts;
  }

  private observeSuccess(
    agentId: string,
    prompt: string,
    responseText: string,
    stopReason: string
  ): void {
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
    const existingHandle = this.handles.get(agentId);
    const existingRecord = agentRegistry.get(agentId);
    if (
      existingHandle &&
      (existingRecord?.status === 'ready' ||
        existingRecord?.status === 'busy' ||
        existingRecord?.status === 'booting')
    ) {
      // Only reuse a live runtime when it matches the requested provider.
      // Dynamic provider failover (demoted backend → new provider) must not
      // be silently satisfied by a runtime still bound to the old backend.
      if (!options.provider || existingRecord?.provider === options.provider) {
        return existingHandle;
      }
      logger.info(
        `[AGENT_LIFECYCLE] Recreating ${agentId}: held provider ${existingRecord?.provider} != requested ${options.provider}`
      );
      await this.shutdown(agentId);
    }
    const pending = this.pendingSpawns.get(agentId);
    if (pending) {
      return pending;
    }

    const pendingSpawn = this.spawnInternal(agentId, options);
    this.pendingSpawns.set(agentId, pendingSpawn);
    try {
      return await pendingSpawn;
    } finally {
      this.pendingSpawns.delete(agentId);
    }
  }

  private async spawnInternal(agentId: string, options: SpawnOptions): Promise<AgentHandle> {
    const runtimeMetadata = options.runtimeMetadata || {};
    const resolvedModelId = resolveAgentLifecycleModelId(
      { modelId: options.modelId, runtimeMetadata },
      process.env
    );
    const shouldResolveProvider = !runtimeMetadata.skip_provider_resolution;
    const resolvedTarget = shouldResolveProvider
      ? resolveAgentProviderTarget({
          preferredProvider: options.provider,
          preferredModelId: resolvedModelId,
          providerStrategy: String(runtimeMetadata.provider_strategy || 'adaptive') as
            | 'strict'
            | 'preferred'
            | 'adaptive',
          fallbackProviders: Array.isArray(runtimeMetadata.fallback_providers)
            ? (runtimeMetadata.fallback_providers as string[])
            : undefined,
          requiredCapabilities: Array.isArray(options.capabilities)
            ? options.capabilities
            : undefined,
        })
      : {
          provider: options.provider,
          modelId: resolvedModelId || options.modelId || options.provider,
          strategy: 'preferred' as const,
          availableProviders: [options.provider],
        };
    const resolvedOptions: SpawnOptions = {
      ...options,
      agentId,
      provider: resolvedTarget.provider,
      modelId: resolvedTarget.modelId,
    };

    this.spawnOptions.set(agentId, resolvedOptions);
    this.ensureMetrics(agentId);

    // Requirements gate: check manifest prerequisites
    const manifest = getAgentManifest(agentId);
    if (manifest) {
      const { ok, reasons } = validateRequirements(manifest);
      if (!ok) {
        throw new Error(`Cannot spawn ${agentId}: ${reasons.join('; ')}`);
      }
    }

    const existingTrustScore = agentRegistry.get(agentId)?.trustScore;
    const resolvedTrustScore = resolveAgentTrustScore(agentId, existingTrustScore);

    // Trust gate
    const trustRequired = resolvedOptions.trustRequired ?? manifest?.trustRequired ?? 0;
    if (trustRequired > 0) {
      if (resolvedTrustScore < trustRequired) {
        throw new Error(
          `Trust score ${resolvedTrustScore} below required ${trustRequired} for ${agentId}`
        );
      }
    }

    const lifecycleMap = loadProviderLifecycle();
    const config = lifecycleMap[resolvedOptions.provider];

    // Register in registry
    agentRegistry.register({
      agentId,
      provider: resolvedOptions.provider,
      modelId: resolvedOptions.modelId || config?.default_model || resolvedOptions.provider,
      capabilities: resolvedOptions.capabilities || [],
      trustScore: resolvedTrustScore,
      sessionId: null,
      threadId: agentId,
      parentAgentId: resolvedOptions.parentAgentId,
      missionId: resolvedOptions.missionId,
      metadata: {
        provider_resolution: {
          preferredProvider: options.provider,
          preferredModelId: resolvedModelId || null,
          strategy: resolvedTarget.strategy,
          availableProviders: resolvedTarget.availableProviders,
          requiredCapabilities: Array.isArray(options.capabilities) ? options.capabilities : [],
        },
        task_model_hint: runtimeMetadata.task_model_hint,
      },
    });

    agentRegistry.updateStatus(agentId, 'booting');

    if (resolvedTarget.strategy === 'fallback') {
      logger.info(
        `[LIFECYCLE] Falling back agent ${agentId} from ${options.provider}/${options.modelId || '-'} to ${resolvedOptions.provider}/${resolvedOptions.modelId || '-'}`
      );
    }

    // Codex, Claude, and Agy use exec mode, not ACP
    if (
      resolvedOptions.provider === 'codex' ||
      resolvedOptions.provider === 'claude' ||
      resolvedOptions.provider === 'agy'
    ) {
      let adapter: CodexAdapter | CodexAppServerAdapter | ClaudeAdapter | AgyAdapter;

      if (resolvedOptions.provider === 'agy') {
        adapter = new AgyAdapter({
          bin: 'agy',
          cwd: resolvedOptions.cwd || PROJECT_ROOT,
          model: resolvedOptions.modelId,
        });
      } else if (resolvedOptions.provider === 'claude') {
        const taskModelHint = readTaskModelHint(runtimeMetadata);
        // Resolve tool restrictions from manifest
        const { allowedTools, disallowedTools } = ClaudeAdapter.resolveToolRestrictions(
          manifest?.allowedActuators || [],
          manifest?.deniedActuators || []
        );
        adapter = new ClaudeAdapter({
          systemPrompt: resolvedOptions.systemPrompt,
          cwd: resolvedOptions.cwd || PROJECT_ROOT,
          model: resolvedOptions.modelId,
          effort: taskModelHint?.effort,
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
            model: resolvedOptions.modelId,
            modelProvider: process.env.KYBERION_CODEX_MODEL_PROVIDER,
            cwd: resolvedOptions.cwd || PROJECT_ROOT,
            systemPrompt: resolvedOptions.systemPrompt,
            approvalMode:
              (process.env.KYBERION_CODEX_APPROVAL || 'strict').toLowerCase() === 'relaxed'
                ? 'relaxed'
                : 'strict',
          });
        }
      }

      await adapter.boot();
      this.execAdapters.set(agentId, adapter);
      runtimeSupervisor.register({
        resourceId: agentId,
        kind: 'agent',
        ownerId: resolvedOptions.missionId || agentId,
        ownerType: resolvedOptions.missionId ? 'mission' : 'agent',
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        shutdownPolicy: 'idle',
        metadata: {
          provider: resolvedOptions.provider,
          modelId: resolvedOptions.modelId || config?.default_model || resolvedOptions.provider,
        },
        cleanup: async () => this.shutdown(agentId),
      });
      agentRegistry.updateStatus(agentId, 'ready');
      logger.info(`[LIFECYCLE] Agent ${agentId} (${resolvedOptions.provider}) ready.`);

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
      throw new Error(
        `Unknown provider: ${resolvedOptions.provider}. Supported: ${Object.keys(lifecycleMap).join(', ')}, codex`
      );
    }

    const mediatorOpts: ACPMediatorOptions = {
      threadId: agentId,
      bootCommand: config.boot_command,
      bootArgs: [...config.boot_args],
      modelId: resolvedOptions.modelId || config.default_model,
      systemPrompt: resolvedOptions.systemPrompt,
      cwd: resolvedOptions.cwd || PROJECT_ROOT,
      turnTimeoutMs: resolvedOptions.turnTimeoutMs,
      onCrash: async ({ agentId: crashedAgentId }) => {
        const policy = resolvedOptions.restartPolicy;
        if (!policy) return;
        if (!this.canAutoRestart(crashedAgentId, policy)) {
          logger.warn(`[LIFECYCLE] Restart budget exhausted for ${crashedAgentId}`);
          return;
        }
        this.recordAutoRestart(crashedAgentId);
        try {
          await this.restart(crashedAgentId);
          logger.info(`[LIFECYCLE] Auto-restarted ${crashedAgentId} after crash.`);
        } catch (error: any) {
          logger.error(
            `[LIFECYCLE] Auto-restart failed for ${crashedAgentId}: ${error?.message || error}`
          );
        }
      },
    };

    const mediator = new ACPMediator(mediatorOpts);
    this.mediators.set(agentId, mediator);

    try {
      await mediator.boot();
      runtimeSupervisor.register({
        resourceId: agentId,
        kind: 'agent',
        ownerId: resolvedOptions.missionId || agentId,
        ownerType: resolvedOptions.missionId ? 'mission' : 'agent',
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        shutdownPolicy: 'idle',
        metadata: { provider: resolvedOptions.provider, modelId: mediatorOpts.modelId },
        cleanup: async () => this.shutdown(agentId),
      });
      agentRegistry.updateStatus(agentId, 'ready');
      logger.info(
        `[LIFECYCLE] Agent ${agentId} (${resolvedOptions.provider}/${mediatorOpts.modelId}) ready.`
      );
    } catch (e: any) {
      agentRegistry.updateStatus(agentId, 'error');
      this.mediators.delete(agentId);
      throw new Error(`Failed to boot ${agentId}: ${e.message}`);
    }

    const handle: AgentHandle = {
      agentId,
      ask: async (prompt: string, askOptions: { timeoutMs?: number } = {}) => {
        agentRegistry.updateStatus(agentId, 'busy');
        agentRegistry.touch(agentId);
        runtimeSupervisor.touch(agentId);
        try {
          const result = await mediator.ask(prompt, {
            timeoutMs: askOptions.timeoutMs ?? resolvedOptions.turnTimeoutMs,
          });
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
    this.pendingSpawns.delete(agentId);
    runtimeSupervisor.unregister(agentId);
    agentRegistry.updateStatus(agentId, 'shutdown');
    agentRegistry.unregister(agentId);
    this.spawnOptions.delete(agentId);
    this.runtimeMetrics.delete(agentId);
    logger.info(`[LIFECYCLE] Agent ${agentId} shutdown.`);
  }

  async shutdownAll(): Promise<void> {
    const agents = agentRegistry.list();
    await Promise.allSettled(agents.map((a) => this.shutdown(a.agentId)));
    this.stopHealthMonitor();
    logger.info(`[LIFECYCLE] All agents shutdown.`);
  }

  async healthCheck(): Promise<Map<string, AgentStatus>> {
    const results = new Map<string, AgentStatus>();
    for (const record of agentRegistry.list()) {
      const mediator = this.mediators.get(record.agentId);
      if (record.status === 'shutdown') continue;

      if (mediator) {
        if (mediator.isProcessAlive()) {
          results.set(record.agentId, record.status);
        } else {
          const policy = this.spawnOptions.get(record.agentId)?.restartPolicy;
          if (policy && this.canAutoRestart(record.agentId, policy)) {
            this.recordAutoRestart(record.agentId);
            try {
              await this.restart(record.agentId);
              agentRegistry.updateStatus(record.agentId, 'ready');
              results.set(record.agentId, 'ready');
              continue;
            } catch (error: any) {
              logger.error(
                `[LIFECYCLE] Auto-restart failed for ${record.agentId}: ${error?.message || error}`
              );
            }
          }
          agentRegistry.updateStatus(record.agentId, 'error');
          results.set(record.agentId, 'error');
        }
      } else if (this.execAdapters.has(record.agentId)) {
        const providerRuntime = this.getProviderRuntime(record.agentId);
        const pid = typeof providerRuntime?.pid === 'number' ? providerRuntime.pid : undefined;
        if (pid && isProcessAlive(pid)) {
          results.set(record.agentId, record.status);
        } else if (providerRuntime?.stateless === true) {
          results.set(record.agentId, record.status);
        } else {
          agentRegistry.updateStatus(record.agentId, 'error');
          results.set(record.agentId, 'error');
        }
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
    this.healthInterval.unref?.();
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
      runtime: runtime
        ? {
            ...runtime,
            idleForMs: Math.max(0, Date.now() - runtime.lastActiveAt),
          }
        : undefined,
      metrics: { ...this.ensureMetrics(agentId) },
      logs: this.getLog(agentId, logLimit),
      process: probeProcessStats(pid),
      providerRuntime,
      supportsSoftRefresh: Boolean(providerRuntime?.supportsSoftRefresh),
    };
  }

  listSnapshots(logLimit = 20): AgentRuntimeSnapshot[] {
    return agentRegistry
      .list()
      .map((agent) => this.getSnapshot(agent.agentId, logLimit))
      .filter(Boolean) as AgentRuntimeSnapshot[];
  }

  async refreshContext(agentId: string): Promise<{
    mode: 'soft' | 'restart' | 'stateless';
    snapshot: AgentRuntimeSnapshot | undefined;
  }> {
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
  // In an import cycle (runtime-supervisor → … → agent-lifecycle) the
  // supervisor binding may still be mid-evaluation here; defer the sweep
  // start one tick so module init order can never crash the process.
  queueMicrotask(() => {
    runtimeSupervisor?.startSweep(Number(process.env.KYBERION_RUNTIME_SWEEP_INTERVAL_MS || 30_000));
  });
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

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
