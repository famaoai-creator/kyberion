import { pathResolver } from '@agent/core/path-resolver';
import { assertSafeRepositoryPath, safeExistsSync } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

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
  /** CU-03: vocabulary key (`cli` namespace) with the one-line en/ja summary. */
  description?: string;
  /** CU-03: task grouping for `kyberion --help`. */
  group?: CliCommandGroup;
  /** CU-03: vocabulary key for a caution line shown under the summary. */
  caution?: string;
  /** CU-09: how a scope is chosen — `--scope <id>` (flag) or `<command> <id>` (positional). */
  scope_selector?: CliScopeSelector;
  /** CU-09: scopes/areas that delegate to an existing registered command. */
  scopes?: CliCommandScope[];
}

export type CliScopeSelector = 'flag' | 'positional';

/** CU-09: one `doctor --scope <id>` / `setup <id>` route to an existing command. */
export interface CliCommandScope {
  id: string;
  /** Arguments of the registered command this scope delegates to. */
  routes_to: string[];
  /** Vocabulary key (`cli` namespace, `cli_scope_*`) with the en/ja summary. */
  description: string;
}

export type CliCommandGroup = 'start' | 'inspect' | 'operate' | 'dev';
export const CLI_COMMAND_GROUPS: readonly CliCommandGroup[] = [
  'start',
  'inspect',
  'operate',
  'dev',
];

export interface CliScriptCommand {
  id: string;
  script?: string;
  module?: string;
  args?: string[];
  command: string;
  noun: string;
  verb: string;
  audience: 'user' | 'operator' | 'dev';
  description?: string;
  group?: CliCommandGroup;
  caution?: string;
  /** CU-02: needs the operator's terminal (stdin/TTY); run with inherited stdio. */
  interactive?: boolean;
  /** CU-02: may run for minutes or forever; stream output, no router timeout. */
  long_running?: boolean;
  /** CU-01: the target handles `--help` itself before any side effect. */
  native_help?: boolean;
  /** CU-05: a `<noun> default` entry may share a governed command name only when it is the same target. */
  same_target_as?: string;
}

/** CU-05: renamed package scripts kept as warning aliases (outside the SX-05 ratchet). */
export interface CliDeprecatedScriptAlias {
  script: string;
  replaced_by: string;
}

/** CU-08: renamed `kyberion` commands kept as warning aliases by the router. */
export interface CliDeprecatedCommandAlias {
  command: string;
  replaced_by: string;
}

export interface CliManifest {
  version: number;
  commands: CliCommand[];
  entrypoints: CliEntrypoint[];
  script_commands?: CliScriptCommand[];
  deprecated_script_aliases?: CliDeprecatedScriptAlias[];
  deprecated_command_aliases?: CliDeprecatedCommandAlias[];
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
  /** Script bodies (name -> command line); enables the deprecated-alias body check. */
  packageScriptBodies?: Readonly<Record<string, string>>;
}

// Keep the ratchet explicit as governed operator entrypoints are added.
export const MAX_PACKAGE_SCRIPTS = 129;

export function resolveCliModulePath(module: string, allowMissingLeaf = false): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(module), { allowMissingLeaf });
}

function loadPackageScripts(): Record<string, string> {
  const packageJson = readSafeJsonFile<{ scripts?: Record<string, string> }>(
    pathResolver.rootResolve('package.json'),
    'package manifest for CLI manifest check'
  );
  return packageJson.scripts || {};
}

/**
 * CU-08 naming rule for package scripts (enforced here; explained in
 * knowledge/product/governance/kyberion-development-practices.md):
 *
 * - operator/user scripts are `noun` or `noun:verb` — lowercase kebab
 *   segments, at most one colon (`stance:create`, `knowledge:ingest`);
 * - the conventional toolchain families keep their verb-first shape:
 *   `build`, `test`, `lint`, `format`, `typecheck`, `check`, `generate`,
 *   `validate`, `verify`, `ci`, `prepare` (and their `<family>:<target>`);
 * - a non-toolchain name must not start with a verb (`report:*`, `migrate:*`,
 *   `export:*`, `watch:*`, `onboard`, `ingest` are the shapes this rejects).
 *
 * Renamed scripts stay as `deprecated_script_aliases` and are exempt.
 */
