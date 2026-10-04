/* eslint-disable no-restricted-imports -- IP-08 で safeExec/managed-process 経由へ移行予定 (docs/developer/improvement-plans-2026-07/IP-08_ERROR_HANDLING_DISCIPLINE.ja.md) */
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { ACPMediator, ACPMediatorOptions } from '../mesh/acp-mediator.js';
import { type AgentAdapter } from './agent-adapter.js';
import {
  agentRegistry,
  AgentRecord,
  AgentProvider,
  AgentStatus,
  resolveAgentTrustScore,
} from './agent-registry.js';
import { getAgentManifest, validateRequirements } from './agent-manifest.js';
import {
  bindAgentRuntimeInstanceBestEffort,
  ensureAgentIdentityBestEffort,
  releaseAgentRuntimeInstanceBestEffort,
} from './agent-identity.js';
import * as crypto from 'node:crypto';
import { runtimeSupervisor } from '../tool/runtime-supervisor.js';
import { spawnSync } from 'node:child_process';
import { resolveAgentProviderTarget } from './agent-provider-resolution.js';
import { isObsoleteAgentRuntimeProvider } from '../provider/provider-config.js';
import { loadProviderConfig } from '../provider/provider-config.js';
import type { TaskModelHint } from '../reasoning/reasoning-model-routing.js';
import { normalizeEventScope, type EventScopeInput } from '../event-scope.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { isRecord } from '../foundation/text.js';
import {
  createAgentPaneRuntimeAdapter,
  parseAgentRuntimeLaunchMode,
  resolveAgentRuntimeLaunchMode,
  type AgentRuntimeLaunchMode,
} from './agent-pane-runtime-bridge.js';
import { createAgentExecAdapter, hasAgentExecAdapter } from './agent-exec-adapter-bridge.js';
import './agent-exec-adapter-providers.js';
import './agent-pane-runtime-herdr.js';

export type { AgentRuntimeLaunchMode as AgentRuntimeBackend };

const PROJECT_ROOT = pathResolver.rootDir();
const AGENT_IDLE_TIMEOUT_MS = Number(
  getRegisteredEnvText('KYBERION_AGENT_IDLE_TIMEOUT_MS') || 20 * 60 * 1000
);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Agent Lifecycle Manager v1.0
 * Manages spawn/shutdown/health of multiple agent instances.
 */

/** Providers whose exec adapter can launch with every tool disabled (`toolAccess: 'none'`). */
const TOOL_LOCKDOWN_PROVIDERS: ReadonlySet<string> = new Set(['claude']);

export interface SpawnOptions {
  agentId?: string;
  /** Server-owned scoped surface instance; its base manifest remains authoritative. */
  manifestAgentId?: string;
  provider: AgentProvider;
  modelId?: string;
  systemPrompt?: string;
  capabilities?: string[];
  cwd?: string;
  parentAgentId?: string;
  missionId?: string;
  scope?: EventScopeInput;
  trustRequired?: number;
  turnTimeoutMs?: number;
  /** Trusted execution-boundary presence forwarded to ACP risky approvals. */
  hasHuman?: boolean;
  hasUI?: boolean;
  nonInteractive?: boolean;
  runtimeMetadata?: Record<string, unknown>;
  /**
   * Launch substrate for this runtime. Overrides
   * `runtimeMetadata.runtime_backend` and `KYBERION_AGENT_RUNTIME_BACKEND`.
   * `pipe` = ACP/exec children; `pane` = interactive CLI in a terminal-mux pane.
   */
  runtimeBackend?: AgentRuntimeLaunchMode;
  restartPolicy?: {
    maxRestarts: number;
    windowMs: number;
  };
  /** Durable supervisor ownership propagated before the runtime is registered. */
  runtimeOwnerId?: string;
  runtimeOwnerType?: string;
  /**
   * Team Channel E: `none` launches the provider with every tool disabled
   * (no file, shell, web or MCP access). Only providers that can enforce it
   * may be used; any other provider or a pane backend fails closed.
   */
  toolAccess?: 'default' | 'none';
}

