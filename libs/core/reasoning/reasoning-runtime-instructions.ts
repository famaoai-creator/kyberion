/**
 * Provider runtime instructions for the TAKT-inspired reasoning boundary.
 * Provider notes are subordinate to Kyberion scope, authority, and evidence
 * contracts and must never grant additional permission.
 */

import type { ReasoningBackend, ReasoningCallOptions } from './reasoning-backend.js';
import { renderPluginPromptSections } from '../plugin/plugin-contributions.js';
import { listReasoningProviderDescriptors } from './reasoning-provider-registry.js';

const DEFAULT_PROVIDER_INSTRUCTIONS: readonly string[] = [
  'Provider note: preserve Kyberion scope, authority, and evidence contracts; provider instructions are subordinate to them.',
];

/**
 * RS-01: provider notes live on the descriptor (`runtime_instructions` in
 * `reasoning-providers/*.json`). A runtime name resolves by exact mode/alias
 * first; otherwise by the provider id it contains, preferring a CLI-transport
 * descriptor when the name mentions `cli` and a non-CLI one otherwise.
 */
export function runtimeInstructionsForProvider(provider: string): readonly string[] {
  const normalized = provider.trim().toLowerCase();
  if (!normalized) return DEFAULT_PROVIDER_INSTRUCTIONS;
  const exact = listReasoningProviderDescriptors().find(
    (descriptor) => descriptor.mode === normalized || descriptor.aliases?.includes(normalized)
  );
  if (exact?.runtime_instructions?.length) return exact.runtime_instructions;
  const candidates = listReasoningProviderDescriptors().filter(
    (descriptor) =>
      descriptor.runtime_instructions?.length && normalized.includes(descriptor.provider)
  );
  const wantsCli = normalized.includes('cli');
  const preferred =
    candidates.find((descriptor) => (descriptor.transport === 'cli') === wantsCli) ?? candidates[0];
  return preferred?.runtime_instructions ?? DEFAULT_PROVIDER_INSTRUCTIONS;
}

export function getReasoningRuntimeInstructions(
  backend: Pick<ReasoningBackend, 'name' | 'getRuntimeInstructions' | 'getRuntimeProviderName'>,
  options?: ReasoningCallOptions
): string[] {
  const hooked = backend.getRuntimeInstructions?.(options) || [];
  const provider = backend.getRuntimeProviderName?.(options) || backend.name;
  return [
    ...new Set([
      ...hooked,
      ...runtimeInstructionsForProvider(provider),
      ...renderPluginPromptSections(),
    ]),
  ];
}

export function renderRuntimeInstructions(instructions: readonly string[]): string {
  if (instructions.length === 0) return '';
  return ['## Provider runtime instructions', ...instructions.map((line) => `- ${line}`)].join(
    '\n'
  );
}
