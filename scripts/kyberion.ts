#!/usr/bin/env node
import { validateEnv } from '@agent/core';
import { loadCliManifest, type CliCommand } from './check_cli_manifest.js';

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

/** Validate required registered settings before dispatching any CLI command. */
export function assertRequiredEnvironment(report: {
  errors: readonly Readonly<{ name: string; issue: string }>[];
}): void {
  if (report.errors.length === 0) return;
  throw new Error(
    `Required environment is not configured: ${report.errors
      .map((issue) => `${issue.name} (${issue.issue})`)
      .join(', ')}`
  );
}

export function validateKyberionStartupEnvironment(
  env: Record<string, string | undefined> = process.env
): void {
  assertRequiredEnvironment(validateEnv(env));
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  validateKyberionStartupEnvironment();
  const entrypoint = selectEntrypoint(args[0] ?? '');
  if (entrypoint.id === 'operator-cli') {
    const { main: operatorCliMain } = await import('./cli.js');
    await operatorCliMain(args);
    return;
  }

  const { main: operatorHomeMain } = await import('./kyberion_home.js');
  const originalArgv = process.argv;
  process.argv = [originalArgv[0] ?? 'node', 'kyberion', ...args];
  try {
    await operatorHomeMain();
  } finally {
    process.argv = originalArgv;
  }
}

if (process.argv[1]?.endsWith('kyberion.ts') || process.argv[1]?.endsWith('kyberion.js')) {
  void main().catch((error: unknown) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
