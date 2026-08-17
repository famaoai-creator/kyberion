/** DH-04: governed provider module for hosted API reasoning runtimes. */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicIntentExtractor } from './anthropic-intent-extractor.js';
import { AnthropicReasoningBackend } from './anthropic-reasoning-backend.js';
import { AnthropicVoiceBridge } from './anthropic-voice-bridge.js';
import { buildGeminiApiBackendFromEnv } from './gemini-api-backend.js';
import { buildGrokApiBackendFromEnv } from './grok-api-backend.js';
import { buildOpenRouterBackendFromEnv } from './openrouter-backend.js';
import { maybeWrapWithDispatcher } from './agent-dispatch.js';
import type { ReasoningToolName, SamplingParams } from './reasoning-route-resolver.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import type { ReasoningProviderRuntimeBundle } from './reasoning-provider-registry.js';

export interface ApiProviderBuildOptions {
  mode: ReasoningBackendMode;
  provider?: string;
  model?: string;
  force?: boolean;
  anthropicClient?: Anthropic;
  samplingParams?: SamplingParams;
  toolsEnabled?: boolean;
  allowedTools?: ReasoningToolName[];
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns undefined for modes outside the hosted API family and null for a
 * governed API mode that cannot be built with the current credentials.
 */
export function buildApiProviderBundle(
  options: ApiProviderBuildOptions
): ReasoningProviderRuntimeBundle | null | undefined {
  const env = options.env ?? process.env;
  const { mode, provider } = options;

  switch (mode) {
    case 'anthropic': {
      if (!options.anthropicClient && !env.ANTHROPIC_API_KEY && !options.force) return null;
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
    case 'gemini-api': {
      const backend = buildGeminiApiBackendFromEnv(env, options.model, options.samplingParams);
      if (!backend) return null;
      return {
        mode,
        backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
      };
    }
    case 'grok-api': {
      const backend = buildGrokApiBackendFromEnv(env, {
        model: options.model,
        samplingParams: options.samplingParams,
        toolsEnabled: options.toolsEnabled,
        allowedTools: options.allowedTools,
      });
      if (!backend) return null;
      return {
        mode,
        backend: { backend, provider, label: mode },
      };
    }
    case 'openrouter': {
      const backend = buildOpenRouterBackendFromEnv(env, options.model, {
        toolsEnabled: options.toolsEnabled,
        allowedTools: options.allowedTools,
      });
      if (!backend) return null;
      return {
        mode,
        backend: { backend, provider, label: mode },
      };
    }
    default:
      return undefined;
  }
}
