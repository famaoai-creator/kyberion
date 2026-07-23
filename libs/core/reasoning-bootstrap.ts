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
 * `gemini-api` is kept as a deprecated alias and resolves to `gemini-cli`.
 * Kyberion does not maintain a separate Gemini API backend here; Gemini
 * auth is consumed through the CLI-backed adapter.
 *
 * Auto-selection when mode is unset:
 *   - If ANTHROPIC_API_KEY / GEMINI_API_KEY / KYBERION_NEMOTRON_URL /
 *     KYBERION_LOCAL_LLM_URL / OPENROUTER_API_KEY / KYBERION_OPENROUTER_KEY are present, the first
 *     matching policy rule wins.
 *   - OpenRouter model selection defaults to the zero-cost `openrouter/free`
 *     router. Pinned free models or paid models must be declared through the
 *     OpenRouter model policy; paid inference requires an explicit
 *     `KYBERION_OPENROUTER_COST_POLICY=paid-allowed` opt-in.
 *   - Otherwise → prefer `codex-cli` when a healthy Codex CLI is present,
 *     then `agy-cli`. The legacy `gemini-cli` adapter remains available for
 *     explicit / Enterprise configurations but is not auto-selected.
 *
 * Override explicitly via env var to pin behavior:
 *   KYBERION_REASONING_BACKEND=codex-cli       (recommended in the Codex
 *                                                execution environment)
 *   KYBERION_REASONING_BACKEND=anthropic       (standalone with API key)
 *   KYBERION_REASONING_BACKEND=stub            (offline / testing)
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './core.js';
import { clearReasoningDegraded, markReasoningDegraded } from './reasoning-degradation.js';
import { AnthropicReasoningBackend } from './anthropic-reasoning-backend.js';
import { AnthropicIntentExtractor } from './anthropic-intent-extractor.js';
import { AnthropicVoiceBridge } from './anthropic-voice-bridge.js';
import { ClaudeAgentReasoningBackend } from './claude-agent-reasoning-backend.js';
import { ClaudeAgentIntentExtractor } from './claude-agent-intent-extractor.js';
import { ClaudeAgentVoiceBridge } from './claude-agent-voice-bridge.js';
import { CodexCliReasoningBackend } from './codex-cli-reasoning-backend.js';
import { CodexCliIntentExtractor } from './codex-cli-intent-extractor.js';
import { CodexCliVoiceBridge } from './codex-cli-voice-bridge.js';
import { buildCodexCliQueryOptionsFromEnv } from './codex-cli-query.js';
import { buildGeminiCliBackendFromEnv } from './gemini-cli-backend.js';
import { GeminiCliIntentExtractor } from './gemini-cli-intent-extractor.js';
import { GeminiCliVoiceBridge } from './gemini-cli-voice-bridge.js';
import { buildClaudeCliOptionsFromEnv } from './claude-cli-backend.js';
import { buildShellClaudeCliBackendFromEnv } from './claude-cli-backend.js';
import { ClaudeCliIntentExtractor } from './claude-cli-intent-extractor.js';
import { ClaudeCliVoiceBridge } from './claude-cli-voice-bridge.js';
import { buildAgyCliBackendFromEnv } from './agy-cli-backend.js';
import { AgyCliIntentExtractor } from './agy-cli-intent-extractor.js';
import { AgyCliVoiceBridge } from './agy-cli-voice-bridge.js';
import { loadLlmSelectionPreferences } from './llm-selection-preferences.js';
import { initializeAdapterDefaultPreferences } from './adapter-default-selection.js';
import { buildCopilotAcpBackendFromEnv } from './copilot-acp-reasoning-backend.js';
import {
  buildOpenAiCompatibleBackendFromEnv,
  buildOllamaBackendFromEnv,
  buildVllmBackendFromEnv,
  buildLmStudioBackendFromEnv,
  buildLlamaCppBackendFromEnv,
  buildMlxBackendFromEnv,
  buildLocalAiBackendFromEnv,
  buildNemotronBackendFromEnv,
  type OpenAiCompatibleBackendOverrides,
} from './openai-compatible-backend.js';
import { buildOpenRouterBackendFromEnv } from './openrouter-backend.js';
import { maybeWrapWithDispatcher } from './agent-dispatch.js';
import {
  buildFailoverReasoningBackend,
  buildRoleAwareReasoningBackend,
  type ReasoningBackendCandidate,
  registerReasoningBackend,
} from './reasoning-backend.js';
import {
  buildFailoverIntentExtractor,
  type IntentExtractorCandidate,
  registerIntentExtractor,
} from './intent-extractor.js';
import {
  buildFailoverVoiceBridge,
  type VoiceBridgeCandidate,
  registerVoiceBridge,
} from './voice-bridge.js';
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
import { resolveProviderDecision } from './capability-broker.js';
import {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode as normalizeReasoningBackendModeFromPolicy,
  resolveReasoningBackendModeFromContext,
  type ReasoningBackendMode,
} from './reasoning-backend-policy.js';
import {
  loadReasoningRoutePolicy,
  resolveReasoningRoute,
  resolveSamplingParams,
  type SamplingParams,
} from './reasoning-route-resolver.js';