export const TOOLCHAIN_SCRIPT_FAMILIES: ReadonlySet<string> = new Set([
  'build',
  'test',
  'lint',
  'format',
  'typecheck',
  'check',
  'generate',
  'validate',
  'verify',
  'ci',
  'prepare',
]);

/** Leading words that mark a verb-first (non-noun) script name. */
export const SCRIPT_NAME_LEADING_VERBS: ReadonlySet<string> = new Set([
  'apply',
  'bootstrap',
  'create',
  'delete',
  'deploy',
  'export',
  'fetch',
  'import',
  'ingest',
  'init',
  'inspect',
  'install',
  'list',
  'migrate',
  'onboard',
  'open',
  'promote',
  'record',
  'register',
  'remove',
  'report',
  'reset',
  'run',
  'scan',
  'search',
  'setup',
  'show',
  'sign',
  'start',
  'stop',
  'switch',
  'sync',
  'uninstall',
  'update',
  'upgrade',
  'watch',
]);

const SCRIPT_NAME_SEGMENT = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

/** CU-08: why a package script name breaks the naming rule, or undefined when it conforms. */
export function scriptNameViolation(name: string): string | undefined {
  const segments = name.split(':');
  if (segments.length > 2) {
    return `package script ${name} has more than two segments; use noun:verb (e.g. agy:sdk-setup)`;
  }
  if (!segments.every((segment) => SCRIPT_NAME_SEGMENT.test(segment))) {
    return `package script ${name} must use lowercase kebab-case segments`;
  }
  const head = segments[0] as string;
  if (TOOLCHAIN_SCRIPT_FAMILIES.has(head)) return undefined;
  const leadingWord = head.split('-')[0] as string;
  if (SCRIPT_NAME_LEADING_VERBS.has(leadingWord)) {
    return `package script ${name} starts with a verb; name it noun:verb (e.g. ${segments[1] ?? 'thing'}:${leadingWord})`;
  }
  return undefined;
}

/** CU-08: an alias runs the deprecation notice, then exactly the replacement's command. */
export function expectedDeprecatedAliasBody(
  alias: CliDeprecatedScriptAlias,
  replacementBody: string
): string {
  return `node scripts/deprecated_script_alias.mjs ${alias.script} ${alias.replaced_by} && ${replacementBody}`;
}

/** CU-03: every entry carries a localized summary key and a help group. */
function checkPresentation(
  command: { audience: string; description?: string; group?: string; caution?: string },
  label: string,
  failures: string[]
): void {
  if (!command.description || !command.description.startsWith('cli_cmd_')) {
    failures.push(`${label} must declare a cli_cmd_* description vocabulary key`);
  }
  if (!command.group || !CLI_COMMAND_GROUPS.includes(command.group as CliCommandGroup)) {
    failures.push(`${label} must declare a help group (${CLI_COMMAND_GROUPS.join(', ')})`);
  } else if ((command.group === 'dev') !== (command.audience === 'dev')) {
    failures.push(`${label} must use the dev help group exactly when its audience is dev`);
  }
  if (command.caution !== undefined && !command.caution.startsWith('cli_caution_')) {
    failures.push(`${label} caution must be a cli_caution_* vocabulary key`);
  }
}

/**
 * CU-05: the router resolves governed commands first, so a script-backed
 * `<noun> default` with the same name is unreachable through `kyberion`.
 * Allow it only when it is explicitly declared as the same target.
 */
function checkGovernedShadowing(
  command: CliScriptCommand,
  governed: readonly CliCommand[],
  failures: string[]
): void {
  const routedName = command.command.endsWith(' default')
    ? command.command.slice(0, -' default'.length)
    : command.command;
  const shadow = governed.find((candidate) => candidate.command === routedName);
  if (command.same_target_as !== undefined) {
    const target = governed.find((candidate) => candidate.id === command.same_target_as);
    if (!target || target.command !== routedName) {
      failures.push(
        `script command ${command.id} same_target_as must name the governed command routed as "${routedName}"`
      );
    }
    return;
  }
  if (shadow) {
    failures.push(
      `script command ${command.id} is shadowed by governed command ${shadow.id} ("${routedName}"); rename it or declare same_target_as`
    );
  }
}

