import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { pathResolver } from './path-resolver.js';
import { resolveToolRuntimeRoot } from './tool-runtime-policy.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';

export interface ManagedProviderCliDefinition {
  provider: string;
  binary: string;
  env_key: string;
  npm_package?: string;
  brew_formula?: string;
  version_args: string[];
  install_hint: string;
}

const DEFINITIONS: Readonly<Record<string, ManagedProviderCliDefinition>> = {
  codex: {
    provider: 'codex',
    binary: 'codex',
    env_key: 'KYBERION_CODEX_CLI_BIN',
    npm_package: '@openai/codex',
    brew_formula: 'codex',
    version_args: ['--version'],
    install_hint: 'npm install --prefix <managed-env> --no-save @openai/codex',
  },
  claude: {
    provider: 'claude',
    binary: 'claude',
    env_key: 'KYBERION_CLAUDE_CLI_BIN',
    npm_package: '@anthropic-ai/claude-code',
    version_args: ['--version'],
    install_hint: 'npm install --prefix <managed-env> --no-save @anthropic-ai/claude-code',
  },
  gemini: {
    provider: 'gemini',
    binary: 'gemini',
    env_key: 'KYBERION_GEMINI_CLI_BIN',
    npm_package: '@google/gemini-cli',
    brew_formula: 'gemini-cli',
    version_args: ['--version'],
    install_hint: 'npm install --prefix <managed-env> --no-save @google/gemini-cli',
  },
  agy: {
    provider: 'agy',
    binary: 'agy',
    env_key: 'KYBERION_AGY_CLI_BIN',
    brew_formula: 'antigravity-cli',
    version_args: ['--version'],
    install_hint: 'Use the official Antigravity installer, then set KYBERION_AGY_CLI_BIN.',
  },
  grok: {
    provider: 'grok',
    binary: 'grok',
    env_key: 'KYBERION_GROK_CLI_BIN',
    brew_formula: 'grok-build',
    version_args: ['--version'],
    install_hint: 'Install the official Grok Build CLI, then set KYBERION_GROK_CLI_BIN.',
  },
  cursor: {
    provider: 'cursor',
    binary: 'cursor-agent',
    env_key: 'KYBERION_CURSOR_CLI_BIN',
    brew_formula: 'cursor-cli',
    version_args: ['--version'],
    install_hint: 'Use the official Cursor installer, then set KYBERION_CURSOR_CLI_BIN.',
  },
  opencode: {
    provider: 'opencode',
    binary: 'opencode',
    env_key: 'KYBERION_OPENCODE_CLI_BIN',
    npm_package: 'opencode-ai',
    brew_formula: 'opencode',
    version_args: ['--version'],
    install_hint: 'npm install --prefix <managed-env> --no-save opencode-ai',
  },
  devin: {
    provider: 'devin',
    binary: 'devin',
    env_key: 'KYBERION_DEVIN_CLI_BIN',
    brew_formula: 'devin-cli',
    version_args: ['--version'],
    install_hint: 'Install the official Devin CLI, then set KYBERION_DEVIN_CLI_BIN.',
  },
};

export const MANAGED_PROVIDER_CLI_IDS = Object.freeze(Object.keys(DEFINITIONS));

export function getManagedProviderCliDefinition(
  provider: string
): ManagedProviderCliDefinition | null {
  return DEFINITIONS[provider] ?? null;
}

export function listManagedProviderCliDefinitions(): ManagedProviderCliDefinition[] {
  return MANAGED_PROVIDER_CLI_IDS.map((provider) => DEFINITIONS[provider]!);
}

export function resolveManagedProviderCliEnvPath(provider: string): string {
  const root = resolveToolRuntimeRoot();
  return assertSafeRepositoryPath(path.join(root, 'tool-runtimes', 'provider-cli', provider), {
    allowMissingLeaf: true,
  });
}

export function resolveManagedProviderCliBinary(provider: string): string | null {
  try {
    const definition = getManagedProviderCliDefinition(provider);
    if (!definition) return null;
    const candidate = path.join(
      resolveManagedProviderCliEnvPath(provider),
      'node_modules',
      '.bin',
      definition.binary
    );
    return safeExistsSync(candidate) ? candidate : null;
  } catch {
    // Provider discovery must remain usable in isolated test/read-only contexts
    // where the operator profile policy is intentionally unavailable.
    return null;
  }
}

/** Explicit operator configuration wins over an isolated managed CLI. */
export function resolveProviderCliCommand(provider: string): string {
  const definition = getManagedProviderCliDefinition(provider);
  if (!definition) return provider;
  return (
    getRegisteredEnvText(definition.env_key)?.trim() ||
    resolveManagedProviderCliBinary(provider) ||
    definition.binary
  );
}

export function providerCliManagedEnvRoot(): string {
  return pathResolver.rootResolve('active/shared/runtime/tool-runtimes/provider-cli');
}
