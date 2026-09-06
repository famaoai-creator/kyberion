#!/usr/bin/env node
import { validateEnv } from '@agent/core/env-validator';
import { getRegisteredEnvBool } from '@agent/core/foundation';
import {
  loadCliManifest,
  resolveCliModulePath,
  type CliCommand,
  type CliManifest,
  type CliScriptCommand,
} from './check_cli_manifest.js';
import { safeExecResultAsync } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

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
    if (findUniqueCommand(candidate, manifest) || findUniqueScriptCommand(candidate, manifest)) {
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

export function formatCliManifestHelp(manifest = loadCliManifest()): string {
  const rows = [...manifest.commands]
    .sort((left, right) => left.command.localeCompare(right.command))
    .map((command) => {
      const label = command.command || '<home>';
      return `  ${label.padEnd(28)} ${command.noun} ${command.verb} [${command.audience}]`;
    });
  const scriptRows = (manifest.script_commands || [])
    .filter((command) => command.audience !== 'dev')
    .sort((left, right) => left.command.localeCompare(right.command))
    .map((command) => {
      const displayCommand = command.command.endsWith(' default')
        ? command.command.slice(0, -' default'.length)
        : command.command;
      return `  ${displayCommand.padEnd(28)} ${command.script ?? command.module} [${command.audience}]`;
    });
  return [
    'Kyberion commands (governed registry):',
    '',
    ...rows,
    '',
    'Script-backed operator commands:',
    '',
    ...scriptRows,
    '',
    'Use `kyberion <command> --help` for command-specific options.',
  ].join('\n');
}

async function runScriptCommand(
  command: string,
  args: string[],
  manifest: CliManifest,
  print: (value: unknown) => void
): Promise<void> {
  const scriptCommand = resolveScriptCommand(command, manifest);
  if (!scriptCommand) throw new Error(`Unknown kyberion command: ${command}`);
  if (scriptCommand.script === 'kyberion') {
    throw new Error('The kyberion package script cannot dispatch itself');
  }
  const commandArgs = args.slice(command.split(' ').length);
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
        { cwd: pathResolver.rootDir(), timeoutMs: 120_000 }
      )
    : await safeExecResultAsync('pnpm', ['run', scriptCommand.script!, ...commandArgs], {
        cwd: pathResolver.rootDir(),
        timeoutMs: 120_000,
      });
  if (result.stdout.trim()) print(result.stdout.trim());
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || 'script command failed';
    throw new ScriptExitError(result.status || 1, detail);
  }
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
      `To downgrade unregistered/mistyped KYBERION_* variables back to warnings, set ${ENV_STRICT_FLAG}=0 (strict validation is on by default).`,
    ].join('\n')
  );
}

export function validateKyberionStartupEnvironment(
  env: Record<string, string | undefined> = process.env
): void {
  const strict =
    getRegisteredEnvBool(ENV_STRICT_FLAG, {
      env,
      defaultValue: true,
    }) === true;
  assertRequiredEnvironment(validateEnv(env, { strict }));
}

export async function main(
  args: string[] = [],
  print: (value: unknown) => void = () => undefined
): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    print(formatCliManifestHelp());
    return;
  }
  validateKyberionStartupEnvironment();
  const manifest = loadCliManifest();
  const command = resolveCommandPath(args, manifest);
  const registeredEntrypoint = findUniqueCommand(command, manifest);
  if (!registeredEntrypoint) {
    await runScriptCommand(command, args, manifest, print);
    return;
  }
  const entrypoint = selectEntrypoint(command, manifest);
  switch (entrypoint.id) {
    case 'operator-cli': {
      const { main: operatorCliMain } = await import('./cli.js');
      await operatorCliMain(args);
      return;
    }
    case 'organization-model':
    case 'organization-roles':
    case 'project-controller': {
      const { runGovernedController } = await import('./kyberion-governed-controllers.js');
      await runGovernedController(entrypoint.id, args.slice(1), print);
      return;
    }
    case 'operator-home': {
      const { main: operatorHomeMain } = await import('./kyberion_home.js');
      await operatorHomeMain(args, print);
      return;
    }
    case 'pipeline-runner': {
      const { main: pipelineMain, resolvePipelinePresetArgs } = await import('./run_pipeline.js');
      await pipelineMain(resolvePipelinePresetArgs(args.slice(1)));
      return;
    }
    case 'operator-readiness': {
      const { main: vitalMain } = await import('./vital_check.js');
      const result = await vitalMain(args.slice(1));
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
      const { runSetupReportCli } = await import('./setup_report.js');
      await runSetupReportCli(args.slice(2));
      return;
    }
    case 'operator-voice': {
      const { runVoiceSetupScript } = await import('./voice_setup.js');
      await runVoiceSetupScript(args.slice(2));
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
