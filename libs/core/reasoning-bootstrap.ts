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
 *                     OPENROUTER_API_KEY.
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
 *     KYBERION_LOCAL_LLM_URL / OPENROUTER_API_KEY are present, the first
 *     matching policy rule wins.
 *   - Otherwise → prefer `codex-cli` when a healthy Codex CLI is present,
 *     then `gemini-cli`, then `agy-cli`, with `claude-agent` only when
 *     explicitly selected.
 *
 * Override explicitly via env var to pin behavior:
 *   KYBERION_REASONING_BACKEND=codex-cli       (recommended in the Codex
 *                                                execution environment)
 *   KYBERION_REASONING_BACKEND=anthropic       (standalone with API key)
 *   KYBERION_REASONING_BACKEND=stub            (offline / testing)
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from './core.js';
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
import {
  OpenAiCompatibleBackend,
  buildOpenAiCompatibleBackendFromEnv,
  buildNemotronBackendFromEnv,
} from './openai-compatible-backend.js';
import {
  OpenRouterBackend,
  buildOpenRouterBackendFromEnv,
} from './openrouter-backend.js';
import { InSessionReasoningBackend } from './insession-reasoning-backend.js';
import { registerReasoningBackend } from './reasoning-backend.js';
import { registerIntentExtractor } from './intent-extractor.js';
import { registerVoiceBridge } from './voice-bridge.js';
import { installShellSpeechToTextBridgeIfAvailable } from './speech-to-text-bridge.js';
import { installShellDeploymentAdapterIfAvailable } from './deployment-adapter.js';
import { installAuditForwarderIfAvailable } from './audit-forwarder.js';
import { installSecretResolverIfAvailable } from './secret-resolver.js';
import { installPythonVoiceBridgeIfAvailable } from './python-voice-bridge.js';
import { installEmbeddingBackendIfAvailable } from './embedding-bootstrap.js';
import { discoverProviders } from './provider-discovery.js';
import {
  loadReasoningBackendPolicy,
  normalizeReasoningBackendMode as normalizeReasoningBackendModeFromPolicy,
  resolveReasoningBackendModeFromContext,
  type ReasoningBackendMode,
} from './reasoning-backend-policy.js';

export type { ReasoningBackendMode } from './reasoning-backend-policy.js';

let installed = false;
let installedMode: ReasoningBackendMode | null = null;

