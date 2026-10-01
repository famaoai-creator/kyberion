#!/usr/bin/env node
import { validateStartupEnv } from '@agent/core/env-validator';
import { logger } from '@agent/core/core';
import {
  loadCliManifest,
  resolveCliModulePath,
  type CliCommand,
  type CliManifest,
  type CliScriptCommand,
} from './check_cli_manifest.js';
import { assertGovernedExec, buildSafeExecEnv, safeExecResultAsync } from '@agent/core/secure-io';
import { constants as osConstants } from 'node:os';
import { spawnManagedProcess } from '@agent/core/managed-process';
import { pathResolver } from '@agent/core/path-resolver';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import { resolveLocale, type SupportedLocale } from '@agent/core/locale';
import { t } from '@agent/core/t';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { hasHelpFlag } from './lib/cli-guard.js';
import {
  describeRegisteredCommand,
  formatCliManifestHelp,
  formatUnknownCommand,
  routedCommandName,
} from './lib/cli-help.js';
import {
  findDeprecatedCommandAlias,
  formatScopeHelp,
  formatUnknownScope,
  rewriteDeprecatedCommand,
  routeScopedCommand,
} from './lib/cli-scopes.js';

export { formatCliManifestHelp, formatUnknownCommand } from './lib/cli-help.js';

interface CliEntrypoint {
  id: string;
  module: string;
  commands: string[];
}

function findUniqueCommand(
  command: string,
  manifest: ReturnType<typeof loadCliManifest>
): CliCommand | undefined {
  const matches = manifest.commands.filter((candidate) => candidate.command === command);
  if (matches.length > 1) {
    throw new Error(`CLI command registry has duplicate command: ${command || '<default>'}`);
  }
  return matches[0];
}

function findUniqueScriptCommand(
  command: string,
  manifest: CliManifest
): CliScriptCommand | undefined {
  const scriptCommands = manifest.script_commands || [];
  const exactMatches = scriptCommands.filter((candidate) => candidate.command === command);
  const matches =
    exactMatches.length > 0 || command.includes(' ')
      ? exactMatches
      : scriptCommands.filter((candidate) => candidate.command === `${command} default`);
  if (matches.length > 1) {
    throw new Error(`CLI script command registry has duplicate command: ${command}`);
  }
  return matches[0];
}

export function selectEntrypoint(command: string, manifest = loadCliManifest()): CliEntrypoint {
  const registered = findUniqueCommand(command, manifest);
  if (!registered) throw new Error(`Unknown kyberion command: ${command}`);
  const entrypoint = manifest.entrypoints.find((candidate) => candidate.id === registered.entry);
  if (!entrypoint) {
    throw new Error(
      `CLI command ${command || '<default>'} references missing entrypoint: ${registered.entry}`
    );
  }
  if (!entrypoint.commands.includes(command)) {
    throw new Error(
      `CLI command registry mismatch: ${command || '<default>'} -> ${registered.entry}`
    );
  }
  return entrypoint;
}

export function resolveCommand(
  command: string,
  manifest = loadCliManifest()
): CliCommand | undefined {
  return findUniqueCommand(command, manifest);
}

/** Resolve the longest governed noun/verb prefix without consuming payload args. */
export function resolveCommandPath(args: string[], manifest = loadCliManifest()): string {
  for (let length = Math.min(2, args.length); length >= 1; length -= 1) {
    const candidate = args.slice(0, length).join(' ');
    if (
      findUniqueCommand(candidate, manifest) ||
      findUniqueScriptCommand(candidate, manifest) ||
      findDeprecatedCommandAlias(candidate, manifest)
    ) {
      return candidate;
    }
  }
  return args[0] ?? '';
}

export function resolveScriptCommand(
  command: string,
  manifest = loadCliManifest()
): CliScriptCommand | undefined {
  return findUniqueScriptCommand(command, manifest);
}

