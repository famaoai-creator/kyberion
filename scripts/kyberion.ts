#!/usr/bin/env node
import { pathResolver, safeReadFile } from '@agent/core';
import { main as operatorCliMain } from './cli.js';
import { main as operatorHomeMain } from './kyberion_home.js';

interface CliEntrypoint {
  id: string;
  module: string;
  commands: string[];
}

interface CliManifest {
  version: number;
  entrypoints: CliEntrypoint[];
}

function loadManifest(): CliManifest {
  return JSON.parse(
    String(
      safeReadFile(pathResolver.knowledge('product/governance/cli-commands.json'), {
        encoding: 'utf8',
      })
    )
  ) as CliManifest;
}

export function selectEntrypoint(command: string, manifest = loadManifest()): CliEntrypoint {
  return (
    manifest.entrypoints.find((entrypoint) => entrypoint.commands.includes(command)) ??
    manifest.entrypoints.find((entrypoint) => entrypoint.id === 'operator-home')!
  );
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const entrypoint = selectEntrypoint(args[0] ?? '');
  if (entrypoint.id === 'operator-cli') {
    await operatorCliMain(args);
    return;
  }

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
