#!/usr/bin/env node
import { loadJson, pathResolver } from '@agent/core';

interface CliEntrypoint {
  id: string;
  module: string;
  commands: string[];
}

interface CliCommand {
  id: string;
  command: string;
  noun: string;
  verb: string;
  entry: string;
  audience: 'user' | 'operator' | 'dev';
}

interface CliManifest {
  version: number;
  commands?: CliCommand[];
  entrypoints: CliEntrypoint[];
}

function loadManifest(): CliManifest {
  return loadJson<CliManifest>(pathResolver.knowledge('product/governance/cli-commands.json'));
}

export function selectEntrypoint(command: string, manifest = loadManifest()): CliEntrypoint {
  const entrypoint = manifest.entrypoints.find((candidate) => candidate.commands.includes(command));
  if (entrypoint) return entrypoint;
  if (!command) return manifest.entrypoints.find((candidate) => candidate.id === 'operator-home')!;
  throw new Error(`Unknown kyberion command: ${command}`);
}

export function resolveCommand(command: string, manifest = loadManifest()): CliCommand | undefined {
  return manifest.commands?.find((entry) => entry.command === command);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
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