async function runScriptCommand(
  command: string,
  args: string[],
  manifest: CliManifest,
  print: (value: unknown) => void
): Promise<void> {
  const scriptCommand = resolveScriptCommand(command, manifest);
  if (!scriptCommand) {
    // Show what the operator typed (up to noun + verb), not just the first token.
    const typed = args
      .slice(0, 2)
      .filter((arg) => !arg.startsWith('-'))
      .join(' ');
    throw new ScriptExitError(1, formatUnknownCommand(typed || command, manifest));
  }
  if (scriptCommand.script === 'kyberion') {
    throw new Error('The kyberion package script cannot dispatch itself');
  }
  const commandArgs = args.slice(command.split(' ').length);
  // CU-01: a target without its own guarded --help never runs for --help.
  if (hasHelpFlag(commandArgs) && !scriptCommand.native_help) {
    print(formatGuardedScriptHelp(scriptCommand));
    return;
  }
  const childArgs = scriptCommand.module
    ? [
        '--import',
        pathResolver.rootResolve('scripts/ts-loader.mjs'),
        resolveCliModulePath(scriptCommand.module),
        ...(scriptCommand.args || []),
        ...commandArgs,
      ]
    : ['run', scriptCommand.script!, ...commandArgs];
  const childCommand = scriptCommand.module ? process.execPath : pnpmExecutable();
  const credentialEnv =
    scriptCommand.id === 'script.pr.create' &&
    scriptCommand.module === 'scripts/publish_pull_request.ts'
      ? {
          GH_TOKEN: getRegisteredEnvText('GH_TOKEN'),
          GITHUB_TOKEN: getRegisteredEnvText('GITHUB_TOKEN'),
        }
      : {};
  // CU-02: terminals, servers, daemons, and multi-minute jobs get the
  // operator's terminal and no router timeout instead of a buffered 2-minute run.
  if (scriptCommand.interactive || scriptCommand.long_running) {
    await runStreamingScriptCommand(
      childCommand,
      childArgs,
      scriptCommand.id,
      raiseSignalOnSelf,
      credentialEnv
    );
    return;
  }
  const result = scriptCommand.module
    ? await safeExecResultAsync(
        process.execPath,
        [
          '--import',
          pathResolver.rootResolve('scripts/ts-loader.mjs'),
          resolveCliModulePath(scriptCommand.module),
          ...(scriptCommand.args || []),
          ...commandArgs,
        ],
        { cwd: pathResolver.rootDir(), timeoutMs: 120_000, env: credentialEnv }
      )
    : await safeExecResultAsync(pnpmExecutable(), ['run', scriptCommand.script!, ...commandArgs], {
        cwd: pathResolver.rootDir(),
        timeoutMs: 120_000,
        env: credentialEnv,
      });
  if (result.stdout.trim()) print(result.stdout.trim());
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || 'script command failed';
    throw new ScriptExitError(result.status || 1, detail);
  }
}

function formatGuardedScriptHelp(scriptCommand: CliScriptCommand): string {
  const routed = routedCommandName(scriptCommand.command);
  return [
    t('cli:cli_guard_usage', { usage: `pnpm kyberion ${routed} [arguments]` }),
    '',
    ...describeRegisteredCommand(scriptCommand).map((line) => `  ${line}`),
    '',
    t('cli:cli_guard_help_only', { command: routed }),
  ].join('\n');
}

/** The pnpm launcher for this platform (Windows ships a `pnpm.cmd` shim, not `pnpm`). */
export function pnpmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

/**
 * The operator's own `KYBERION_*` configuration (locale, backend, tier, ...)
 * must reach a streamed child like any `pnpm run` invocation; everything else
 * is dropped by the secure-io env allowlist.
 */
function kyberionConfigEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0].startsWith('KYBERION_') && entry[1] !== undefined
    )
  );
}

/** Re-raise a signal on this process once its handlers are restored, so the parent sees a signal death. */
function raiseSignalOnSelf(signal: NodeJS.Signals): void {
  process.kill(process.pid, signal);
}

/**
 * Run a script command attached to the operator terminal (inherited stdio, no
 * timeout). The spawn goes through the same exec policy as the buffered path
 * (shell-script, sensitive-text and execute_command checks, allowlisted env).
 */
