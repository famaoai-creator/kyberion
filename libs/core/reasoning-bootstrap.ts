/**
 * Reasoning Bootstrap — installs a real reasoning / intent-extraction /
 * voice backend at startup based on the configured mode.
 *
 * Modes (selected by `KYBERION_REASONING_BACKEND` env var, or explicit
 * `options.mode`):
 *
 *   `claude-agent`  — use @anthropic-ai/claude-agent-sdk (sub-agent delegation,
 *                     CLI-harness coordination model). Auth can be inherited
 *                     from the surrounding interactive session when available.
 *   `anthropic`     — use @anthropic-ai/sdk directly. Requires ANTHROPIC_API_KEY.
 *   `openrouter`    — use OpenRouter's OpenAI-compatible API. Requires
 *                     OPENROUTER_API_KEY or KYBERION_OPENROUTER_KEY.
 *   `nemotron-api`  — use an OpenAI-compatible Nemotron endpoint.
 *   `local`         — use a local OpenAI-compatible server on localhost.
 *   `stub`          — keep deterministic stubs. Offline/dev default.
 *
 *   `gemini-api`  — use the Google AI Studio Gemini REST API. Requires
 *                   GEMINI_API_KEY or GOOGLE_API_KEY.
 *   `grok-api`    — use the xAI Grok REST API (OpenAI-compatible). Requires
 *                   XAI_API_KEY or KYBERION_GROK_API_KEY.
 *
 * Auto-selection when mode is unset:
 *   - If ANTHROPIC_API_KEY / GEMINI_API_KEY / KYBERION_NEMOTRON_URL /
 *     KYBERION_LOCAL_LLM_URL / OPENROUTER_API_KEY / KYBERION_OPENROUTER_KEY are present, the first
 *     matching policy rule wins.
 *   - OpenRouter model selection defaults to the zero-cost `openrouter/free`
 *     router. Pinned free models or paid models must be declared through the
 *     OpenRouter model policy; paid inference requires an explicit
 *     `KYBERION_OPENROUTER_COST_POLICY=paid-allowed` opt-in.
 *   - Otherwise → prefer the authenticated Claude CLI, then Grok, Codex, AGY,
 *     and Copilot through the governed provider fallback chain. The legacy
 *     `gemini-cli` adapter remains available for explicit / Enterprise
 *     configurations but is not auto-selected.
 *
 * Override explicitly via env var to pin behavior:
 *   KYBERION_REASONING_BACKEND=claude-cli      (recommended local CLI)
 *   KYBERION_REASONING_BACKEND=anthropic       (standalone with API key)
 *   KYBERION_REASONING_BACKEND=stub            (offline / testing)
 */

import { logger } from './core.js';
import { getRegisteredEnvText } from './foundation/env.js';
import type Anthropic from '@anthropic-ai/sdk';
import { clearReasoningDegraded, markReasoningDegraded } from './reasoning-degradation.js';
import { loadLlmSelectionPreferences } from './llm-selection-preferences.js';
import { initializeAdapterDefaultPreferences } from './adapter-default-selection.js';
import type { OpenAiCompatibleBackendOverrides } from './openai-compatible-backend.js';
import { buildOpenAiCompatibleProviderBundle } from './reasoning-openai-compatible-provider.js';
import { buildCliProviderBundle } from './reasoning-cli-provider.js';
import { buildApiProviderBundle } from './reasoning-api-provider.js';
import {
  buildFailoverReasoningBackend,
  buildRoleAwareReasoningBackend,
  registerReasoningBackend,
  resetReasoningBackend,
} from './reasoning-backend.js';
import {
  buildFailoverIntentExtractor,
  registerIntentExtractor,
  resetIntentExtractor,
} from './intent-extractor.js';
import { buildFailoverVoiceBridge, registerVoiceBridge, resetVoiceBridge } from './voice-bridge.js';
import {
  installFluidAudioSpeechToTextBridgeIfAvailable,
  installShellSpeechToTextBridgeIfAvailable,
} from './speech-to-text-bridge.js';
import { installAppleSpeechToTextBridgeIfAvailable } from './apple-intelligence-bridge.js';
import {
  installShellDeploymentAdapterFromConfigIfAvailable,
  installShellDeploymentAdapterIfAvailable,
} from './deployment-adapter.js';
import { installAuditForwarderIfAvailable } from './audit-forwarder.js';
import { installSecretResolverIfAvailable } from './secret-resolver.js';
import { installPythonVoiceBridgeIfAvailable } from './python-voice-bridge.js';
import { installEmbeddingBackendIfAvailable } from './embedding-bootstrap.js';
import { discoverProviders } from './provider-discovery.js';
import { discoverReasoningEndpoints } from './reasoning-endpoint-discovery.js';
import {
  loadProviderCapabilityRegistry,
  peekProviderCapabilityRegistry,
} from './provider-capability-registry.js';
import { resolveProviderDecision } from './capability-broker.js';
import { auditChain } from './audit-chain.js';
import {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode as normalizeReasoningBackendModeFromPolicy,
  resolveReasoningBackendSelectionFromContext,
  type ReasoningBackendMode,
} from './reasoning-backend-policy.js';

