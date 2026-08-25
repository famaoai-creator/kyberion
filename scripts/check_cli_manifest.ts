import { pathResolver, safeExistsSync } from '@agent/core';
import { defineCatalog } from '@agent/core/foundation';
import { defineScript, isDirectScript } from './lib/harness.js';

export interface CliEntrypoint {
  id: string;
  module: string;
  commands: string[];
}

export interface CliCommand {
  id: string;
  command: string;
  noun: string;
  verb: string;
  entry: string;
  audience: 'user' | 'operator' | 'dev';
}

export interface CliManifest {
  version: number;
  commands: CliCommand[];
  entrypoints: CliEntrypoint[];
}

const cliManifestCatalog = defineCatalog<CliManifest>({
  id: 'cli-commands',
  path: () => pathResolver.knowledge('product/governance/cli-commands.json'),
  schema: pathResolver.knowledge('product/schemas/cli-commands.schema.json'),
});

export function loadCliManifest(): CliManifest {
  return cliManifestCatalog.load();
}

export function checkCliManifest(manifest = loadCliManifest()): string[] {
  const failures: string[] = [];
  if (!Number.isInteger(manifest.version) || manifest.version < 1) {
    failures.push('version must be a positive integer');
  }
  if (!Array.isArray(manifest.entrypoints) || manifest.entrypoints.length === 0) {
    return [...failures, 'entrypoints must be a non-empty array'];
  }

  const ids = new Set<string>();
  const commands = new Map<string, string>();
  const commandIds = new Set<string>();
  const registeredCommands = new Set<string>();
  if (!Array.isArray(manifest.commands) || manifest.commands.length === 0) {
    failures.push('commands must be a non-empty command registry');
  } else {
    for (const command of manifest.commands) {
      if (!command.id || commandIds.has(command.id)) {
        failures.push(`command id must be unique: ${command.id || '<missing>'}`);
      }
      commandIds.add(command.id);
      registeredCommands.add(command.command);
      if (!command.noun || !command.verb || !command.entry) {
        failures.push(`command ${command.id || '<missing>'} must declare noun, verb, and entry`);
      }
      if (!['user', 'operator', 'dev'].includes(command.audience)) {
        failures.push(`command ${command.id || '<missing>'} has invalid audience`);
      }
    }
  }
  for (const entrypoint of manifest.entrypoints) {
    if (!entrypoint.id || ids.has(entrypoint.id)) {
      failures.push(`entrypoint id must be unique: ${entrypoint.id || '<missing>'}`);
    }
    ids.add(entrypoint.id);
    if (!entrypoint.module || !safeExistsSync(pathResolver.rootResolve(entrypoint.module))) {
      failures.push(`${entrypoint.id}: module does not exist: ${entrypoint.module}`);
    }
    if (!Array.isArray(entrypoint.commands) || entrypoint.commands.length === 0) {
      failures.push(`${entrypoint.id}: commands must be a non-empty array`);
      continue;
    }
    for (const command of entrypoint.commands) {
      if (command !== command.trim()) failures.push(`${entrypoint.id}: command is not trimmed`);
      const owner = commands.get(command);
      if (owner) failures.push(`command is claimed by multiple entrypoints: ${command}`);
      commands.set(command, entrypoint.id);
    }
  }
  for (const command of manifest.commands || []) {
    if (!ids.has(command.entry)) {
      failures.push(`command ${command.id} references missing entrypoint: ${command.entry}`);
    }
    if (commands.get(command.command) !== command.entry) {
      failures.push(`command registry route mismatch: ${command.command} -> ${command.entry}`);
    }
  }
  for (const [command] of commands) {
    if (!registeredCommands.has(command)) {
      failures.push(`entrypoint command missing registry entry: ${command}`);
    }
  }
  for (const required of ['operator-home', 'operator-cli']) {
    if (!ids.has(required)) failures.push(`required entrypoint is missing: ${required}`);
  }
  if (commands.get('') !== 'operator-home') {
    failures.push('empty command must route to operator-home');
  }
  return failures;
}

export const runCheckCliManifest = defineScript({
  name: 'check:cli-manifest',
  flags: [],
  run(context): void {
    const failures = checkCliManifest();
    if (failures.length > 0) {
      throw new Error(failures.join('; '));
    }
    context.print('[check:cli-manifest] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_cli_manifest.ts') ||
  isDirectScript(import.meta.url, 'check_cli_manifest.js')
)
  void runCheckCliManifest();