export async function runStreamingScriptCommand(
  command: string,
  args: string[],
  commandId: string,
  raiseSignal: (signal: NodeJS.Signals) => void = raiseSignalOnSelf,
  credentialEnv: Record<string, string | undefined> = {}
): Promise<void> {
  assertGovernedExec(command, args);
  const { child } = spawnManagedProcess({
    resourceId: `kyberion-cli:${commandId}:${Date.now().toString(36)}`,
    kind: 'service',
    ownerId: 'kyberion-cli',
    ownerType: 'script',
    command,
    args,
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      env: buildSafeExecEnv({ ...kyberionConfigEnv(), ...credentialEnv }),
      stdio: 'inherit',
    },
    metadata: { source: 'kyberion-cli', commandId },
  });
  // Ctrl-C reaches the child through the shared terminal; the router stays
  // alive until the child has finished its own shutdown. SIGTERM and SIGHUP
  // (terminal closed) are forwarded.
  const ignoreInterrupt = (): void => undefined;
  const forwardTerminate = (): void => {
    child.kill('SIGTERM');
  };
  const forwardHangup = (): void => {
    child.kill('SIGHUP');
  };
  process.on('SIGINT', ignoreInterrupt);
  process.on('SIGTERM', forwardTerminate);
  process.on('SIGHUP', forwardHangup);
  let exit: { code: number | null; signal: NodeJS.Signals | null };
  try {
    exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.off('SIGINT', ignoreInterrupt);
    process.off('SIGTERM', forwardTerminate);
    process.off('SIGHUP', forwardHangup);
  }
  if (exit.signal) {
    // Report the child's death by signal faithfully instead of a generic exit 1.
    raiseSignal(exit.signal);
    throw new ScriptExitError(128 + (osConstants.signals[exit.signal] ?? 0), '', true);
  }
  const code = exit.code ?? 1;
  if (code !== 0) throw new ScriptExitError(code, '', true);
}

/** Where operators fix a startup environment failure, named in the error itself. */
const ENV_REGISTRY_PATH = 'knowledge/product/governance/env-registry.json';
const ENV_STRICT_FLAG = 'KYBERION_ENV_REGISTRY_STRICT';

/** Validate required registered settings before dispatching any CLI command. */
export function assertRequiredEnvironment(report: {
  errors: readonly Readonly<{ name: string; issue: string }>[];
}): void {
  if (report.errors.length === 0) return;
  const details = report.errors.map((issue) => `${issue.name} (${issue.issue})`).join(', ');
  throw new Error(
    [
      `Required environment is not configured: ${details}`,
      `Register or correct each variable in ${ENV_REGISTRY_PATH} (regenerate with \`pnpm generate:env-registry\`).`,
      `To downgrade unregistered/mistyped KYBERION_* variables to warnings, set ${ENV_STRICT_FLAG}=0 (strict applies by default only when CI is set).`,
    ].join('\n')
  );
}

export function validateKyberionStartupEnvironment(
  env: Record<string, string | undefined> = process.env
): void {
  // Strict only in CI or when KYBERION_ENV_REGISTRY_STRICT is set explicitly; otherwise
  // unknown names warn once and invalid values of known variables still fail.
  const report = validateStartupEnv(env);
  for (const warning of report.warnings) logger.warn(warning);
  assertRequiredEnvironment(report);
}

function helpLocale(args: string[]): SupportedLocale | undefined {
  const index = args.indexOf('--locale');
  return index >= 0 && args[index + 1] ? resolveLocale({ explicit: args[index + 1] }) : undefined;
}

/**
 * CU-08 / CU-09: rewrite a deprecated command or a `doctor --scope` /
 * `setup <area>` scope to the registered command it stands for. Returns the
 * arguments to dispatch (unchanged when nothing applies).
 */