function kyberionEnv(name: string): string | undefined {
  return getRegisteredEnvText(name);
}
import {
  loadReasoningRoutePolicy,
  resolveReasoningRoute,
  resolveSamplingParams,
  type SamplingParams,
} from './reasoning-route-resolver.js';
import {
  buildRegisteredReasoningProvider,
  getReasoningProviderDescriptor,
  listReasoningProviderModes,
  type ReasoningProviderRuntimeBundle,
} from './reasoning-provider-registry.js';

export type { ReasoningBackendMode } from './reasoning-backend-policy.js';

let installed = false;
let installedMode: ReasoningBackendMode | null = null;
let lastBrokerSelection: {
  resolvedMode: ReasoningBackendMode;
  provider: string;
  pinned: boolean;
} | null = null;
let lastModeSelectionReason: string | null = null;

export function normalizeReasoningBackendMode(mode: ReasoningBackendMode): ReasoningBackendMode {
  return normalizeReasoningBackendModeFromPolicy(mode, loadReasoningBackendPolicy());
}

export interface InstallReasoningOptions {
  /** Explicit mode selection. Overrides KYBERION_REASONING_BACKEND env var. */
  mode?: ReasoningBackendMode;
  /** Override model for model-based backends. Defaults to the provider's standard model when omitted. */
  model?: string;
  /** Governed role/profile route; omitted preserves legacy automatic selection. */
  role?: string;
  profile?: string;
  samplingParams?: SamplingParams;
  toolsEnabled?: boolean;
  allowedTools?: import('./reasoning-route-resolver.js').ReasoningToolName[];
  contextWindowTokens?: number;
  maxCompletionTokens?: number;
  /** Pre-built Anthropic client (applies only to `anthropic` mode). */
  anthropicClient?: Anthropic;
  /** Force install even if stub would be chosen otherwise (for tests). */
  force?: boolean;
  /** Re-scan provider availability instead of using the cached discovery snapshot. */
  refreshProviders?: boolean;
}

/** @deprecated Use InstallReasoningOptions */
export type InstallAnthropicOptions = InstallReasoningOptions;

function resolveMode(options: InstallReasoningOptions): ReasoningBackendMode {
  const discoveredProviders = discoverProviders(shouldRefreshProviders(options));
  const configuredEndpoints = discoverReasoningEndpoints().filter(
    (endpoint) => endpoint.configured
  );
  logger.info(
    `[REASONING_ENDPOINT_DISCOVERY] Configured ${configuredEndpoints.length}: ${
      configuredEndpoints.map((endpoint) => endpoint.runtime).join(', ') || 'none'
    }`
  );
  const selection = resolveReasoningBackendSelectionFromContext({
    requestedMode: options.mode,
    env: process.env,
    providers: discoveredProviders,
    policy: loadReasoningBackendPolicy(),
  });
  lastModeSelectionReason = selection.reason;
  return selection.mode;
}

function applyOperatorLlmSelection(options: InstallReasoningOptions): InstallReasoningOptions {
  if (options.mode || kyberionEnv('KYBERION_REASONING_BACKEND')) return options;
  const selection = loadLlmSelectionPreferences();
  if (!selection || !REASONING_BACKEND_MODES.has(selection.provider as ReasoningBackendMode)) {
    return options;
  }
  return {
    ...options,
    mode: selection.provider as ReasoningBackendMode,
    model: options.model || selection.model_id,
  };
}

