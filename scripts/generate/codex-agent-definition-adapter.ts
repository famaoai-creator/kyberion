/**
 * Codex custom-agent projection.
 *
 * Kyberion role definitions are provider-neutral. Codex CLI loads project
 * custom agents from `.codex/agents/<name>.toml`, so the translation lives at
 * this concrete boundary instead of leaking TOML or Codex-specific settings
 * into the shared capability registry.
 *
 * Codex custom-agent files use `sandbox_mode` as their provider-specific
 * capability boundary. The runtime permission matrix remains the enforcement
 * SSoT; the generated config reads its Codex projection from that matrix
 * instead of maintaining a second sandbox map here.
 */

import { resolveProviderPermissionArgs } from '@agent/core';

export type CodexAgentProfile = 'implementer' | 'explorer' | 'planner';

export type CodexSandboxMode = 'workspace-write' | 'read-only';

/** Resolve the Codex sandbox projection from the provider permission SSoT. */
export function resolveCodexSandboxMode(profile: CodexAgentProfile): CodexSandboxMode {
  const resolution = resolveProviderPermissionArgs(profile, 'codex');
  if (resolution.kind === 'refused') {
    throw new Error(`[CODEX_AGENT_PROFILE_REFUSED] ${resolution.reason}`);
  }

  if (resolution.args[0] !== '--sandbox') {
    throw new Error(
      `[CODEX_AGENT_PROFILE_INVALID] expected --sandbox projection for ${profile}, got ${resolution.args.join(' ')}`
    );
  }
  const mode = resolution.args[1];
  if (mode !== 'workspace-write' && mode !== 'read-only') {
    throw new Error(`[CODEX_AGENT_PROFILE_INVALID] unsupported Codex sandbox mode: ${mode}`);
  }
  return mode;
}

export interface CodexAgentDefinitionInput {
  readonly role: string;
  readonly description: string;
  readonly profile: CodexAgentProfile;
  readonly body: string;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Render a lossless, readable TOML multiline basic string. */
function tomlMultilineBasicString(value: string): string {
  const normalized = value.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('"""', '\\"""');
  return `"""\n${escaped}\n"""`;
}

/** Build a Codex CLI custom-agent definition from a provider-neutral body. */
export function buildCodexAgentDefinitionSource(input: CodexAgentDefinitionInput): string {
  const generatedHeader = [
    '# GENERATED FILE — DO NOT EDIT BY HAND.',
    '# Regenerate with: pnpm agents:generate',
    '# Check drift with: pnpm agents:generate -- --check',
    '# Projection: Codex CLI custom agent (`.codex/agents/<name>.toml`)',
    '# Source: Kyberion team-role, procedure, capability-profile, and working-principles SSoT',
    '# Adapter: scripts/codex-agent-definition-adapter.ts',
  ].join('\n');

  const sandboxMode = resolveCodexSandboxMode(input.profile);
  return [
    generatedHeader,
    '',
    `name = ${tomlString(input.role)}`,
    `description = ${tomlString(input.description)}`,
    `sandbox_mode = ${tomlString(sandboxMode)}`,
    `developer_instructions = ${tomlMultilineBasicString(input.body.trim())}`,
    '',
  ].join('\n');
}