export function rewriteRoutedArgs(
  args: string[],
  manifest: CliManifest,
  warn: (message: string) => void = (message) => logger.warn(message)
): string[] {
  let current = args;
  // Each hop strictly consumes an alias or a scope; the registry check forbids
  // scope → scope routes, so two hops (alias, then scope) is the maximum.
  for (let hop = 0; hop < 3; hop += 1) {
    const command = resolveCommandPath(current, manifest);
    const alias = findDeprecatedCommandAlias(command, manifest);
    if (alias) {
      warn(t('cli:cli_deprecated_command', { old: alias.command, new: alias.replaced_by }));
      current = rewriteDeprecatedCommand(alias, current);
      continue;
    }
    const registered = findUniqueCommand(command, manifest);
    if (!registered?.scopes) return current;
    const routed = routeScopedCommand(registered, current);
    if (routed.kind === 'unknown') {
      throw new ScriptExitError(1, formatUnknownScope(registered, routed.scope));
    }
    if (routed.kind === 'none') return current;
    current = routed.args;
  }
  return current;
}

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  // pnpm forwards the `--` separator literally (npm strips it); drop it so
  // `pnpm run kyberion -- <command>` keeps working (legacy cli.ts behavior).
  let normalizedArgs = args.filter((arg) => arg !== '--');
  // CU-03: `kyberion --help`, `-h`, and `help` share one registry renderer;
  // only `--detail` (per-verb argument syntax) needs the operator CLI.
  if (['--help', '-h', 'help'].includes(normalizedArgs[0] ?? '')) {
    if (!normalizedArgs.includes('--detail')) {
      print(
        formatCliManifestHelp(undefined, {
          all: normalizedArgs.includes('--all'),
          locale: helpLocale(normalizedArgs),
        })
      );
      return;
    }
    normalizedArgs = ['help', ...normalizedArgs.slice(1)];
  }
  validateKyberionStartupEnvironment();
  const manifest = loadCliManifest();
  normalizedArgs = rewriteRoutedArgs(normalizedArgs, manifest);
  const command = resolveCommandPath(normalizedArgs, manifest);
  const registeredEntrypoint = findUniqueCommand(command, manifest);
  if (!registeredEntrypoint) {
    await runScriptCommand(command, normalizedArgs, manifest, print);
    return;
  }
  const entrypoint = selectEntrypoint(command, manifest);
  switch (entrypoint.id) {
    case 'operator-cli': {
      const { main: operatorCliMain } = await import('./cli.js');
      // Pass the printer through: without it every operator-cli command
      // (list / search / info / read …) rendered into a no-op sink.
      await operatorCliMain(normalizedArgs, print);
      return;
    }
    case 'organization-model':
    case 'project-controller': {
      const { runGovernedController } = await import('./kyberion-governed-controllers.js');
      await runGovernedController(entrypoint.id, normalizedArgs.slice(1), print);
      return;
    }
    case 'operator-home': {
      const { main: operatorHomeMain } = await import('./kyberion_home.js');
      await operatorHomeMain(normalizedArgs, print);
      return;
    }
    case 'pipeline-runner': {
      const { main: pipelineMain, resolvePipelinePresetArgs } = await import('./run_pipeline.js');
      await pipelineMain(resolvePipelinePresetArgs(normalizedArgs.slice(1)));
      return;
    }
    case 'operator-readiness': {
      const { main: vitalMain } = await import('./vital_check.js');
      const result = await vitalMain(normalizedArgs.slice(1));
      if (result.help) print(result.help);
      else if (result.report) {
        const output = result.text ?? result.report;
        print(output);
      }
      if (result.status !== 0) {
        const { ScriptExitError } = await import('./lib/harness.js');
        throw new ScriptExitError(result.status, '', true, result);
      }
      return;
    }
    case 'operator-setup': {
      if (command === 'setup') {
        // CU-09: a bare `setup` (or `setup --help`) lists the areas it routes to.
        const registered = findUniqueCommand(command, manifest);
        if (registered) print(formatScopeHelp(registered, helpLocale(normalizedArgs)));
        return;
      }
      const { runSetupReportCli } = await import('./setup_report.js');
      await runSetupReportCli(normalizedArgs.slice(2));
      return;
    }
    case 'operator-voice': {
      const { runVoiceSetupScript } = await import('./voice_setup.js');
      await runVoiceSetupScript(normalizedArgs.slice(2));
      return;
    }
    default:
      throw new Error(`Unsupported kyberion entrypoint: ${entrypoint.id}`);
  }
}

if (
  isDirectScript(import.meta.url, 'kyberion.ts') ||
  isDirectScript(import.meta.url, 'kyberion.js')
)
  void defineScript({
    name: 'kyberion',
    flags: [],
    run: ({ argv, print }) => main(argv, print),
  })();