export type { ReasoningBackendMode } from './reasoning-backend-policy.js';

let installed = false;
let installedMode: ReasoningBackendMode | null = null;

export function normalizeReasoningBackendMode(
  mode: ReasoningBackendMode
): Exclude<ReasoningBackendMode, 'gemini-api'> {
  if (mode === 'gemini-api') {
    logger.warn('[reasoning-bootstrap] mode=gemini-api is deprecated; using gemini-cli instead.');
  }
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
  return resolveReasoningBackendModeFromContext({
    requestedMode: options.mode,
    env: process.env,
    providers: discoverProviders(shouldRefreshProviders(options)),
    policy: loadReasoningBackendPolicy(),
  }) as ReasoningBackendMode;
}

function applyOperatorLlmSelection(options: InstallReasoningOptions): InstallReasoningOptions {
  if (options.mode || process.env.KYBERION_REASONING_BACKEND) return options;
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
  switch (mode) {
    case 'claude-cli':
    case 'claude-agent':
      return 'claude';
    case 'codex-cli':
      return 'codex';
    case 'gemini-cli':
      return 'gemini';
    case 'agy-cli':
      return 'agy';
    case 'copilot':
      return 'copilot';
    case 'anthropic':
      return 'anthropic';
    case 'openrouter':
      return 'openrouter';
    case 'local':
      return 'local';
    case 'ollama':
      return 'ollama';
    case 'vllm':
      return 'vllm';
    case 'lmstudio':
      return 'lmstudio';
    case 'llamacpp':
      return 'llamacpp';
    case 'mlx':
      return 'mlx';
    case 'localai':
      return 'localai';
    case 'nemotron':
    case 'nemotron-api':
      return 'nemotron';
    case 'stub':
      return undefined;
  }
}