function providerForReasoningMode(mode: ReasoningBackendMode): string | undefined {
  return getReasoningProviderDescriptor(mode)?.provider;
}

type ReasoningRuntimeBundle = ReasoningProviderRuntimeBundle;

function openAiOverrides(
  options: InstallReasoningOptions,
  mode: string
): OpenAiCompatibleBackendOverrides {
  return {
    model: options.model,
    samplingParams: options.samplingParams
      ? resolveSamplingParams({ mode, sampling: options.samplingParams })
      : undefined,
    contextWindowTokens: options.contextWindowTokens,
    maxCompletionTokens: options.maxCompletionTokens,
    toolsEnabled: options.toolsEnabled,
    allowedTools: options.allowedTools,
  };
}

function buildReasoningRuntimeBundle(
  mode: ReasoningBackendMode,
  options: InstallReasoningOptions
): ReasoningRuntimeBundle | null {
  // Managed provider modules get the same governed bundle contract as built-ins.
  // A factory returning null deliberately falls through to the built-in adapter
  // so registration can add a mode-specific override without changing policy.
  const registeredBundle = buildRegisteredReasoningProvider(mode, options);
  if (registeredBundle) return registeredBundle;

  const provider = providerForReasoningMode(mode);
  const openAiCompatibleBundle = buildOpenAiCompatibleProviderBundle({
    mode,
    provider,
    overrides: openAiOverrides(options, mode),
  });
  if (openAiCompatibleBundle !== undefined) return openAiCompatibleBundle;

  const cliBundle = buildCliProviderBundle({
    mode,
    provider,
    model: options.model,
    force: options.force,
  });
  if (cliBundle !== undefined) return cliBundle;

  return buildApiProviderBundle({
    mode,
    provider,
    model: options.model,
    force: options.force,
    anthropicClient: options.anthropicClient,
    samplingParams: options.samplingParams,
    toolsEnabled: options.toolsEnabled,
    allowedTools: options.allowedTools,
  });
}

/**
 * XP-01: narrow the failover chain using a provider-capability-registry
 * snapshot when one is available. This is opt-in and non-breaking by
 * construction: nothing in this repo populates the registry file as part of
 * normal bootstrap, so `peekProviderCapabilityRegistry` returns null (no
 * snapshot, no reprobe triggered here) and the chain is returned unchanged —
 * identical to pre-XP-01 behavior. `KYBERION_PROVIDER_CAPABILITY_ROUTING=0`
 * is an explicit kill-switch for environments that populate a registry file
 * but want the old fail-open behavior back.
 */
function filterChainByProviderCapability(
  chain: ReasoningRuntimeBundle[]
): ReasoningRuntimeBundle[] {
  if (kyberionEnv('KYBERION_PROVIDER_CAPABILITY_ROUTING') === '0') return chain;

  let snapshot: ReturnType<typeof peekProviderCapabilityRegistry>;
  try {
    snapshot = peekProviderCapabilityRegistry();
  } catch (err) {
    logger.warn(
      `[reasoning-bootstrap] provider-capability-registry peek failed (non-fatal, fail-open): ${err instanceof Error ? err.message : String(err)}`
    );
    return chain;
  }
  if (!snapshot || snapshot.length === 0) return chain;

  const byProvider = new Map(snapshot.map((entry) => [entry.provider_id, entry]));
  return chain.filter((candidate) => {
    const provider = providerForReasoningMode(candidate.mode);
    if (!provider) return true;
    const capability = byProvider.get(provider);
    if (!capability) return true;
    if (!capability.binary_found) {
      // A cached negative snapshot can describe the pnpm placeholder even
      // after the runtime shell probe selected a real fallback binary. Keep
      // the runtime-verified Claude candidate instead of waiting for TTL.
      if (provider === 'claude' && candidate.mode === 'claude-cli') {
        logger.warn(
          `[reasoning-bootstrap] retaining candidate mode=${candidate.mode} provider=${provider}: runtime shell probe selected a fallback binary while the capability snapshot reports binary_found=false (probed_at=${capability.probed_at})`
        );
        return true;
      }
      logger.info(
        `[reasoning-bootstrap] excluding candidate mode=${candidate.mode} provider=${provider}: provider-capability-registry reports binary_found=false (probed_at=${capability.probed_at})`
      );
      return false;
    }
    // An auth probe failure is not a durable negative fact. For example,
    // `gh auth status` can briefly fail while the keyring refreshes, and the
    // persisted snapshot may remain inside its TTL after authentication has
    // recovered. Keep the candidate in that case and let the runtime
    // provider-local auth classification fail over to the next candidate.
    if (capability.authenticated === false && !capability.probe_error) {
      logger.info(
        `[reasoning-bootstrap] excluding candidate mode=${candidate.mode} provider=${provider}: provider-capability-registry reports authenticated=false (probed_at=${capability.probed_at})`
      );
      return false;
    }
    if (capability.authenticated === false && capability.probe_error) {
      logger.warn(
        `[reasoning-bootstrap] retaining candidate mode=${candidate.mode} provider=${provider}: authentication probe errored; treating snapshot as uncertain (probed_at=${capability.probed_at})`
      );
    }
    return true;
  });
}

