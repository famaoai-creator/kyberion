/** DH-04: provider-module family for OpenAI-compatible local runtimes. */

import { maybeWrapWithDispatcher } from './agent-dispatch.js';
import {
  buildLlamaCppBackendFromEnv,
  buildLmStudioBackendFromEnv,
  buildLocalAiBackendFromEnv,
  buildMlxBackendFromEnv,
  buildNemotronBackendFromEnv,
  buildOllamaBackendFromEnv,
  buildOpenAiCompatibleBackendFromEnv,
  buildVllmBackendFromEnv,
  type OpenAiCompatibleBackend,
  type OpenAiCompatibleBackendOverrides,
} from './openai-compatible-backend.js';
import type { ReasoningBackendCandidate } from './reasoning-backend.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import type { ReasoningProviderRuntimeBundle } from './reasoning-provider-registry.js';

export interface OpenAiCompatibleProviderBuildOptions {
  mode: ReasoningBackendMode;
  provider?: string;
  overrides: OpenAiCompatibleBackendOverrides;
  env?: NodeJS.ProcessEnv;
}

type Builder = (
  env: NodeJS.ProcessEnv,
  overrides: OpenAiCompatibleBackendOverrides
) => OpenAiCompatibleBackend | null;

const BUILDERS: Partial<Record<ReasoningBackendMode, Builder>> = {
  local: buildOpenAiCompatibleBackendFromEnv,
  ollama: buildOllamaBackendFromEnv,
  vllm: buildVllmBackendFromEnv,
  lmstudio: buildLmStudioBackendFromEnv,
  llamacpp: buildLlamaCppBackendFromEnv,
  mlx: buildMlxBackendFromEnv,
  localai: buildLocalAiBackendFromEnv,
  'nemotron-api': buildNemotronBackendFromEnv,
};

/**
 * Returns `undefined` for modes outside this provider module, while `null`
 * means this governed mode was recognized but its endpoint is unavailable.
 * That distinction lets the bootstrap retain its existing failover semantics.
 */
export function buildOpenAiCompatibleProviderBundle(
  options: OpenAiCompatibleProviderBuildOptions
): ReasoningProviderRuntimeBundle | null | undefined {
  const builder = BUILDERS[options.mode];
  if (!builder) return undefined;
  const backend = builder(options.env ?? process.env, options.overrides);
  if (!backend) return null;
  const candidate: ReasoningBackendCandidate = {
    backend: maybeWrapWithDispatcher(backend),
    provider: options.provider,
    label: options.mode,
  };
  return { mode: options.mode, backend: candidate };
}