function checkDeprecatedScriptAliases(
  manifest: CliManifest,
  packageScripts: ReadonlySet<string>,
  failures: string[],
  bodies?: Readonly<Record<string, string>>
): Set<string> {
  const aliases = new Set<string>();
  const registered = new Set(
    (manifest.script_commands ?? []).map((command) => command.script).filter(Boolean)
  );
  for (const alias of manifest.deprecated_script_aliases ?? []) {
    if (!alias.script || aliases.has(alias.script)) {
      failures.push(`deprecated script alias must be unique: ${alias.script || '<missing>'}`);
    }
    aliases.add(alias.script);
    if (!packageScripts.has(alias.script)) {
      failures.push(`deprecated script alias references missing package script: ${alias.script}`);
    }
    if (!registered.has(alias.replaced_by)) {
      failures.push(
        `deprecated script alias ${alias.script} must point at a registered script: ${alias.replaced_by}`
      );
    }
    const replacementBody = bodies?.[alias.replaced_by];
    const aliasBody = bodies?.[alias.script];
    if (
      replacementBody !== undefined &&
      aliasBody !== undefined &&
      aliasBody !== expectedDeprecatedAliasBody(alias, replacementBody)
    ) {
      failures.push(
        `deprecated script alias ${alias.script} must run the notice then the ${alias.replaced_by} command unchanged: "${expectedDeprecatedAliasBody(alias, replacementBody)}"`
      );
    }
  }
  return aliases;
}

/** Every name an operator can type after `kyberion` (governed + script commands). */
function routableCommandNames(manifest: CliManifest): Set<string> {
  const names = new Set(manifest.commands.map((command) => command.command));
  for (const command of manifest.script_commands ?? []) {
    names.add(
      command.command.endsWith(' default')
        ? command.command.slice(0, -' default'.length)
        : command.command
    );
  }
  return names;
}

/** Longest registered command prefix (one or two tokens) of an argument list. */
function routedPrefix(args: readonly string[], names: ReadonlySet<string>): string | undefined {
  for (let length = Math.min(2, args.length); length >= 1; length -= 1) {
    const candidate = args.slice(0, length).join(' ');
    if (names.has(candidate)) return candidate;
  }
  return undefined;
}

/** CU-08: renamed kyberion commands must point at a routable command and never shadow one. */
function checkDeprecatedCommandAliases(manifest: CliManifest, failures: string[]): void {
  const names = routableCommandNames(manifest);
  const seen = new Set<string>();
  for (const alias of manifest.deprecated_command_aliases ?? []) {
    if (!alias.command || seen.has(alias.command)) {
      failures.push(`deprecated command alias must be unique: ${alias.command || '<missing>'}`);
    }
    seen.add(alias.command);
    if (names.has(alias.command)) {
      failures.push(`deprecated command alias shadows a registered command: ${alias.command}`);
    }
    if (!names.has(alias.replaced_by)) {
      failures.push(
        `deprecated command alias ${alias.command} must point at a registered command: ${alias.replaced_by}`
      );
    }
  }
}

/** CU-09: each scope delegates to an existing registered command, never to another scope. */
function checkCommandScopes(manifest: CliManifest, failures: string[]): void {
  const names = routableCommandNames(manifest);
  for (const command of manifest.commands) {
    if (command.scopes === undefined) {
      if (command.scope_selector !== undefined) {
        failures.push(`command ${command.id} declares scope_selector without scopes`);
      }
      continue;
    }
    if (command.scope_selector !== 'flag' && command.scope_selector !== 'positional') {
      failures.push(
        `command ${command.id} with scopes must declare scope_selector flag|positional`
      );
    }
    const ids = new Set<string>();
    for (const scope of command.scopes) {
      if (!scope.id || ids.has(scope.id)) {
        failures.push(`command ${command.id} scope id must be unique: ${scope.id || '<missing>'}`);
      }
      ids.add(scope.id);
      if (!scope.description || !scope.description.startsWith('cli_scope_')) {
        failures.push(`command ${command.id} scope ${scope.id} must declare a cli_scope_* key`);
      }
      const target = Array.isArray(scope.routes_to)
        ? routedPrefix(scope.routes_to, names)
        : undefined;
      if (!target) {
        failures.push(
          `command ${command.id} scope ${scope.id} must route to a registered command: ${(scope.routes_to || []).join(' ')}`
        );
      } else if (
        scope.routes_to.includes('--scope') ||
        (command.scope_selector === 'positional' && target === command.command)
      ) {
        // A positional scope routed back to its own command would loop.
        failures.push(`command ${command.id} scope ${scope.id} must not route to another scope`);
      }
    }
  }
}

