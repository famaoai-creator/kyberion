import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { defineCatalog, readJson } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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

export interface CliScriptCommand {
  id: string;
  script?: string;
  module?: string;
  args?: string[];
  command: string;
  noun: string;
  verb: string;
  audience: 'user' | 'operator' | 'dev';
}

export interface CliManifest {
  version: number;
  commands: CliCommand[];
  entrypoints: CliEntrypoint[];
  script_commands?: CliScriptCommand[];
}

const cliManifestCatalog = defineCatalog<CliManifest>({
  id: 'cli-commands',
  path: () => pathResolver.knowledge('product/governance/cli-commands.json'),
  schema: pathResolver.knowledge('product/schemas/cli-commands.schema.json'),
});

export function loadCliManifest(): CliManifest {
  return cliManifestCatalog.load();
}

export interface CliManifestCheckOptions {
  packageScripts?: ReadonlySet<string>;
}

export const MAX_PACKAGE_SCRIPTS = 120;

function loadPackageScriptNames(): Set<string> {
  const packageJson = readJson<{ scripts?: Record<string, string> }>(
    pathResolver.rootResolve('package.json')
  );
  return new Set(Object.keys(packageJson.scripts || {}));
}

function checkScriptCommands(
  manifest: CliManifest,
  packageScripts: ReadonlySet<string>,
  failures: string[]
): void {
  if (packageScripts.size > MAX_PACKAGE_SCRIPTS) {
    failures.push(
      `package scripts exceed the SX-05 ratchet: ${packageScripts.size} > ${MAX_PACKAGE_SCRIPTS}`
    );
  }
  if (manifest.script_commands === undefined) return;
  if (!Array.isArray(manifest.script_commands) || manifest.script_commands.length === 0) {
    failures.push('script_commands must be a non-empty script command registry');
    return;
  }

  const ids = new Set<string>();
  const scripts = new Set<string>();
  for (const command of manifest.script_commands) {
    if (!command.id || ids.has(command.id)) {
      failures.push(`script command id must be unique: ${command.id || '<missing>'}`);
    }
    ids.add(command.id);
    if ((!command.script && !command.module) || (command.script && command.module)) {
      failures.push(
        `script command must declare exactly one of script or module: ${command.id || '<missing>'}`
      );
    }
    if (command.script && scripts.has(command.script)) {
      failures.push(`script command must be unique: ${command.script}`);
    }
    if (command.script) {
      scripts.add(command.script);
    }
    if (command.module && !safeExistsSync(pathResolver.rootResolve(command.module))) {
      failures.push(`script command module does not exist: ${command.module}`);
    }
    if (command.args && !Array.isArray(command.args)) {
      failures.push(`script command args must be an array: ${command.id || '<missing>'}`);
    }
    if (!command.command || !command.noun || !command.verb) {
      failures.push(
        `script command ${command.id || '<missing>'} must declare command, noun, and verb`
      );
    }
    if (!['user', 'operator', 'dev'].includes(command.audience)) {
      failures.push(`script command ${command.id || '<missing>'} has invalid audience`);
    }
    if (command.script && !packageScripts.has(command.script)) {
      failures.push(`script command references missing package script: ${command.script}`);
    }
    const expectedCommand = `${command.noun} ${command.verb}`.trim();
    if (command.command !== expectedCommand) {
      failures.push(`script command noun/verb mismatch: ${command.script} -> ${command.command}`);
    }
  }

  for (const script of packageScripts) {
    if (!scripts.has(script)) {
      failures.push(`package script missing command registry entry: ${script}`);
    }
  }
}

export function checkCliManifest(
  manifest = loadCliManifest(),
  options: CliManifestCheckOptions = {}
): string[] {
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
      if (registeredCommands.has(command.command)) {
        failures.push(`command must be unique: ${command.command || '<default>'}`);
      }
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
  checkScriptCommands(manifest, options.packageScripts || loadPackageScriptNames(), failures);
  return failures;
}

export const runCheckCliManifest = defineScript({
  name: 'check:cli-manifest',
  flags: [],
  run(context): void {
    const failures = checkCliManifest();
    if (failures.length > 0) {
      throw new ScriptExitError(1, failures.map((failure) => `- ${failure}`).join('\n'));
    }
    context.print('[check:cli-manifest] OK');
  },
});

if (
  isDirectScript(import.meta.url, 'check_cli_manifest.ts') ||
  isDirectScript(import.meta.url, 'check_cli_manifest.js')
)
  void runCheckCliManifest();
