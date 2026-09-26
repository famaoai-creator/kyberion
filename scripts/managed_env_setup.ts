#!/usr/bin/env node

import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  getManagedProviderCliDefinition,
  listManagedProviderCliDefinitions,
  resolveManagedProviderCliBinary,
  resolveManagedProviderCliEnvPath,
  resolveProviderCliCommand,
} from '@agent/core/provider-managed-env';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { safeExecResult, safeMkdir } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Row = {
  provider: string;
  binary: string;
  source: 'managed' | 'brew' | 'configured' | 'path' | 'missing';
  installed: boolean;
  healthy: boolean;
  version: string | null;
  managed_env_path: string;
  installable: boolean;
  install_hint: string;
  upgrade_hint: string;
};

function userArgs(argv: readonly string[]): string[] {
  const args = [...argv];
  while (args.length && !args[0]!.startsWith('-')) args.shift();
  if (args[0] === '--') args.shift();
  return args;
}

function providerIds(provider?: string, providers?: string): string[] {
  if (providers?.trim())
    return providers
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  if (provider?.trim()) return [provider.trim()];
  return listManagedProviderCliDefinitions().map((entry) => entry.provider);
}

function inspectProvider(provider: string): Row {
  const definition = getManagedProviderCliDefinition(provider);
  if (!definition) throw new ScriptExitError(1, `Unknown provider '${provider}'. Use --list.`);
  const managed = resolveManagedProviderCliBinary(provider);
  const configured = getRegisteredEnvText(definition.env_key)?.trim();
  const command = resolveProviderCliCommand(provider);
  const which = safeExecResult('which', [command], { timeoutMs: 5_000, maxOutputMB: 1 });
  const brewPrefix = safeExecResult('brew', ['--prefix'], { timeoutMs: 5_000, maxOutputMB: 1 });
  const resolvedPath = which.status === 0 ? which.stdout.trim() : '';
  const source: Row['source'] = managed
    ? 'managed'
    : configured
      ? 'configured'
      : brewPrefix.status === 0 && resolvedPath.startsWith(brewPrefix.stdout.trim())
        ? 'brew'
        : command === definition.binary
          ? 'path'
          : 'configured';
  const probe = safeExecResult(command, definition.version_args, {
    cwd: process.cwd(),
    timeoutMs: 15_000,
    maxOutputMB: 2,
  });
  return {
    provider,
    binary: command,
    source: probe.status === 0 ? source : 'missing',
    installed: probe.status === 0,
    healthy: probe.status === 0,
    version: probe.status === 0 ? (probe.stdout || probe.stderr || '').trim() || null : null,
    managed_env_path: resolveManagedProviderCliEnvPath(provider),
    installable: Boolean(definition.npm_package),
    install_hint: definition.npm_package ? definition.install_hint : definition.install_hint,
    upgrade_hint:
      source === 'brew' && definition.brew_formula
        ? `brew upgrade ${definition.brew_formula}`
        : definition.install_hint,
  };
}

function installProvider(provider: string): Row {
  const definition = getManagedProviderCliDefinition(provider);
  if (!definition) throw new ScriptExitError(1, `Unknown provider '${provider}'. Use --list.`);
  if (!definition.npm_package) return inspectProvider(provider);
  const managedEnvPath = resolveManagedProviderCliEnvPath(provider);
  safeMkdir(path.join(managedEnvPath, 'node_modules'), { recursive: true });
  const result = safeExecResult(
    'npm',
    [
      'install',
      '--prefix',
      managedEnvPath,
      '--no-save',
      '--no-package-lock',
      definition.npm_package,
    ],
    { cwd: process.cwd(), timeoutMs: 600_000, maxOutputMB: 32 }
  );
  if (result.status !== 0) {
    throw new Error(
      `npm managed install failed for ${provider}: ${result.stderr || result.error?.message || 'unknown error'}`
    );
  }
  return inspectProvider(provider);
}

export const runManagedEnvSetup = defineScript({
  name: 'managed-env-setup',
  flags: [],
  async run(context) {
    const argv = createStandardYargs(['node', 'managed_env_setup', ...userArgs(context.argv)])
      .option('provider', { type: 'string', describe: 'Single provider id' })
      .option('providers', { type: 'string', describe: 'Comma-separated provider ids' })
      .option('apply', { type: 'boolean', default: false, describe: 'Install supported npm CLIs' })
      .option('list', {
        type: 'boolean',
        default: false,
        describe: 'List managed provider definitions',
      })
      .parseSync();

    if (argv.list) {
      context.print(JSON.stringify({ providers: listManagedProviderCliDefinitions() }, null, 2));
      return;
    }
    const rows = providerIds(argv.provider, argv.providers).map((provider) =>
      argv.apply ? installProvider(provider) : inspectProvider(provider)
    );
    context.print(JSON.stringify({ apply: Boolean(argv.apply), rows }, null, 2));
    if (rows.some((row) => !row.healthy)) {
      throw new ScriptExitError(2, 'One or more provider CLIs are unavailable.');
    }
  },
});

if (
  isDirectScript(import.meta.url, 'managed_env_setup.ts') ||
  isDirectScript(import.meta.url, 'managed_env_setup.js')
)
  void runManagedEnvSetup();