/** A policy alias is only valid for a new, principal-bound surface turn instance. */
function resolveRuntimeManifestAgentId(agentId: string, options: SpawnOptions): string {
  const base = options.manifestAgentId;
  if (base === undefined) {
    if (agentId.includes('--conversation-') && agentId.includes('--turn-')) {
      throw new Error(
        '[AGENT_MANIFEST_ALIAS_REQUIRED] Scoped surface instances require their base manifest'
      );
    }
    return agentId;
  }
  const prefix = base + '--conversation-';
  const suffix = agentId.startsWith(prefix) ? agentId.slice(prefix.length) : '';
  if (
    !/^[a-z][a-z0-9-]*$/.test(base) ||
    !/^[a-f0-9]{64}--turn-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      suffix
    ) ||
    options.runtimeOwnerId !== prefix + suffix.slice(0, 64) ||
    options.runtimeOwnerType !== 'surface' ||
    options.runtimeMetadata?.lease_kind !== 'surface-conversation-turn' ||
    options.runtimeMetadata?.surface_agent_id !== base ||
    !options.scope?.viewer_principal?.trim()
  ) {
    throw new Error(
      '[AGENT_MANIFEST_ALIAS_INVALID] Only server-owned scoped surface turn instances may bind a base manifest'
    );
  }
  return base;
}

export interface AgentHandleAskOptions {
  timeoutMs?: number;
  /**
   * SO-05: declared reasoning tier for this turn (fast/standard/deep).
   * Accepted and recorded on every AgentHandle impl; only actually changes
   * the model where the underlying adapter/session supports per-call model
   * switching. Session/adapter-backed handles (exec adapter, ACP mediator)
   * have their model fixed at spawn time — for those the tier is recorded
   * but does not change the model. See per-impl comments below.
   */
  model_tier?: 'fast' | 'standard' | 'deep';
}

export interface AgentHandle {
  agentId: string;
  ask(prompt: string, options?: AgentHandleAskOptions): Promise<string>;
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
  /** SO-05 / OP-01: last declared reasoning tier for an `ask()` call. */
  lastDeclaredModelTier?: 'fast' | 'standard' | 'deep';
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
  const taskRoutingMode = (
    getRegisteredEnvText('KYBERION_TASK_MODEL_ROUTING', { env }) || 'advisory'
  ).toLowerCase();
  const taskModelHint = readTaskModelHint(options.runtimeMetadata);
  if (taskRoutingMode === 'enforce' && taskModelHint?.model_id) {
    return taskModelHint.model_id;
  }
  return options.modelId;
}

const loadProviderLifecycle = () => loadProviderConfig().lifecycle;

