import { pathResolver, safeExistsSync, safeReadFile } from '@agent/core';

export interface CliEntrypoint {
  id: string;
  module: string;
  commands: string[];
}

export interface CliManifest {
  version: number;
  entrypoints: CliEntrypoint[];
}

export function loadCliManifest(): CliManifest {
  return JSON.parse(
    String(
      safeReadFile(pathResolver.knowledge('product/governance/cli-commands.json'), {
        encoding: 'utf8',
      })
    )
  ) as CliManifest;
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
  for (const required of ['operator-home', 'operator-cli']) {
    if (!ids.has(required)) failures.push(`required entrypoint is missing: ${required}`);
  }
  if (commands.get('') !== 'operator-home') {
    failures.push('empty command must route to operator-home');
  }
  return failures;
}

export function main(): void {
  const failures = checkCliManifest();
  if (failures.length > 0) {
    console.error('[check:cli-manifest] FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('[check:cli-manifest] OK');
}

if (process.argv[1]?.endsWith('check_cli_manifest.ts')) main();
