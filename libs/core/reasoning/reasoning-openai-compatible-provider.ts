/** DH-04: provider-module family for OpenAI-compatible local runtimes. */

import { maybeWrapWithDispatcher } from '../agent/agent-dispatch.js';
import {
  buildOpenAiCompatibleBackendForPreset,
  type OpenAiCompatibleBackendOverrides,
} from '../provider/openai-compatible-backend.js';
import { getReasoningProviderDescriptor } from './reasoning-provider-registry.js';
import type { ReasoningBackendCandidate } from './reasoning-backend.js';
import type { ReasoningBackendMode } from './reasoning-backend-policy.js';
import type { ReasoningProviderRuntimeBundle } from './reasoning-provider-registry.js';

export interface OpenAiCompatibleProviderBuildOptions {
  mode: ReasoningBackendMode;
  provider?: string;
  overrides: OpenAiCompatibleBackendOverrides;
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns `undefined` for modes outside this provider module, while `null`
 * means this governed mode was recognized but its endpoint is unavailable.
 * That distinction lets the bootstrap retain its existing failover semantics.
 */
export function buildOpenAiCompatibleProviderBundle(
  options: OpenAiCompatibleProviderBuildOptions
): ReasoningProviderRuntimeBundle | null | undefined {
  // RS-01: membership and env preset come from the governed descriptor
  // (`adapter: openai-compatible` + `openai_compatible_preset`).
  const descriptor = getReasoningProviderDescriptor(options.mode);
  if (descriptor?.adapter !== 'openai-compatible' || !descriptor.openai_compatible_preset) {
    return undefined;
  }
  const backend = buildOpenAiCompatibleBackendForPreset(
    descriptor.openai_compatible_preset,
    options.env ?? process.env,
    options.overrides
  );
  if (!backend) return null;
  const candidate: ReasoningBackendCandidate = {
    backend: maybeWrapWithDispatcher(backend),
    provider: options.provider,
    label: options.mode,
  };
  return { mode: options.mode, backend: candidate };
}
