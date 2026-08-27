#!/usr/bin/env node
import { validateEnv } from '@agent/core';
import { getRegisteredEnvBool } from '@agent/core/foundation';
import { loadCliManifest, type CliCommand } from './check_cli_manifest.js';
import { defineScript, isDirectScript } from './lib/harness.js';

interface CliEntrypoint {
  id: string;
  module: string;
  commands: string[];
}

export function selectEntrypoint(command: string, manifest = loadCliManifest()): CliEntrypoint {
  const registered = manifest.commands.find((candidate) => candidate.command === command);
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
  return manifest.commands.find((entry) => entry.command === command);
}

export function formatCliManifestHelp(manifest = loadCliManifest()): string {
  const rows = [...manifest.commands]
    .sort((left, right) => left.command.localeCompare(right.command))
    .map((command) => {
      const label = command.command || '<home>';
      return `  ${label.padEnd(28)} ${command.noun} ${command.verb} [${command.audience}]`;
    });
  return [
    'Kyberion commands (governed registry):',
    '',
    ...rows,
    '',
    'Use `kyberion <command> --help` for command-specific options.',
  ].join('\n');
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

export async function main(args: string[] = []): Promise<void> {
  if (args[0] === '--help' || args[0] === '-h') {
    console.log(formatCliManifestHelp());
    return;
  }
  validateKyberionStartupEnvironment();
  const entrypoint = selectEntrypoint(args[0] ?? '');
  if (entrypoint.id === 'operator-cli') {
    const { main: operatorCliMain } = await import('./cli.js');
    await operatorCliMain(args);
    return;
  }

  if (
    entrypoint.id === 'organization-model' ||
    entrypoint.id === 'organization-roles' ||
    entrypoint.id === 'project-controller'
  ) {
    const { runGovernedController } = await import('./kyberion-governed-controllers.js');
    await runGovernedController(entrypoint.id, args.slice(1));
    return;
  }

  const { main: operatorHomeMain } = await import('./kyberion_home.js');
  await operatorHomeMain(args);
}

if (
  isDirectScript(import.meta.url, 'kyberion.ts') ||
  isDirectScript(import.meta.url, 'kyberion.js')
)
  void defineScript({
    name: 'kyberion',
    flags: [],
    run: ({ argv }) => main(argv),
  })();
