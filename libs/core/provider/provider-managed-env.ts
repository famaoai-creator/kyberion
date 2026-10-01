import * as path from 'node:path';
import { getRegisteredEnvText } from '../foundation/env.js';
import { pathResolver } from '../path-resolver.js';
import { resolveToolRuntimeRoot } from '../tool/tool-runtime-policy.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import { listCliReasoningProviderDescriptors } from '../reasoning/reasoning-provider-registry.js';

export interface ManagedProviderCliDefinition {
  provider: string;
  binary: string;
  env_key: string;
  npm_package?: string;
  brew_formula?: string;
  version_args: string[];
  install_hint: string;
}

/**
 * RS-01: managed provider CLIs are the descriptors with a `cli.install`
 * block (`reasoning-providers/*.json`), keyed by provider id. Binary, override
 * env key, version args and install metadata are declared there once.
 */
function managedDefinitions(): ManagedProviderCliDefinition[] {
  const byProvider = new Map<string, ManagedProviderCliDefinition>();
  for (const { provider, cli } of listCliReasoningProviderDescriptors()) {
    if (!cli.install || !cli.bin_env_key || byProvider.has(provider)) continue;
    byProvider.set(provider, {
      provider,
      binary: cli.binary,
      env_key: cli.bin_env_key,
      ...(cli.install.npm_package ? { npm_package: cli.install.npm_package } : {}),
      ...(cli.install.brew_formula ? { brew_formula: cli.install.brew_formula } : {}),
      version_args: [...cli.version_args],
      install_hint: cli.install.hint,
    });
  }
  return [...byProvider.values()];
}

export function listManagedProviderCliIds(): string[] {
  return managedDefinitions().map((definition) => definition.provider);
}

export function getManagedProviderCliDefinition(
  provider: string
): ManagedProviderCliDefinition | null {
  return managedDefinitions().find((definition) => definition.provider === provider) ?? null;
}

export function listManagedProviderCliDefinitions(): ManagedProviderCliDefinition[] {
  return managedDefinitions();
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