function shouldRefreshCapabilityRegistry(options: InstallReasoningOptions): boolean {
  return (
    options.refreshProviders === true || kyberionEnv('KYBERION_PROVIDER_CAPABILITY_REFRESH') === '1'
  );
}

function refreshCapabilityRegistryIfRequested(options: InstallReasoningOptions): void {
  if (!shouldRefreshCapabilityRegistry(options)) return;
  if (kyberionEnv('KYBERION_PROVIDER_CAPABILITY_ROUTING') === '0') return;
  try {
    const snapshot = loadProviderCapabilityRegistry({ forceRefresh: true });
    logger.info(
      `[reasoning-bootstrap] refreshed provider-capability-registry for selection (${snapshot.length} provider(s))`
    );
  } catch (error) {
    logger.warn(
      `[reasoning-bootstrap] provider-capability-registry refresh skipped (non-fatal): ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function buildReasoningRuntimeChain(
  selectedMode: ReasoningBackendMode,
  options: InstallReasoningOptions
): ReasoningRuntimeBundle[] {
  if (options.role || options.profile) {
    const initial = resolveReasoningRoute({
      role: options.role,
      requestedProfile: options.profile,
      sampling: options.samplingParams,
      requestedModel: options.model,
    });
    const candidates: ReasoningRuntimeBundle[] = [];
    const seen = new Set<string>();
    for (const profileRef of initial.candidates) {
      const route = resolveReasoningRoute({
        role: initial.role,
        requestedProfile: profileRef,
        sampling: options.samplingParams,
        requestedModel: options.model,
      });
      const candidateKey = `${route.profileRef}:${route.model || ''}`;
      if (seen.has(candidateKey)) continue;
      seen.add(candidateKey);
      const candidate = buildReasoningRuntimeBundle(
        normalizeReasoningBackendMode(route.mode as ReasoningBackendMode),
        {
          ...options,
          model: route.model?.includes(':')
            ? route.model.slice(route.model.indexOf(':') + 1)
            : route.model,
          samplingParams: route.parameters,
          toolsEnabled: route.toolsEnabled,
          allowedTools: route.allowedTools,
          contextWindowTokens: route.limits.contextWindowTokens ?? options.contextWindowTokens,
          maxCompletionTokens: route.limits.maxCompletionTokens ?? options.maxCompletionTokens,
        }
      );
      if (candidate) candidates.push(candidate);
    }
    return filterChainByProviderCapability(candidates);
  }
  const policy = loadReasoningBackendPolicy();
  const orderedModes = [selectedMode, ...policy.provider_fallback_order.map((entry) => entry.mode)];
  const seen = new Set<string>();
  const candidates: ReasoningRuntimeBundle[] = [];

  for (const mode of orderedModes) {
    const normalized = normalizeReasoningBackendModeFromPolicy(mode, policy);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const candidate = buildReasoningRuntimeBundle(normalized, options);
    if (candidate) candidates.push(candidate);
  }

  return filterChainByProviderCapability(candidates);
}

const REASONING_BACKEND_MODES: ReadonlySet<ReasoningBackendMode> = new Set(
  listReasoningProviderModes()
);

/**
 * GAP2: route the reasoning-backend selection through the Capability Broker so
 * its decision is audit-recorded and a per-mission *pin* is honored (the broker
 * exists for reproducible, audited provider selection but had no execution call
 * site). Conservative by design: the env/policy-resolved mode is authoritative;
 * the broker only OVERRIDES when a frozen pin names a usable reasoning mode.
 * Skipped in stub/offline mode and never fatal.
 */
export function consultCapabilityBrokerForMode(
  resolvedMode: ReasoningBackendMode
): ReasoningBackendMode {
  if (resolvedMode === 'stub') return resolvedMode;
  lastBrokerSelection = null;
  try {
    const decision = resolveProviderDecision({
      decisionKey: 'reasoning-backend',
      requiredCapabilities: ['reasoning'],
      record: true,
    });
    if (decision.pinned && REASONING_BACKEND_MODES.has(decision.provider as ReasoningBackendMode)) {
      if (decision.provider !== resolvedMode) {
        logger.info(
          `[reasoning-bootstrap] capability-broker pin overrides mode ${resolvedMode} → ${decision.provider}`
        );
      }
      lastBrokerSelection = {
        resolvedMode,
        provider: decision.provider,
        pinned: true,
      };
      return decision.provider as ReasoningBackendMode;
    }
    lastBrokerSelection = {
      resolvedMode,
      provider: decision.provider,
      pinned: false,
    };
  } catch (err) {
    logger.warn(
      `[reasoning-bootstrap] capability-broker consult skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return resolvedMode;
}

/**
 * Install a real reasoning + intent + voice backend. Returns true when a
 * non-stub mode installed; false when the stubs remain. Idempotent unless an
 * explicit provider refresh requests a re-selection.
 */
export function installReasoningBackends(options: InstallReasoningOptions = {}): boolean {
  const shouldReselect =
    options.refreshProviders === true ||
    kyberionEnv('KYBERION_PROVIDER_CAPABILITY_REFRESH') === '1';
  if (installed && !shouldReselect) return installedMode !== 'stub';
  if (shouldReselect) {
    installed = false;
    installedMode = null;
    // The bootstrap owns runtime reselection. Dispose the previous sole
    // providers before constructing the replacement chain.
    resetReasoningBackend();
    resetIntentExtractor();
    resetVoiceBridge();
  }
  const result = _installReasoningBackendsCore(options);
  // Python voice bridge must wrap the mode-specific bridge registered above.
  installPythonVoiceBridgeIfAvailable();
  return result;
}

/** Re-resolve provider availability and rebuild the reasoning chain in a long-lived process. */
export function reselectReasoningBackends(
  options: Omit<InstallReasoningOptions, 'refreshProviders'> = {}
): boolean {
  return installReasoningBackends({ ...options, refreshProviders: true });
}

/**
 * LC-08: a selected non-stub mode that ends up keeping stubs is a silent
 * degradation — every later getReasoningBackend() call serves fabricated
 * output. Persist a marker (read by baseline-check → needs_attention) and
 * notify the operator once. KYBERION_ALLOW_STUB_FALLBACK=1 restores the old
 * quiet behavior for environments where stub residency is intentional.
 */
function reportResidualStubDegradation(mode: string, reason: string): void {
  if (kyberionEnv('KYBERION_ALLOW_STUB_FALLBACK') === '1') return;
  markReasoningDegraded(mode, reason);
  void import('./operator-notifications.js')
    .then((m) =>
      m.notifyOperator('ops_alert', {
        title: 'Reasoning backend degraded to stub',
        body: `mode=${mode}: ${reason}. Run \`pnpm reasoning:setup\` — until then all LLM judgments are deterministic placeholders.`,
        correlation_id: 'reasoning-degraded',
      })
    )
    .catch(() => {});
}

function _installReasoningBackendsCore(options: InstallReasoningOptions): boolean {
  initializeAdapterDefaultPreferences();
  const effectiveOptions = applyOperatorLlmSelection(options);
  const mode = consultCapabilityBrokerForMode(resolveMode(effectiveOptions));
  refreshCapabilityRegistryIfRequested(effectiveOptions);

  // Common infrastructure (order matters: voice bridge runs after reasoning backend)
  const shellSttInstalled =
    installShellSpeechToTextBridgeIfAvailable() || installFluidAudioSpeechToTextBridgeIfAvailable();
  if (!shellSttInstalled) {
    // Fire-and-forget: on Apple Silicon macOS this upgrades the stub to
    // on-device transcription; elsewhere the probe declines instantly.
    // An explicit KYBERION_STT_COMMAND always wins (checked above).
    void installAppleSpeechToTextBridgeIfAvailable().catch(() => {});
  }
  const deployInstalled = installShellDeploymentAdapterIfAvailable();
  if (!deployInstalled) {
    installShellDeploymentAdapterFromConfigIfAvailable();
  }
  installAuditForwarderIfAvailable();
  installSecretResolverIfAvailable();
  // Embedding backend is independent of reasoning mode; install early.
  installEmbeddingBackendIfAvailable();

  if (mode === 'stub' && !options.force) {
    installed = true;
    installedMode = 'stub';
    logger.info('[reasoning-bootstrap] mode=stub — keeping deterministic stubs');
    clearReasoningDegraded();
    return false;
  }

  const chain = buildReasoningRuntimeChain(mode, effectiveOptions);
  if (chain.length === 0 && !options.force) {
    installed = true;
    installedMode = 'stub';
    logger.warn(
      `[reasoning-bootstrap] mode=${mode} selected but no usable reasoning backend could be built — keeping stubs.`
    );
    reportResidualStubDegradation(mode, 'no usable reasoning backend could be built');
    return false;
  }

  if (chain.length === 0) {
    installed = true;
    installedMode = 'stub';
    logger.warn(
      `[reasoning-bootstrap] mode=${mode} selected but no failover candidates were available — keeping stubs.`
    );
    reportResidualStubDegradation(mode, 'no failover candidates were available');
    return false;
  }

  const primaryMode = chain[0]!.mode;
  const brokerSelection = lastBrokerSelection;
  try {
    auditChain.record({
      agentId: process.env.MISSION_ROLE || 'reasoning-bootstrap',
      action: 'reasoning_runtime_selection',
      operation: `${primaryMode}/${chain[0]!.backend.label || primaryMode}`,
      result: 'completed',
      reason: brokerSelection
        ? brokerSelection.pinned
          ? 'pinned broker decision applied to runtime chain'
          : 'policy/env mode retained; unpinned broker decision recorded but not applied'
        : 'policy/env mode selected without a broker decision',
      metadata: {
        runtime_primary: primaryMode,
        runtime_candidates: chain.map((candidate) => candidate.mode),
        broker_provider: brokerSelection?.provider,
        broker_resolved_mode: brokerSelection?.resolvedMode,
        broker_pinned: brokerSelection?.pinned ?? false,
        broker_decision_used: Boolean(
          brokerSelection?.pinned && brokerSelection.provider === primaryMode
        ),
      },
    });
  } catch {
    // Selection telemetry must never prevent backend installation.
  }
  const governedFailoverPolicy = loadReasoningRoutePolicy().fallback;
  const defaultBackend = buildFailoverReasoningBackend(
    chain.map((candidate) => candidate.backend),
    governedFailoverPolicy
  );
  let activeBackend = defaultBackend;
  if (!options.role && !options.profile) {
    const roleBackends = new Map<string, ReturnType<typeof buildFailoverReasoningBackend>>();
    const profileBackends = new Map<string, ReturnType<typeof buildFailoverReasoningBackend>>();
    for (const role of Object.keys(loadReasoningRoutePolicy().roles)) {
      try {
        const roleChain = buildReasoningRuntimeChain(mode, { ...effectiveOptions, role });
        if (roleChain.length > 0)
          roleBackends.set(
            role,
            buildFailoverReasoningBackend(
              roleChain.map((candidate) => candidate.backend),
              governedFailoverPolicy
            )
          );
      } catch (error) {
        logger.warn(
          `[reasoning-bootstrap] role=${role} route unavailable; using default chain: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    for (const profile of Object.keys(loadReasoningRoutePolicy().profiles)) {
      try {
        const profileChain = buildReasoningRuntimeChain(mode, { ...effectiveOptions, profile });
        if (profileChain.length > 0)
          profileBackends.set(
            profile,
            buildFailoverReasoningBackend(
              profileChain.map((candidate) => candidate.backend),
              governedFailoverPolicy
            )
          );
      } catch (error) {
        logger.warn(
          `[reasoning-bootstrap] profile=${profile} route unavailable; skipping profile dispatch: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    activeBackend =
      roleBackends.size > 0 || profileBackends.size > 0
        ? buildRoleAwareReasoningBackend(defaultBackend, roleBackends, profileBackends)
        : defaultBackend;
  }
  const bindingReason = [
    lastModeSelectionReason,
    lastBrokerSelection
      ? `capability broker provider=${lastBrokerSelection.provider} pinned=${lastBrokerSelection.pinned}`
      : null,
  ]
    .filter(Boolean)
    .join('; ');
  registerReasoningBackend(activeBackend, {
    provenance: 'builtin',
    source: activeBackend.name,
    ...(bindingReason ? { reason: bindingReason } : {}),
  });
  const intentCandidates = chain.flatMap((candidate) =>
    candidate.intentExtractor ? [candidate.intentExtractor] : []
  );
  if (intentCandidates.length > 0) {
    registerIntentExtractor(buildFailoverIntentExtractor(intentCandidates));
  }
  const voiceCandidates = chain.flatMap((candidate) =>
    candidate.voiceBridge ? [candidate.voiceBridge] : []
  );
  if (voiceCandidates.length > 0) {
    registerVoiceBridge(buildFailoverVoiceBridge(voiceCandidates));
  }
  installed = true;
  installedMode = primaryMode;
  // LC-08 follow-up (found by loop simulation): CLI backends construct
  // without verifying their binary exists, so a machine with no CLIs and no
  // API keys still "installs" a chain that can only throw at first use —
  // and baseline-check would report all_clear. Detect the hollow chain at
  // install time: every candidate is CLI-backed and none of those CLIs is
  // discovered healthy. The chain stays installed (runtime behavior is
  // unchanged and loud); only the health reporting changes.
  const healthyProviders = new Set(
    discoverProviders(false)
      .filter((provider) => provider.installed && provider.healthy)
      .map((provider) => provider.provider)
  );
  // Only CLI-backed candidates can be probed via provider discovery; API-key /
  // URL-backed candidates (anthropic, openrouter, local, nemotron) only enter
  // the chain when their credential exists, so they count as usable.
  const CLI_PROBED_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'agy', 'grok', 'copilot']);
  const chainUsable = chain.some((candidate) => {
    const provider = providerForReasoningMode(candidate.mode);
    if (!provider || !CLI_PROBED_PROVIDERS.has(provider)) return true;
    if (provider === 'claude' && candidate.mode === 'claude-cli') return true;
    return healthyProviders.has(provider);
  });
  if (!chainUsable && kyberionEnv('KYBERION_ALLOW_STUB_FALLBACK') !== '1') {
    markReasoningDegraded(
      mode,
      `hollow chain: candidates [${chain.map((candidate) => candidate.mode).join(', ')}] are CLI-backed but no healthy CLI provider was discovered`
    );
    void import('./operator-notifications.js')
      .then((m) =>
        m.notifyOperator('ops_alert', {
          title: 'Reasoning chain installed but unusable',
          body: `mode=${mode}: the failover chain contains only CLI backends whose binaries are missing or unhealthy. The first real delegation will fail. Run \`pnpm reasoning:setup\`.`,
          correlation_id: 'reasoning-degraded',
        })
      )
      .catch(() => {});
  } else {
    clearReasoningDegraded();
  }
  logger.success(
    `[reasoning-bootstrap] mode=${mode} — reasoning failover chain installed (primary=${primaryMode}, candidates=${chain
      .map((candidate) => candidate.mode)
      .join(' -> ')})`
  );
  return true;
}

function shouldRefreshProviders(options: InstallReasoningOptions): boolean {
  return (
    options.refreshProviders === true || kyberionEnv('KYBERION_PROVIDER_DISCOVERY_REFRESH') === '1'
  );
}

/** @deprecated Use installReasoningBackends */
export function installAnthropicBackendsIfAvailable(
  options: InstallReasoningOptions = {}
): boolean {
  return installReasoningBackends(options);
}

/** Reset the installed flag. Used by tests; do not call from production code. */
export function resetReasoningBootstrap(): void {
  installed = false;
  installedMode = null;
  lastBrokerSelection = null;
  lastModeSelectionReason = null;
}

/** Which mode was selected on the last successful install, or null. */
export function getInstalledReasoningMode(): ReasoningBackendMode | null {
  return installedMode;
}