function checkScriptCommands(
  manifest: CliManifest,
  packageScripts: ReadonlySet<string>,
  failures: string[],
  bodies?: Readonly<Record<string, string>>
): void {
  const aliasScripts = checkDeprecatedScriptAliases(manifest, packageScripts, failures, bodies);
  for (const script of packageScripts) {
    if (aliasScripts.has(script)) continue;
    const violation = scriptNameViolation(script);
    if (violation) failures.push(violation);
  }
  const ratchetedScripts = packageScripts.size - aliasScripts.size;
  if (ratchetedScripts > MAX_PACKAGE_SCRIPTS) {
    failures.push(
      `package scripts exceed the SX-05 ratchet: ${ratchetedScripts} > ${MAX_PACKAGE_SCRIPTS}`
    );
  }
  if (manifest.script_commands === undefined) return;
  if (!Array.isArray(manifest.script_commands) || manifest.script_commands.length === 0) {
    failures.push('script_commands must be a non-empty script command registry');
    return;
  }

  const ids = new Set<string>();
  const scripts = new Set<string>();
  const commands = new Set<string>();
  const registeredCommands = new Set(manifest.commands.map((command) => command.command));
  for (const command of manifest.script_commands) {
    if (!command.id || ids.has(command.id)) {
      failures.push(`script command id must be unique: ${command.id || '<missing>'}`);
    }
    ids.add(command.id);
    if (commands.has(command.command)) {
      failures.push(`script command must be unique: ${command.command || '<default>'}`);
    }
    commands.add(command.command);
    if (registeredCommands.has(command.command)) {
      failures.push(
        `script command collides with command registry: ${command.command || '<default>'}`
      );
    }
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
    if (command.module) {
      try {
        const modulePath = resolveCliModulePath(command.module, true);
        if (!safeExistsSync(modulePath)) {
          failures.push(`script command module does not exist: ${command.module}`);
        }
      } catch (error) {
        failures.push(
          `script command module path is invalid: ${command.module} (${error instanceof Error ? error.message : String(error)})`
        );
      }
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
    checkPresentation(command, `script command ${command.id || '<missing>'}`, failures);
    checkGovernedShadowing(command, manifest.commands, failures);
  }

  for (const script of packageScripts) {
    if (aliasScripts.has(script)) {
      if (scripts.has(script)) {
        failures.push(`deprecated script alias must not also be a script command: ${script}`);
      }
      continue;
    }
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
      checkPresentation(command, `command ${command.id || '<missing>'}`, failures);
    }
  }
  for (const entrypoint of manifest.entrypoints) {
    if (!entrypoint.id || ids.has(entrypoint.id)) {
      failures.push(`entrypoint id must be unique: ${entrypoint.id || '<missing>'}`);
    }
    ids.add(entrypoint.id);
    if (!entrypoint.module) {
      failures.push(`${entrypoint.id}: module does not exist: ${entrypoint.module}`);
    } else {
      try {
        const modulePath = resolveCliModulePath(entrypoint.module, true);
        if (!safeExistsSync(modulePath)) {
          failures.push(`${entrypoint.id}: module does not exist: ${entrypoint.module}`);
        }
      } catch (error) {
        failures.push(
          `${entrypoint.id}: module path is invalid: ${entrypoint.module} (${error instanceof Error ? error.message : String(error)})`
        );
      }
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
  const bodies = options.packageScripts ? options.packageScriptBodies : loadPackageScripts();
  checkScriptCommands(
    manifest,
    options.packageScripts || new Set(Object.keys(bodies || {})),
    failures,
    bodies
  );
  checkDeprecatedCommandAliases(manifest, failures);
  checkCommandScopes(manifest, failures);
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