export function normalizeReasoningBackendMode(
  mode: ReasoningBackendMode,
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

function _installReasoningBackendsCore(options: InstallReasoningOptions): boolean {
  const mode = resolveMode(options);

  // Common infrastructure (order matters: voice bridge runs after reasoning backend)
  installShellSpeechToTextBridgeIfAvailable();
  installShellDeploymentAdapterIfAvailable();
  installAuditForwarderIfAvailable();
  installSecretResolverIfAvailable();
  // Embedding backend is independent of reasoning mode; install early.
  installEmbeddingBackendIfAvailable();

  if (mode === 'stub' && !options.force) {
    installed = true;
    installedMode = 'stub';
    logger.info('[reasoning-bootstrap] mode=stub — keeping deterministic stubs');
    return false;
  }

  if (mode === 'anthropic') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!options.anthropicClient && !key && !options.force) {
      logger.info(
        '[reasoning-bootstrap] mode=anthropic selected but ANTHROPIC_API_KEY unset — keeping stubs.',
      );
      installed = true;
      installedMode = 'stub';
      return false;
    }
    const client = options.anthropicClient ?? new Anthropic();
    registerReasoningBackend(new AnthropicReasoningBackend({ client, model: options.model }));
    registerIntentExtractor(new AnthropicIntentExtractor({ client, model: options.model }));
    registerVoiceBridge(new AnthropicVoiceBridge({ client, model: options.model }));
    installed = true;
    installedMode = 'anthropic';
    logger.success(
      `[reasoning-bootstrap] mode=anthropic — direct @anthropic-ai/sdk (model=${options.model ?? 'claude-opus-4-7'})`,
    );
    return true;
  }

  if (mode === 'claude-cli') {
    const cliBackend = buildShellClaudeCliBackendFromEnv();
    if (!cliBackend) {
      logger.warn(
        '[reasoning-bootstrap] mode=claude-cli selected but the Claude CLI is not usable — keeping stubs.',
      );
      installed = true;
      installedMode = 'stub';
      return false;
    }
    registerReasoningBackend(cliBackend);
    const claudeOptions = buildClaudeCliOptionsFromEnv();
    registerIntentExtractor(new ClaudeCliIntentExtractor(claudeOptions));
    registerVoiceBridge(new ClaudeCliVoiceBridge(claudeOptions));
    installed = true;
    installedMode = 'claude-cli';
    logger.success(
      `[reasoning-bootstrap] mode=claude-cli — shell claude CLI (model=${options.model ?? 'opus'})`,
    );
    return true;
  }

  if (mode === 'codex-cli') {
    const providers = discoverProviders(shouldRefreshProviders(options));
    const codexHealthy = providers.some((provider) => provider.provider === 'codex' && provider.installed && provider.healthy);
    if (!codexHealthy && !options.force) {
      logger.warn('[reasoning-bootstrap] mode=codex-cli selected but Codex CLI is not usable — keeping stubs.');
      installed = true;
      installedMode = 'stub';
      return false;
    }
    const codexOptions = buildCodexCliQueryOptionsFromEnv();
    const mergedCodexOptions = {
      ...codexOptions,
      ...(options.model ? { model: options.model } : {}),
    };
    registerReasoningBackend(new CodexCliReasoningBackend(mergedCodexOptions));
    registerIntentExtractor(new CodexCliIntentExtractor(mergedCodexOptions));
    registerVoiceBridge(new CodexCliVoiceBridge(mergedCodexOptions));
    installed = true;
    installedMode = 'codex-cli';
    logger.success(
      `[reasoning-bootstrap] mode=codex-cli — shell codex CLI (model=${mergedCodexOptions.model ?? 'gpt-5.4'})`,
    );
    return true;
  }

  if (mode === 'claude-agent') {
    registerReasoningBackend(new ClaudeAgentReasoningBackend({ model: options.model }));
    registerIntentExtractor(new ClaudeAgentIntentExtractor({ model: options.model }));
    registerVoiceBridge(new ClaudeAgentVoiceBridge({ model: options.model }));
    installed = true;
    installedMode = 'claude-agent';
    logger.success(
      `[reasoning-bootstrap] mode=claude-agent — @anthropic-ai/claude-agent-sdk sub-agent delegation (model=${options.model ?? 'opus'})`,
    );
    return true;
  }

  if (mode === 'gemini-cli') {
    const providers = discoverProviders(shouldRefreshProviders(options));
    const geminiHealthy = providers.some((provider) => provider.provider === 'gemini' && provider.installed && provider.healthy);
    if (!geminiHealthy && !options.force) {
      logger.warn('[reasoning-bootstrap] mode=gemini-cli selected but Gemini CLI is not usable — keeping stubs.');
      installed = true;
      installedMode = 'stub';
      return false;
    }
    const geminiBackend = buildGeminiCliBackendFromEnv(process.env, options.model);
    if (!geminiBackend) {
      installed = true;
      installedMode = 'stub';
      return false;
    }

    if (process.env.KYBERION_IN_SESSION_SUBAGENT === '1') {
      registerReasoningBackend(new InSessionReasoningBackend(geminiBackend));
      logger.success('[reasoning-bootstrap] ⚡ In-Session Subagent mode enabled');
    } else {
      registerReasoningBackend(geminiBackend);
    }
    const geminiOptions = {
      bin: process.env.KYBERION_GEMINI_CLI_BIN?.trim() || undefined,
      model: options.model ?? (process.env.KYBERION_GEMINI_CLI_MODEL?.trim() || undefined),
    };
    registerIntentExtractor(new GeminiCliIntentExtractor(geminiOptions));
    registerVoiceBridge(new GeminiCliVoiceBridge(geminiOptions));
    
    installed = true;
    installedMode = 'gemini-cli';
    logger.success(
      `[reasoning-bootstrap] mode=gemini-cli — shell gemini CLI (model=${options.model ?? 'gemini-2.0-flash-exp'})`,
    );
    return true;
  }

  if (mode === 'agy-cli') {
    const providers = discoverProviders(shouldRefreshProviders(options));
    const agyHealthy = providers.some((provider) => provider.provider === 'agy' && provider.installed && provider.healthy);
    if (!agyHealthy && !options.force) {
      logger.warn('[reasoning-bootstrap] mode=agy-cli selected but Agy CLI is not usable — keeping stubs.');
      installed = true;
      installedMode = 'stub';
      return false;
    }
    const agyBackend = buildAgyCliBackendFromEnv(process.env);
    if (!agyBackend) {
      installed = true;
      installedMode = 'stub';
      return false;
    }

    registerReasoningBackend(agyBackend);
    const agyOptions = {
      bin: (process.env.KYBERION_ANTIGRAVITY_CLI_BIN || process.env.KYBERION_AGY_CLI_BIN)?.trim() || undefined,
    };
    registerIntentExtractor(new AgyCliIntentExtractor(agyOptions));
    registerVoiceBridge(new AgyCliVoiceBridge(agyOptions));
    
    installed = true;
    installedMode = 'agy-cli';
    logger.success(
      `[reasoning-bootstrap] mode=agy-cli — shell agy CLI`
    );
    return true;
  }

  if (mode === 'local') {
    const localBackend = buildOpenAiCompatibleBackendFromEnv(process.env);
    if (!localBackend && !options.force) {
      logger.warn('[reasoning-bootstrap] mode=local selected but KYBERION_LOCAL_LLM_URL is unset — keeping stubs.');
      installed = true;
      installedMode = 'stub';
      return false;
    }
    const baseURL = process.env.KYBERION_LOCAL_LLM_URL || 'http://localhost:11434/v1';
    const apiKey = process.env.KYBERION_LOCAL_LLM_KEY || 'not-needed';
    const model = options.model || process.env.KYBERION_LOCAL_LLM_MODEL || 'llama3';
    registerReasoningBackend(new OpenAiCompatibleBackend({ baseURL, apiKey, model }));
    installed = true;
    installedMode = 'local';
    logger.success(
      `[reasoning-bootstrap] mode=local — OpenAI-compatible local server (${baseURL}, model=${model})`,
    );
    return true;
  }

  if (mode === 'nemotron-api') {
    const nemotronBackend = buildNemotronBackendFromEnv(process.env);
    if (!nemotronBackend && !options.force) {
      logger.warn('[reasoning-bootstrap] mode=nemotron-api selected but KYBERION_NEMOTRON_URL is unset — keeping stubs.');
      installed = true;
      installedMode = 'stub';
      return false;
    }
    const baseURL = process.env.KYBERION_NEMOTRON_URL || process.env.KYBERION_LOCAL_LLM_URL || 'http://localhost:11434/v1';
    const apiKey = process.env.KYBERION_NEMOTRON_KEY || process.env.KYBERION_LOCAL_LLM_KEY || 'not-needed';
    const model = options.model || process.env.KYBERION_NEMOTRON_MODEL || process.env.KYBERION_LOCAL_LLM_MODEL || 'nemotron';
    registerReasoningBackend(new OpenAiCompatibleBackend({ baseURL, apiKey, model }));
    installed = true;
    installedMode = 'nemotron-api';
    logger.success(
      `[reasoning-bootstrap] mode=nemotron-api — OpenAI-compatible Nemotron endpoint (${baseURL}, model=${model})`,
    );
    return true;
  }

  if (mode === 'openrouter') {
    const openrouterBackend = buildOpenRouterBackendFromEnv(process.env, options.model);
    if (!openrouterBackend && !options.force) {
      logger.warn('[reasoning-bootstrap] mode=openrouter selected but OPENROUTER_API_KEY is unset — keeping stubs.');
      installed = true;
      installedMode = 'stub';
      return false;
    }
    const apiKey = process.env.KYBERION_OPENROUTER_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim() || 'not-needed';
    const baseURL = process.env.KYBERION_OPENROUTER_URL?.trim();
    const model = options.model || process.env.KYBERION_OPENROUTER_MODEL?.trim() || 'meta-llama/llama-3-70b-instruct';
    registerReasoningBackend(
      openrouterBackend ?? new OpenRouterBackend({ baseURL, apiKey, model }),
    );
    installed = true;
    installedMode = 'openrouter';
    logger.success(
      `[reasoning-bootstrap] mode=openrouter — OpenRouter API backend (model=${model})`,
    );
    return true;
  }

  // Fallback / default
  installed = true;
  installedMode = 'stub';
  return false;
}

function shouldRefreshProviders(options: InstallReasoningOptions): boolean {
  return options.refreshProviders === true || process.env.KYBERION_PROVIDER_DISCOVERY_REFRESH === '1';
}

/** @deprecated Use installReasoningBackends */
export function installAnthropicBackendsIfAvailable(options: InstallReasoningOptions = {}): boolean {
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
