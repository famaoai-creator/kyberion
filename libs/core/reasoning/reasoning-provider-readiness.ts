/**
 * RS-01: registry-driven readiness probes for reasoning providers.
 *
 * Every probe is selected by the descriptor's `adapter` (and, for CLI
 * providers, its declared `cli.binary` / `cli.version_args` /
 * `cli.bin_env_key`), never by provider identity. A provider that reuses an
 * existing adapter therefore becomes probeable by adding its JSON descriptor.
 * An adapter without a probe fails closed with an operator-visible reason.
 */

import { getRegisteredEnvText } from '../foundation/env.js';
import { safeExec } from '../secure-io.js';
import { probeShellClaudeCliAvailability } from '../shell/shell-claude-cli-backend.js';
import { probeOpenAiCompatiblePresetAvailability } from '../provider/openai-compatible-backend.js';
import { probeOpenRouterBackendAvailability } from '../provider/openrouter-backend.js';
import { probeGeminiApiBackendAvailability } from '../provider/gemini-api-backend.js';
import { probeGrokApiBackendAvailability } from '../provider/grok-api-backend.js';
import { probeAnthropicApiBackendAvailability } from '../provider/anthropic-api-probe.js';
import type {
  ReasoningProviderAdapterId,
  ReasoningProviderCli,
  ReasoningProviderDescriptor,
} from './reasoning-provider-registry.js';
import { resolveReasoningProviderEnvironment } from './reasoning-provider-registry.js';

export interface ReasoningProviderReadiness {
  available: boolean;
  reason?: string;
}

export interface ReasoningProviderReadinessDeps {
  binaryProbe?: (command: string, args: readonly string[]) => boolean;
  claudeProbe?: () => ReasoningProviderReadiness;
  anthropicProbe?: (env: NodeJS.ProcessEnv) => Promise<ReasoningProviderReadiness>;
}

function defaultBinaryProbe(command: string, args: readonly string[]): boolean {
  try {
    safeExec(command, [...args], { timeoutMs: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/** Explicit operator override (`cli.bin_env_key`) wins over the declared binary. */
export function resolveReasoningProviderCliBinary(
  cli: ReasoningProviderCli,
  env: NodeJS.ProcessEnv = process.env
): string {
  return (
    (cli.bin_env_key ? getRegisteredEnvText(cli.bin_env_key, { env })?.trim() : undefined) ||
    cli.binary
  );
}

type AdapterProbe = (
  descriptor: ReasoningProviderDescriptor,
  env: NodeJS.ProcessEnv,
  deps: Required<ReasoningProviderReadinessDeps>
) => Promise<ReasoningProviderReadiness>;

function cliBinaryProbe(
  descriptor: ReasoningProviderDescriptor,
  env: NodeJS.ProcessEnv,
  deps: Required<ReasoningProviderReadinessDeps>
): ReasoningProviderReadiness {
  if (!descriptor.cli) {
    return { available: false, reason: `${descriptor.mode} declares no cli block` };
  }
  const binary = resolveReasoningProviderCliBinary(descriptor.cli, env);
  const args = descriptor.cli.version_args;
  return deps.binaryProbe(binary, args)
    ? { available: true }
    : { available: false, reason: `\`${[binary, ...args].join(' ')}\` failed` };
}

const ADAPTER_PROBES: Readonly<Record<ReasoningProviderAdapterId, AdapterProbe>> = {
  // claude-cli is a shell backend; an API key does not make the CLI
  // executable. Probe the selected runtime rather than short-circuiting on a
  // credential intended for the Agent/API mode.
  'claude-cli': async (_descriptor, _env, deps) => deps.claudeProbe(),
  'claude-agent-sdk': async (_descriptor, env, deps) =>
    getRegisteredEnvText('ANTHROPIC_API_KEY', { env })?.trim() ||
    getRegisteredEnvText('CLAUDE_API_KEY', { env })?.trim()
      ? { available: true }
      : deps.claudeProbe(),
  'provider-cli': async (descriptor, env, deps) => cliBinaryProbe(descriptor, env, deps),
  'anthropic-api': async (_descriptor, env, deps) => deps.anthropicProbe(env),
  'gemini-api': async (_descriptor, env) => probeGeminiApiBackendAvailability(env),
  'grok-api': async (_descriptor, env) => probeGrokApiBackendAvailability(env),
  'openrouter-api': async (_descriptor, env) => probeOpenRouterBackendAvailability(env),
  'openai-compatible': async (descriptor, env) =>
    descriptor.openai_compatible_preset
      ? probeOpenAiCompatiblePresetAvailability(descriptor.openai_compatible_preset, env)
      : { available: false, reason: `${descriptor.mode} declares no openai_compatible_preset` },
  stub: async () => ({
    available: false,
    reason: 'deterministic stub — placeholders only',
  }),
};

/** Probe one governed provider through its declared adapter. */
export async function probeReasoningProviderReadiness(
  descriptor: ReasoningProviderDescriptor,
  env: NodeJS.ProcessEnv = process.env,
  deps: ReasoningProviderReadinessDeps = {}
): Promise<ReasoningProviderReadiness> {
  const probe = ADAPTER_PROBES[descriptor.adapter];
  if (!probe) {
    return {
      available: false,
      reason: `no readiness probe for adapter ${descriptor.adapter} (${descriptor.mode})`,
    };
  }
  const resolvedDeps: Required<ReasoningProviderReadinessDeps> = {
    binaryProbe: deps.binaryProbe ?? defaultBinaryProbe,
    claudeProbe: deps.claudeProbe ?? (() => probeShellClaudeCliAvailability(env)),
    anthropicProbe:
      deps.anthropicProbe ?? ((selectedEnv) => probeAnthropicApiBackendAvailability(selectedEnv)),
  };
  const result = await probe(
    descriptor,
    resolveReasoningProviderEnvironment(descriptor, env),
    resolvedDeps
  );
  return result.available
    ? { available: true }
    : { available: false, reason: result.reason || `${descriptor.mode} readiness probe failed` };
}