class AgentLifecycleManagerImpl {
  private mediators: Map<string, ACPMediator> = new Map();
  private execAdapters: Map<string, AgentAdapter> = new Map();
  private handles: Map<string, AgentHandle> = new Map();
  private pendingSpawns: Map<string, Promise<AgentHandle>> = new Map();
  // Canonical supervisor-side admission survives surface-process restarts.
  // Failed stops retain reservations even if an idle sweep forgets its resource.
  private scopedSurfaceReservations = new Map<string, string>();
  private stoppingScopedRuntimes = new Set<string>();
  private pendingScopedStops = new Map<string, Promise<void>>();
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
    const mediator = this.mediators.get(agentId);
    if (mediator) return { ...mediator.getRuntimeInfo() };
    const adapter = this.execAdapters.get(agentId);
    const runtimeInfo = adapter?.getRuntimeInfo?.();
    if (runtimeInfo) return { ...runtimeInfo };
    return undefined;
  }

  private recordUsage(
    metrics: AgentRuntimeMetrics,
    providerRuntime?: Record<string, unknown>
  ): void {
    const usage = providerRuntime?.usage;
    if (!isRecord(usage)) return;
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
    stopReason: string,
    modelTier?: 'fast' | 'standard' | 'deep'
  ): void {
    const metrics = this.ensureMetrics(agentId);
    metrics.turnCount += 1;
    metrics.lastPromptChars = prompt.length;
    metrics.totalPromptChars += prompt.length;
    metrics.lastResponseChars = responseText.length;
    metrics.totalResponseChars += responseText.length;
    metrics.lastStopReason = stopReason;
    metrics.lastError = undefined;
    if (modelTier) {
      // SO-05 / OP-01: lightweight per-agent record of the last declared
      // tier. Session-backed handles cannot switch models mid-session, so
      // this is a declaration record, not proof the model changed.
      metrics.lastDeclaredModelTier = modelTier;
    }
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
    const manifestAgentId = resolveRuntimeManifestAgentId(agentId, options);
    if (this.stoppingScopedRuntimes.has(agentId)) {
      throw new Error(
        '[AGENT_SURFACE_RUNTIME_STOPPING] Scoped runtime shutdown is pending or uncertain'
      );
    }
    if (options.manifestAgentId) {
      const ownerId = options.runtimeOwnerId!;
      const reserved = this.scopedSurfaceReservations.get(ownerId);
      if (reserved && reserved !== agentId) {
        throw new Error(
          '[AGENT_SURFACE_RUNTIME_BUSY] Another scoped runtime owns this conversation'
        );
      }
      if (!reserved && this.scopedSurfaceReservations.size >= 8) {
        throw new Error(
          '[AGENT_SURFACE_RUNTIME_CAPACITY] Supervised scoped runtime capacity is occupied'
        );
      }
      this.scopedSurfaceReservations.set(ownerId, agentId);
    }
    const existingBinding = agentRegistry.get(agentId)?.metadata?.manifest_agent_id || agentId;
    if (agentRegistry.get(agentId) && existingBinding !== manifestAgentId) {
      throw new Error(
        '[AGENT_MANIFEST_ALIAS_MISMATCH] A live runtime cannot change its base manifest'
      );
    }
    const existingHandle = this.handles.get(agentId);
    const existingRecord = agentRegistry.get(agentId);
    const requestedRuntimeBackend = resolveAgentRuntimeLaunchMode({
      runtimeBackend: options.runtimeBackend,
      runtimeMetadata: options.runtimeMetadata,
    });
    const existingRuntimeBackend =
      parseAgentRuntimeLaunchMode(existingRecord?.metadata?.runtime_backend) || 'pipe';
    if (
      existingHandle &&
      (existingRecord?.status === 'ready' ||
        existingRecord?.status === 'busy' ||
        existingRecord?.status === 'booting')
    ) {
      // Only reuse a live runtime when it matches the requested provider.
      // Dynamic provider failover (demoted backend → new provider) must not
      // be silently satisfied by a runtime still bound to the old backend.
      if (
        (!options.provider || existingRecord?.provider === options.provider) &&
        (!options.modelId || existingRecord?.modelId === options.modelId) &&
        existingRuntimeBackend === requestedRuntimeBackend
      ) {
        return existingHandle;
      }
      logger.info(
        `[AGENT_LIFECYCLE] Recreating ${agentId}: held runtime ` +
          `${existingRecord?.provider}/${existingRecord?.modelId}/${existingRuntimeBackend} != ` +
          `${options.provider}/${options.modelId || '-'}/${requestedRuntimeBackend}`
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
    const manifestAgentId = resolveRuntimeManifestAgentId(agentId, options);
    const manifest = getAgentManifest(manifestAgentId);
    if (options.manifestAgentId) {
      if (!manifest)
        throw new Error(
          '[AGENT_MANIFEST_ALIAS_MISSING] Base surface manifest not found: ' + manifestAgentId
        );
      // Callers may tighten the trust floor but cannot substitute the base
      // prompt/capabilities, remove prerequisites, or lower its trust floor.
      options = {
        ...options,
        systemPrompt: manifest.systemPrompt,
        capabilities: manifest.capabilities,
        trustRequired: Math.max(options.trustRequired ?? 0, manifest.trustRequired),
      };
    }
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
            'strict' | 'preferred' | 'adaptive',
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
    const resolvedScope = resolvedOptions.scope
      ? normalizeEventScope(resolvedOptions.scope)
      : undefined;

    if (isObsoleteAgentRuntimeProvider(resolvedOptions.provider)) {
      throw new Error(
        `[AGENT_PROVIDER_OBSOLETE] Provider '${resolvedOptions.provider}' is obsolete for agent-runtime execution.`
      );
    }

    const runtimeBackend = resolveAgentRuntimeLaunchMode({
      runtimeBackend: resolvedOptions.runtimeBackend,
      runtimeMetadata,
    });
    // Tool lockdown is checked against the resolved (post-fallback) provider
    // before anything is registered, so a refused spawn leaves no state behind.
    if (
      resolvedOptions.toolAccess === 'none' &&
      (runtimeBackend === 'pane' ||
        !TOOL_LOCKDOWN_PROVIDERS.has(resolvedOptions.provider) ||
        !(await hasAgentExecAdapter(resolvedOptions.provider)))
    ) {
      throw new Error(
        `[TOOL_LOCKDOWN_UNSUPPORTED] ${agentId}: provider '${resolvedOptions.provider}' (${runtimeBackend}) cannot run with tools disabled`
      );
    }

    this.spawnOptions.set(agentId, resolvedOptions);
    this.ensureMetrics(agentId);

    // Requirements gate: check manifest prerequisites
    if (manifest) {
      const { ok, reasons } = validateRequirements(manifest);
      if (!ok) {
        throw new Error(`Cannot spawn ${agentId}: ${reasons.join('; ')}`);
      }
    }

    const existingTrustScore = agentRegistry.get(manifestAgentId)?.trustScore;
    const resolvedTrustScore = resolveAgentTrustScore(manifestAgentId, existingTrustScore);

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
      scope: resolvedScope,
      metadata: {
        ...(resolvedOptions.manifestAgentId ? { manifest_agent_id: manifestAgentId } : {}),
        runtime_backend: runtimeBackend,
        provider_resolution: {
          preferredProvider: options.provider,
          preferredModelId: resolvedModelId || null,
          strategy: resolvedTarget.strategy,
          availableProviders: resolvedTarget.availableProviders,
          requiredCapabilities: Array.isArray(options.capabilities) ? options.capabilities : [],
        },
        task_model_hint: runtimeMetadata.task_model_hint,
        scope: resolvedScope,
        ...(resolvedOptions.toolAccess === 'none' ? { tool_access: 'none' } : {}),
      },
    });

    agentRegistry.updateStatus(agentId, 'booting');

    // NI-01: resolve-or-issue the durable AgentIdentity for this runtime and
    // bind the runtime instance to it. Strictly best-effort — an identity
    // ledger failure (unwritable journal, non-allowlisted execution context,
    // missing accountable human) must never break spawn; it is logged as a
    // warning inside the best-effort helpers. The identity survives shutdown;
    // only the *instance* binding is released then (retire is explicit).
    const identityResult = ensureAgentIdentityBestEffort({
      slug: manifestAgentId,
      kind: 'agent',
      displayName: manifestAgentId,
      affiliation: resolvedOptions.missionId
        ? { mission_id: resolvedOptions.missionId }
        : undefined,
      providerHint: resolvedOptions.provider,
      modelHint: resolvedOptions.modelId,
    });
    if (identityResult.nhi_id) {
      // In-memory registry is the runtime-instance cache of the durable
      // identity registry: stamp the nhi_id so lookups can reach it.
      agentRegistry.attachRuntimeIdentity(agentId, identityResult.nhi_id);
      if (identityResult.recorded) {
        bindAgentRuntimeInstanceBestEffort({
          nhiId: identityResult.nhi_id,
          instanceId: agentId,
          pid: process.pid,
          sessionId: resolvedOptions.missionId,
          provider: resolvedOptions.provider,
          modelId: resolvedOptions.modelId,
        });
      }
    }

    if (resolvedTarget.strategy === 'fallback') {
      logger.info(
        `[LIFECYCLE] Falling back agent ${agentId} from ${options.provider}/${options.modelId || '-'} to ${resolvedOptions.provider}/${resolvedOptions.modelId || '-'}`
      );
    }

    // Opt-in pane backend: interactive provider CLIs in visible terminal panes.

    if (runtimeBackend === 'pane') {
      const paneBackend = await createAgentPaneRuntimeAdapter({
        agentId,
        provider: resolvedOptions.provider,
        modelId: resolvedOptions.modelId,
        cwd: resolvedOptions.cwd || PROJECT_ROOT,
        systemPrompt: resolvedOptions.systemPrompt,
        turnTimeoutMs: resolvedOptions.turnTimeoutMs,
      });
      if (resolvedOptions.manifestAgentId) this.execAdapters.set(agentId, paneBackend);
      await paneBackend.boot();
      this.execAdapters.set(agentId, paneBackend);
      runtimeSupervisor.register({
        resourceId: agentId,
        kind: 'agent',
        ownerId: resolvedOptions.runtimeOwnerId || resolvedOptions.missionId || agentId,
        ownerType:
          resolvedOptions.runtimeOwnerType || (resolvedOptions.missionId ? 'mission' : 'agent'),
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        shutdownPolicy: 'idle',
        metadata: {
          provider: resolvedOptions.provider,
          modelId: resolvedOptions.modelId || config?.default_model || resolvedOptions.provider,
          scope: resolvedScope,
          runtime_backend: 'pane',
          ...(paneBackend.getRuntimeInfo?.() || {}),
        },
        cleanup: async () => this.shutdown(agentId),
      });
      agentRegistry.updateStatus(agentId, 'ready');
      logger.info(`[LIFECYCLE] Agent ${agentId} (pane/${resolvedOptions.provider}) ready.`);

      const handle: AgentHandle = {
        agentId,
        ask: async (prompt: string, askOptions: AgentHandleAskOptions = {}) => {
          agentRegistry.updateStatus(agentId, 'busy');
          agentRegistry.touch(agentId);
          runtimeSupervisor.touch(agentId);
          try {
            const res = await paneBackend.ask(prompt, {
              timeoutMs: askOptions.timeoutMs ?? resolvedOptions.turnTimeoutMs,
            });
            agentRegistry.updateStatus(agentId, 'ready');
            this.observeSuccess(agentId, prompt, res.text, res.stopReason, askOptions.model_tier);
            return res.text;
          } catch (e: unknown) {
            agentRegistry.updateStatus(agentId, 'error');
            this.observeFailure(agentId, prompt, asError(e));
            throw e;
          }
        },
        shutdown: async () => {
          if (resolvedOptions.manifestAgentId) return this.shutdown(agentId);
          await paneBackend.shutdown();
          this.execAdapters.delete(agentId);
          this.handles.delete(agentId);
          runtimeSupervisor.unregister(agentId);
          this.releaseIdentityInstance(agentId, 'shutdown');
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

    // Pipe/exec adapters (Claude, Codex, Agy, …) resolve via the exec-adapter seam
    if (await hasAgentExecAdapter(resolvedOptions.provider)) {
      const taskModelHint = readTaskModelHint(runtimeMetadata);
      const adapter = await createAgentExecAdapter({
        provider: resolvedOptions.provider,
        modelId: resolvedOptions.modelId,
        cwd: resolvedOptions.cwd || PROJECT_ROOT,
        systemPrompt: resolvedOptions.systemPrompt,
        effort: taskModelHint?.effort,
        allowedActuators: manifest?.allowedActuators,
        deniedActuators: manifest?.deniedActuators,
        ...(resolvedOptions.toolAccess === 'none' ? { toolsDisabled: true } : {}),
      });

      // A failed/slow boot still belongs to the scoped stop request. Keep the
      // adapter reachable before awaiting boot, so cleanup cannot acknowledge
      // a stop while abandoning the partially created provider resource.
      if (resolvedOptions.manifestAgentId) this.execAdapters.set(agentId, adapter);
      await adapter.boot();
      this.execAdapters.set(agentId, adapter);
      runtimeSupervisor.register({
        resourceId: agentId,
        kind: 'agent',
        ownerId: resolvedOptions.runtimeOwnerId || resolvedOptions.missionId || agentId,
        ownerType:
          resolvedOptions.runtimeOwnerType || (resolvedOptions.missionId ? 'mission' : 'agent'),
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        shutdownPolicy: 'idle',
        metadata: {
          provider: resolvedOptions.provider,
          modelId: resolvedOptions.modelId || config?.default_model || resolvedOptions.provider,
          scope: resolvedScope,
          runtime_backend: 'pipe',
        },
        cleanup: async () => this.shutdown(agentId),
      });
      agentRegistry.updateStatus(agentId, 'ready');
      logger.info(`[LIFECYCLE] Agent ${agentId} (${resolvedOptions.provider}) ready.`);

      const handle: AgentHandle = {
        agentId,
        // SO-05: exec adapters (Claude/Codex/AGY) don't support per-call
        // model switching — the model is fixed at spawn (resolvedOptions.modelId).
        // `options.model_tier` is accepted and recorded via observeSuccess
        // (metrics.lastDeclaredModelTier) but does not change which model
        // answers this turn.
        ask: async (prompt: string, options: AgentHandleAskOptions = {}) => {
          agentRegistry.updateStatus(agentId, 'busy');
          agentRegistry.touch(agentId);
          runtimeSupervisor.touch(agentId);
          try {
            const res = await adapter.ask(prompt);
            agentRegistry.updateStatus(agentId, 'ready');
            this.observeSuccess(agentId, prompt, res.text, res.stopReason, options.model_tier);
            return res.text;
          } catch (e: unknown) {
            agentRegistry.updateStatus(agentId, 'error');
            this.observeFailure(agentId, prompt, asError(e));
            throw e;
          }
        },
        shutdown: async () => {
          if (resolvedOptions.manifestAgentId) return this.shutdown(agentId);
          await adapter.shutdown();
          this.execAdapters.delete(agentId);
          this.handles.delete(agentId);
          runtimeSupervisor.unregister(agentId);
          // NI-01: release the runtime-instance binding (identity persists
          // until explicitly retired). Must run before unregister — the
          // nhi_id lives in the registry record's metadata.
          this.releaseIdentityInstance(agentId, 'shutdown');
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

    // ACP mediators launch the provider with its own tools; never a lockdown target.
    if (resolvedOptions.toolAccess === 'none') {
      agentRegistry.updateStatus(agentId, 'error');
      throw new Error(
        `[TOOL_LOCKDOWN_UNSUPPORTED] ${agentId}: no exec adapter for '${resolvedOptions.provider}' to run with tools disabled`
      );
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
      ...(resolvedOptions.hasHuman !== undefined ? { hasHuman: resolvedOptions.hasHuman } : {}),
      ...(resolvedOptions.hasUI !== undefined ? { hasUI: resolvedOptions.hasUI } : {}),
      ...(resolvedOptions.nonInteractive !== undefined
        ? { nonInteractive: resolvedOptions.nonInteractive }
        : {}),
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
        } catch (error: unknown) {
          logger.error(
            `[LIFECYCLE] Auto-restart failed for ${crashedAgentId}: ${errorMessage(error)}`
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
        ownerId: resolvedOptions.runtimeOwnerId || resolvedOptions.missionId || agentId,
        ownerType:
          resolvedOptions.runtimeOwnerType || (resolvedOptions.missionId ? 'mission' : 'agent'),
        idleTimeoutMs: AGENT_IDLE_TIMEOUT_MS,
        shutdownPolicy: 'idle',
        metadata: {
          provider: resolvedOptions.provider,
          modelId: mediatorOpts.modelId,
          scope: resolvedScope,
          runtime_backend: 'pipe',
        },
        cleanup: async () => this.shutdown(agentId),
      });
      agentRegistry.updateStatus(agentId, 'ready');
      logger.info(
        `[LIFECYCLE] Agent ${agentId} (${resolvedOptions.provider}/${mediatorOpts.modelId}) ready.`
      );
    } catch (e: unknown) {
      agentRegistry.updateStatus(agentId, 'error');
      if (!resolvedOptions.manifestAgentId) this.mediators.delete(agentId);
      throw new Error(`Failed to boot ${agentId}: ${errorMessage(e)}`);
    }

    const handle: AgentHandle = {
      agentId,
      // SO-05: the ACP mediator session (gemini/claude ACP) does not support
      // per-call model switching either — model is fixed at mediator boot
      // (mediatorOpts.modelId). `askOptions.model_tier` is accepted and
      // recorded via observeSuccess but does not change which model answers
      // this turn.
      ask: async (prompt: string, askOptions: AgentHandleAskOptions = {}) => {
        agentRegistry.updateStatus(agentId, 'busy');
        agentRegistry.touch(agentId);
        runtimeSupervisor.touch(agentId);
        try {
          const result = await mediator.ask(prompt, {
            timeoutMs: askOptions.timeoutMs ?? resolvedOptions.turnTimeoutMs,
          });
          agentRegistry.updateStatus(agentId, 'ready');
          this.observeSuccess(agentId, prompt, result, 'completed', askOptions.model_tier);
          return result;
        } catch (e: unknown) {
          agentRegistry.updateStatus(agentId, 'error');
          this.observeFailure(agentId, prompt, asError(e));
          throw e;
        }
      },
      shutdown: async () => this.shutdown(agentId),
      getRecord: () => agentRegistry.get(agentId),
    };
    this.handles.set(agentId, handle);
    return handle;
  }

  /**
   * NI-01: best-effort release of the durable identity's runtime-instance
   * binding for `agentId`. Reads the nhi_id from the in-memory registry
   * record's metadata (stamped at spawn), so it must run BEFORE
   * `agentRegistry.unregister`. Never throws — shutdown must not break on an
   * identity-ledger failure.
   */
  private releaseIdentityInstance(agentId: string, reason: string): void {
    const nhiId = agentRegistry.getRuntimeIdentity(agentId);
    if (nhiId) releaseAgentRuntimeInstanceBestEffort(nhiId, agentId, reason);
  }

  async shutdown(agentId: string): Promise<void> {
    const reservation = [...this.scopedSurfaceReservations.entries()].find(
      ([, runtimeId]) => runtimeId === agentId
    );
    if (!reservation) return this.shutdownRuntime(agentId);
    const existingStop = this.pendingScopedStops.get(agentId);
    if (existingStop) return existingStop;
    this.stoppingScopedRuntimes.add(agentId);
    const pendingSpawn = this.pendingSpawns.get(agentId);
    const stop = (async () => {
      // Ensure publication settles BEFORE acknowledging stop. In particular,
      // a timed-out daemon ensure may still be waiting in adapter.boot().
      // A boot rejection is not itself successful cleanup of the adapter.
      if (pendingSpawn) await pendingSpawn.catch(() => undefined);
      await this.shutdownRuntime(agentId);
      this.scopedSurfaceReservations.delete(reservation[0]);
      this.stoppingScopedRuntimes.delete(agentId);
    })();
    this.pendingScopedStops.set(agentId, stop);
    try {
      await stop;
    } finally {
      this.pendingScopedStops.delete(agentId);
    }
  }

  private async shutdownRuntime(agentId: string): Promise<void> {
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
    this.releaseIdentityInstance(agentId, 'shutdown');
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
            } catch (error: unknown) {
              logger.error(
                `[LIFECYCLE] Auto-restart failed for ${record.agentId}: ${errorMessage(error)}`
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
        } else if (providerRuntime?.backend === 'pane') {
          // Pane-runtime vendors own the child PTY; treat a reachable agent_status as alive.
          const paneStatus = String(providerRuntime.agent_status || '')
            .trim()
            .toLowerCase();
          if (
            paneStatus &&
            !['error', 'failed', 'dead', 'stopped', 'exited', 'terminated'].includes(paneStatus)
          ) {
            results.set(record.agentId, record.status);
          } else {
            agentRegistry.updateStatus(record.agentId, 'error');
            results.set(record.agentId, 'error');
          }
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
    if (exec && typeof exec.getLog === 'function') return exec.getLog(limit);

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
    const mediator = this.mediators.get(agentId);
    const adapter = this.execAdapters.get(agentId);
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
const globalState = globalThis as typeof globalThis & { [key: symbol]: unknown };
const existingLifecycle = globalState[GLOBAL_KEY];
if (!(existingLifecycle instanceof AgentLifecycleManagerImpl)) {
  globalState[GLOBAL_KEY] = new AgentLifecycleManagerImpl();
  // In an import cycle (runtime-supervisor → … → agent-lifecycle) the
  // supervisor binding may still be mid-evaluation here; defer the sweep
  // start one tick so module init order can never crash the process.
  queueMicrotask(() => {
    runtimeSupervisor?.startSweep(
      Number(getRegisteredEnvText('KYBERION_RUNTIME_SWEEP_INTERVAL_MS') || 30_000)
    );
  });
}
export const agentLifecycle = globalState[GLOBAL_KEY] as AgentLifecycleManagerImpl;

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
