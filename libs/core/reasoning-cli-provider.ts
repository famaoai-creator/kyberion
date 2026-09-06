/** DH-04: governed provider module for CLI/ACP reasoning runtimes. */

import { AgyCliIntentExtractor } from './agy-cli-intent-extractor.js';
import { AgyCliVoiceBridge } from './agy-cli-voice-bridge.js';
import { ClaudeAgentIntentExtractor } from './claude-agent-intent-extractor.js';
import { ClaudeAgentReasoningBackend } from './claude-agent-reasoning-backend.js';
import { ClaudeAgentVoiceBridge } from './claude-agent-voice-bridge.js';
import {
  buildClaudeCliOptionsFromEnv,
  buildShellClaudeCliBackendFromEnv,
} from './claude-cli-backend.js';
import { ClaudeCliIntentExtractor } from './claude-cli-intent-extractor.js';
import { ClaudeCliVoiceBridge } from './claude-cli-voice-bridge.js';
import { CodexCliIntentExtractor } from './codex-cli-intent-extractor.js';
import { CodexCliReasoningBackend } from './codex-cli-reasoning-backend.js';
import { CodexCliVoiceBridge } from './codex-cli-voice-bridge.js';
import { buildCodexCliQueryOptionsFromEnv } from './codex-cli-query.js';
import { buildGeminiCliBackendFromEnv } from './gemini-cli-backend.js';
import { GeminiCliIntentExtractor } from './gemini-cli-intent-extractor.js';
import { GeminiCliVoiceBridge } from './gemini-cli-voice-bridge.js';
import { buildAgyCliBackendFromEnv as buildAgyBackend } from './agy-cli-backend.js';
import {
  buildGrokCliOptionsFromEnv,
  buildShellGrokCliBackendFromEnv,
  GrokCliBackend,
} from './grok-cli-backend.js';
import { GrokCliIntentExtractor } from './grok-cli-intent-extractor.js';
import { GrokCliVoiceBridge } from './grok-cli-voice-bridge.js';
import { buildCopilotAcpBackendFromEnv } from './copilot-acp-reasoning-backend.js';
import { buildCursorCliBackendFromEnv } from './cursor-cli-reasoning-backend.js';
import { buildOpencodeCliBackendFromEnv } from './opencode-cli-reasoning-backend.js';
import { maybeWrapWithDispatcher } from './agent-dispatch.js';
import { getRegisteredEnvText } from './foundation/env.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import type { ReasoningProviderRuntimeBundle } from './reasoning-provider-registry.js';

export interface CliProviderBuildOptions {
  mode: ReasoningBackendMode;
  provider?: string;
  model?: string;
  force?: boolean;
  env?: NodeJS.ProcessEnv;
}

function cliEnv(options: CliProviderBuildOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function envText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return getRegisteredEnvText(name, { env });
}

/**
 * Returns undefined for non-CLI modes and null for a governed CLI mode that
 * cannot be built. This preserves the bootstrap's existing chain semantics.
 */
export function buildCliProviderBundle(
  options: CliProviderBuildOptions
): ReasoningProviderRuntimeBundle | null | undefined {
  const env = cliEnv(options);
  const { mode, provider } = options;

  switch (mode) {
    case 'claude-cli': {
      const backend = buildShellClaudeCliBackendFromEnv(env, undefined, options.model);
      if (!backend) return null;
      const cliOptions = {
        ...buildClaudeCliOptionsFromEnv(env),
        ...(options.model ? { model: options.model } : {}),
        bin: backend.getBinaryPath(),
      };
      return {
        mode,
        backend: { backend, provider, label: mode },
        intentExtractor: {
          extractor: new ClaudeCliIntentExtractor(cliOptions),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new ClaudeCliVoiceBridge(cliOptions),
          provider,
          label: mode,
        },
      };
    }
    case 'codex-cli': {
      const baseOptions = buildCodexCliQueryOptionsFromEnv(env);
      const codexOptions = {
        ...baseOptions,
        ...(options.model ? { model: options.model } : {}),
      };
      const backend = new CodexCliReasoningBackend(codexOptions);
      return {
        mode,
        backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
        intentExtractor: {
          extractor: new CodexCliIntentExtractor(codexOptions),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new CodexCliVoiceBridge(codexOptions),
          provider,
          label: mode,
        },
      };
    }
    case 'claude-agent': {
      if (!envText(env, 'CLAUDECODE') && !envText(env, 'ANTHROPIC_API_KEY') && !options.force) {
        return null;
      }
      return {
        mode,
        backend: {
          backend: maybeWrapWithDispatcher(
            new ClaudeAgentReasoningBackend({ model: options.model })
          ),
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
      const backend = buildGeminiCliBackendFromEnv(env, options.model);
      if (!backend && !options.force) return null;
      if (!backend) return null;
      const geminiOptions = {
        bin: envText(env, 'KYBERION_GEMINI_CLI_BIN')?.trim() || undefined,
        model: options.model ?? envText(env, 'KYBERION_GEMINI_CLI_MODEL')?.trim() ?? undefined,
      };
      return {
        mode,
        backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
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
      const backend = buildAgyBackend(env);
      if (!backend && !options.force) return null;
      if (!backend) return null;
      const agyOptions = {
        bin:
          envText(env, 'KYBERION_ANTIGRAVITY_CLI_BIN')?.trim() ||
          envText(env, 'KYBERION_AGY_CLI_BIN')?.trim() ||
          undefined,
      };
      return {
        mode,
        backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
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
    case 'grok-cli': {
      if (!buildShellGrokCliBackendFromEnv(env) && !options.force) return null;
      const grokOptions = {
        ...buildGrokCliOptionsFromEnv(env),
        ...(options.model ? { model: options.model } : {}),
      };
      const backend = new GrokCliBackend(grokOptions);
      return {
        mode,
        backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
        intentExtractor: {
          extractor: new GrokCliIntentExtractor(grokOptions),
          provider,
          label: mode,
        },
        voiceBridge: {
          bridge: new GrokCliVoiceBridge(grokOptions),
          provider,
          label: mode,
        },
      };
    }
    case 'copilot': {
      const backend = buildCopilotAcpBackendFromEnv(env, options.model);
      return {
        mode,
        backend: { backend, provider, label: mode },
      };
    }
    case 'cursor-cli': {
      const backend = buildCursorCliBackendFromEnv(env, undefined, options.model);
      if (!backend && !options.force) return null;
      if (!backend) return null;
      return {
        mode,
        backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
      };
    }
    case 'opencode-cli': {
      const backend = buildOpencodeCliBackendFromEnv(env, undefined, options.model);
      if (!backend && !options.force) return null;
      if (!backend) return null;
      return {
        mode,
        backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
      };
    }
    default:
      return undefined;
  }
}
