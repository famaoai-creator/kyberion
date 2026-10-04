/** DH-04: governed provider module for hosted API reasoning runtimes. */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicIntentExtractor } from '../provider/anthropic-intent-extractor.js';
import { AnthropicReasoningBackend } from '../provider/anthropic-reasoning-backend.js';
import { AnthropicVoiceBridge } from '../provider/anthropic-voice-bridge.js';
import { buildGeminiApiBackendFromEnv } from '../provider/gemini-api-backend.js';
import { buildGrokApiBackendFromEnv } from '../provider/grok-api-backend.js';
import { buildOpenRouterBackendFromEnv } from '../provider/openrouter-backend.js';
import { maybeWrapWithDispatcher } from '../agent/agent-dispatch.js';
import type { ReasoningToolName, SamplingParams } from './reasoning-route-resolver.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import {
  getReasoningProviderDescriptor,
  resolveReasoningProviderEnvironment,
  type ReasoningProviderAdapterId,
  type ReasoningProviderRuntimeBundle,
} from './reasoning-provider-registry.js';

const API_PROVIDER_MODULE = './reasoning/reasoning-api-provider';

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

type ApiAdapterBuilder = (
  options: ApiProviderBuildOptions,
  env: NodeJS.ProcessEnv
) => ReasoningProviderRuntimeBundle | null;

/**
 * Hosted-API adapters, keyed by the descriptor's `adapter` id (RS-03). A new
 * provider on one of these protocols is a registry entry; a new protocol adds
 * one builder here.
 */
const API_ADAPTER_BUILDERS: Partial<Record<ReasoningProviderAdapterId, ApiAdapterBuilder>> = {
  'anthropic-api': (options, env) => {
    const { mode, provider } = options;
    if (!options.anthropicClient && !env.ANTHROPIC_API_KEY && !options.force) return null;
    const client =
      options.anthropicClient ??
      (env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }) : new Anthropic());
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
  },
  'gemini-api': (options, env) => {
    const { mode, provider } = options;
    const backend = buildGeminiApiBackendFromEnv(env, options.model, options.samplingParams);
    if (!backend) return null;
    return {
      mode,
      backend: { backend: maybeWrapWithDispatcher(backend), provider, label: mode },
    };
  },
  'grok-api': (options, env) => {
    const { mode, provider } = options;
    const backend = buildGrokApiBackendFromEnv(env, {
      model: options.model,
      samplingParams: options.samplingParams,
      toolsEnabled: options.toolsEnabled,
      allowedTools: options.allowedTools,
    });
    if (!backend) return null;
    return { mode, backend: { backend, provider, label: mode } };
  },
  'openrouter-api': (options, env) => {
    const { mode, provider } = options;
    const backend = buildOpenRouterBackendFromEnv(env, options.model, {
      toolsEnabled: options.toolsEnabled,
      allowedTools: options.allowedTools,
    });
    if (!backend) return null;
    return { mode, backend: { backend, provider, label: mode } };
  },
};

/**
 * Returns undefined for modes outside the hosted API family and null for a
 * governed API mode that cannot be built with the current credentials. A
 * mode governed by this module whose adapter has no builder fails closed
 * with an explicit unsupported error instead of silently building another
 * provider.
 */
export function buildApiProviderBundle(
  options: ApiProviderBuildOptions
): ReasoningProviderRuntimeBundle | null | undefined {
  const env = options.env ?? process.env;
  const descriptor = getReasoningProviderDescriptor(options.mode);
  if (!descriptor || descriptor.module !== API_PROVIDER_MODULE) return undefined;
  const builder = API_ADAPTER_BUILDERS[descriptor.adapter];
  if (!builder) {
    throw new Error(
      `[REASONING_API_ADAPTER_UNSUPPORTED] ${options.mode}: adapter ${descriptor.adapter} has no hosted-API builder`
    );
  }
  return builder(options, resolveReasoningProviderEnvironment(descriptor, env));
}