interface ReasoningRuntimeBundle {
  mode: ReasoningBackendMode;
  backend: ReasoningBackendCandidate;
  intentExtractor?: IntentExtractorCandidate;
  voiceBridge?: VoiceBridgeCandidate;
}

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
  const provider = providerForReasoningMode(mode);
  switch (mode) {
    case 'anthropic': {
      if (!options.anthropicClient && !process.env.ANTHROPIC_API_KEY && !options.force) {
        return null;
      }
      const client = options.anthropicClient ?? new Anthropic();
      return {
        mode,
        backend: {
          backend: new AnthropicReasoningBackend({ client, model: options.model }),
          provider,
          label: mode,
        },
        intentExtractor: {
          extractor: new AnthropicIntentExtractor({ client, model: options.model }),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new AnthropicVoiceBridge({ client, model: options.model }),
          provider,
          label: mode,
        },
      };
    }
    case 'claude-cli': {
      const cliBackend = buildShellClaudeCliBackendFromEnv();
      if (!cliBackend) return null;
      const claudeOptions = buildClaudeCliOptionsFromEnv();
      return {
        mode,
        backend: { backend: cliBackend, provider, label: mode },
        intentExtractor: {
          extractor: new ClaudeCliIntentExtractor(claudeOptions),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new ClaudeCliVoiceBridge(claudeOptions),
          provider,
          label: mode,
        },
      };
    }
    case 'codex-cli': {
      const codexOptions = buildCodexCliQueryOptionsFromEnv();
      const mergedCodexOptions = {
        ...codexOptions,
        ...(options.model ? { model: options.model } : {}),
      };
      return {
        mode,
        backend: {
          backend: new CodexCliReasoningBackend(mergedCodexOptions),
          provider,
          label: mode,
        },
        intentExtractor: {
          extractor: new CodexCliIntentExtractor(mergedCodexOptions),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new CodexCliVoiceBridge(mergedCodexOptions),
          provider,
          label: mode,
        },
      };
    }
    case 'claude-agent': {
      if (!process.env.CLAUDECODE && !process.env.ANTHROPIC_API_KEY && !options.force) return null;
      return {
        mode,
        backend: {
          backend: new ClaudeAgentReasoningBackend({ model: options.model }),
          provider,
          label: mode,
        },
        intentExtractor: {
          extractor: new ClaudeAgentIntentExtractor({ model: options.model }),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new ClaudeAgentVoiceBridge({ model: options.model }),
          provider,
          label: mode,
        },
      };
    }
    case 'gemini-cli': {
      const geminiBackend = buildGeminiCliBackendFromEnv(process.env, options.model);
      if (!geminiBackend && !options.force) return null;
      if (!geminiBackend) return null;
      const geminiOptions = {
        bin: process.env.KYBERION_GEMINI_CLI_BIN?.trim() || undefined,
        model: options.model ?? (process.env.KYBERION_GEMINI_CLI_MODEL?.trim() || undefined),
      };
      return {
        mode,
        backend: {
          backend: maybeWrapWithDispatcher(geminiBackend),
          provider,
          label: mode,
        },
        intentExtractor: {
          extractor: new GeminiCliIntentExtractor(geminiOptions),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new GeminiCliVoiceBridge(geminiOptions),
          provider,
          label: mode,
        },
      };
    }
    case 'agy-cli': {
      const agyBackend = buildAgyCliBackendFromEnv(process.env);
      if (!agyBackend && !options.force) return null;
      if (!agyBackend) return null;
      const agyOptions = {
        bin:
          (process.env.KYBERION_ANTIGRAVITY_CLI_BIN || process.env.KYBERION_AGY_CLI_BIN)?.trim() ||
          undefined,
      };
      return {
        mode,
        backend: { backend: agyBackend, provider, label: mode },
        intentExtractor: {
          extractor: new AgyCliIntentExtractor(agyOptions),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new AgyCliVoiceBridge(agyOptions),
          provider,
          label: mode,
        },
      };
    }
    case 'local': {
      const localBackend = buildOpenAiCompatibleBackendFromEnv(
        process.env,
        openAiOverrides(options, mode)
      );
      if (!localBackend && !options.force) return null;
      if (!localBackend) return null;
      return {
        mode,
        backend: {
          backend: localBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'ollama': {
      const ollamaBackend = buildOllamaBackendFromEnv(process.env, openAiOverrides(options, mode));
      if (!ollamaBackend && !options.force) return null;
      if (!ollamaBackend) return null;
      return {
        mode,
        backend: {
          backend: ollamaBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'vllm': {
      const vllmBackend = buildVllmBackendFromEnv(process.env, openAiOverrides(options, mode));
      if (!vllmBackend && !options.force) return null;
      if (!vllmBackend) return null;
      return {
        mode,
        backend: {
          backend: vllmBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'lmstudio': {
      const lmstudioBackend = buildLmStudioBackendFromEnv(
        process.env,
        openAiOverrides(options, mode)
      );
      if (!lmstudioBackend && !options.force) return null;
      if (!lmstudioBackend) return null;
      return {
        mode,
        backend: {
          backend: lmstudioBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'llamacpp': {
      const llamacppBackend = buildLlamaCppBackendFromEnv(
        process.env,
        openAiOverrides(options, mode)
      );
      if (!llamacppBackend && !options.force) return null;
      if (!llamacppBackend) return null;
      return {
        mode,
        backend: {
          backend: llamacppBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'mlx': {
      const mlxBackend = buildMlxBackendFromEnv(process.env, openAiOverrides(options, mode));
      if (!mlxBackend && !options.force) return null;
      if (!mlxBackend) return null;
      return {
        mode,
        backend: {
          backend: mlxBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'localai': {
      const localaiBackend = buildLocalAiBackendFromEnv(
        process.env,
        openAiOverrides(options, mode)
      );
      if (!localaiBackend && !options.force) return null;
      if (!localaiBackend) return null;
      return {
        mode,
        backend: {
          backend: localaiBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'nemotron-api': {
      const nemotronBackend = buildNemotronBackendFromEnv(
        process.env,
        openAiOverrides(options, mode)
      );
      if (!nemotronBackend && !options.force) return null;
      if (!nemotronBackend) return null;
      return {
        mode,
        backend: {
          backend: nemotronBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'copilot': {
      const copilotBackend = buildCopilotAcpBackendFromEnv(process.env, options.model);
      return {
        mode,
        backend: { backend: copilotBackend, provider, label: mode },
      };
    }
    case 'openrouter': {
      const openrouterBackend = buildOpenRouterBackendFromEnv(process.env, options.model, {
        toolsEnabled: options.toolsEnabled,
        allowedTools: options.allowedTools,
      });
      if (!openrouterBackend && !options.force) return null;
      if (!openrouterBackend) return null;
      return {
        mode,
        backend: {
          backend: openrouterBackend,
          provider,
          label: mode,
        },
      };
    }
    case 'stub':
      return null;
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
    return candidates;
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

  return candidates;
}

const REASONING_BACKEND_MODES: ReadonlySet<ReasoningBackendMode> = new Set<ReasoningBackendMode>([
  'claude-cli',
  'codex-cli',
  'claude-agent',
  'anthropic',
  'gemini-cli',
  'gemini-api',
  'agy-cli',
  'copilot',
  'local',
  'nemotron',
  'nemotron-api',
  'openrouter',
  'ollama',
  'vllm',
  'lmstudio',
  'llamacpp',
  'mlx',
  'localai',
  'stub',
]);

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
      return decision.provider as ReasoningBackendMode;
    }
  } catch (err) {
    logger.warn(
      `[reasoning-bootstrap] capability-broker consult skipped (non-fatal): ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return resolvedMode;
}

/**
 * Install a real reasoning + intent + voice backend. Returns true when a
 * non-stub mode installed; false when the stubs remain. Idempotent.
 */
export function installReasoningBackends(options: InstallReasoningOptions = {}): boolean {
  if (installed) return installedMode !== 'stub';
  const result = _installReasoningBackendsCore(options);
  // Python voice bridge must wrap the mode-specific bridge registered above.
  installPythonVoiceBridgeIfAvailable();
  return result;
}

/**
 * LC-08: a selected non-stub mode that ends up keeping stubs is a silent
 * degradation — every later getReasoningBackend() call serves fabricated
 * output. Persist a marker (read by baseline-check → needs_attention) and
 * notify the operator once. KYBERION_ALLOW_STUB_FALLBACK=1 restores the old
 * quiet behavior for environments where stub residency is intentional.
 */
function reportResidualStubDegradation(mode: string, reason: string): void {
  if (process.env.KYBERION_ALLOW_STUB_FALLBACK === '1') return;
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
  const governedFailoverPolicy = loadReasoningRoutePolicy().fallback;
  const defaultBackend = buildFailoverReasoningBackend(
    chain.map((candidate) => candidate.backend),
    governedFailoverPolicy
  );
  let activeBackend = defaultBackend;
  if (!options.role && !options.profile) {
    const roleBackends = new Map<string, ReturnType<typeof buildFailoverReasoningBackend>>();
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
    activeBackend =
      roleBackends.size > 0
        ? buildRoleAwareReasoningBackend(defaultBackend, roleBackends)
        : defaultBackend;
  }
  registerReasoningBackend(activeBackend);
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
  const CLI_PROBED_PROVIDERS = new Set(['claude', 'codex', 'gemini', 'agy', 'copilot']);
  const chainUsable = chain.some((candidate) => {
    const provider = providerForReasoningMode(candidate.mode);
    if (!provider || !CLI_PROBED_PROVIDERS.has(provider)) return true;
    return healthyProviders.has(provider);
  });
  if (!chainUsable && process.env.KYBERION_ALLOW_STUB_FALLBACK !== '1') {
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
    options.refreshProviders === true || process.env.KYBERION_PROVIDER_DISCOVERY_REFRESH === '1'
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
}

/** Which mode was selected on the last successful install, or null. */
export function getInstalledReasoningMode(): ReasoningBackendMode | null {
  return installedMode;
}
