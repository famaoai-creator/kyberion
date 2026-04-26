/**
 * Reasoning Bootstrap — installs a real reasoning / intent-extraction /
 * voice backend at startup based on the configured mode.
 *
 * Modes (selected by `KYBERION_REASONING_BACKEND` env var, or explicit
 * `options.mode`):
 *
 *   `claude-agent`  — use @anthropic-ai/claude-agent-sdk (sub-agent delegation,
 *                     CLI-harness coordination model). Auth inherits from the
 *                     parent Claude Code session if any.
 *   `anthropic`     — use @anthropic-ai/sdk directly. Requires ANTHROPIC_API_KEY.
 *   `stub`          — keep deterministic stubs. Offline/dev default.
 *
 * Auto-selection when mode is unset:
 *   - If ANTHROPIC_API_KEY is present → `anthropic`
 *   - Otherwise (including inside Claude Code without the key) → `claude-agent`
 *     is attempted; if the SDK can't authenticate at query time it will
 *     surface an error on first call rather than at bootstrap.
 *
 * Override explicitly via env var to pin behavior:
 *   KYBERION_REASONING_BACKEND=claude-agent    (recommended when running
 *                                                inside Claude Code)
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
import { buildShellClaudeCliBackendFromEnv } from './shell-claude-cli-backend.js';
import { registerReasoningBackend } from './reasoning-backend.js';
import { registerIntentExtractor } from './intent-extractor.js';
import { registerVoiceBridge } from './voice-bridge.js';
import { installShellSpeechToTextBridgeIfAvailable } from './speech-to-text-bridge.js';
import { installShellDeploymentAdapterIfAvailable } from './deployment-adapter.js';
import { installAuditForwarderIfAvailable } from './audit-forwarder.js';
import { installSecretResolverIfAvailable } from './secret-resolver.js';

export type ReasoningBackendMode =
  | 'claude-cli'
  | 'codex-cli'
  | 'claude-agent'
  | 'anthropic'
  | 'gemini-cli'
  | 'gemini-api'
  | 'stub';

let installed = false;
let installedMode: ReasoningBackendMode | null = null;

export interface InstallReasoningOptions {
  /** Explicit mode selection. Overrides KYBERION_REASONING_BACKEND env var. */
  mode?: ReasoningBackendMode;
  /** Override model for all three backends. Defaults to claude-opus-4-7 / 'opus' or gemini equivalent. */
  model?: string;
  /** Pre-built Anthropic client (applies only to `anthropic` mode). */
  anthropicClient?: Anthropic;
  /** Force install even if stub would be chosen otherwise (for tests). */
  force?: boolean;
}

/** @deprecated Use InstallReasoningOptions */
export type InstallAnthropicOptions = InstallReasoningOptions;

function resolveMode(options: InstallReasoningOptions): ReasoningBackendMode {
  if (options.mode) return options.mode;
  const envMode = process.env.KYBERION_REASONING_BACKEND as ReasoningBackendMode | undefined;
  const validModes: ReasoningBackendMode[] = [
    'claude-cli',
    'codex-cli',
    'claude-agent',
    'anthropic',
    'gemini-cli',
    'gemini-api',
    'stub',
  ];
  if (envMode && validModes.includes(envMode)) {
    return envMode;
  }
  // Auto-selection logic
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.GEMINI_API_KEY) return 'gemini-api';
  
  // Default to CLI-based backends if keys are missing
  return 'claude-cli';
}

/**
 * Install a real reasoning + intent + voice backend. Returns true when a
 * non-stub mode installed; false when the stubs remain. Idempotent.
 */
export function installReasoningBackends(options: InstallReasoningOptions = {}): boolean {
  if (installed) return installedMode !== 'stub';

  const mode = resolveMode(options);

  // Common infrastructure
  installShellSpeechToTextBridgeIfAvailable();
  installShellDeploymentAdapterIfAvailable();
  installAuditForwarderIfAvailable();
  installSecretResolverIfAvailable();

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
      installed = true;
      installedMode = 'stub';
      return false;
    }
    registerReasoningBackend(cliBackend);
    installed = true;
    installedMode = 'claude-cli';
    logger.success(
      `[reasoning-bootstrap] mode=claude-cli — shell claude CLI (model=${options.model ?? 'opus'})`,
    );
    return true;
  }

  if (mode === 'codex-cli') {
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
    const geminiBackend = buildGeminiCliBackendFromEnv(process.env, options.model);
    if (!geminiBackend) {
      installed = true;
      installedMode = 'stub';
      return false;
    }
    registerReasoningBackend(geminiBackend);
    installed = true;
    installedMode = 'gemini-cli';
    logger.success(
      `[reasoning-bootstrap] mode=gemini-cli — shell gemini CLI (model=${options.model ?? 'gemini-2.0-flash-exp'})`,
    );
    return true;
  }

  // Fallback / default
  installed = true;
  installedMode = 'stub';
  return false;
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
