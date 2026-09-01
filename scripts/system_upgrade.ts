#!/usr/bin/env node

import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';
import { main as runPipelineMain } from './pipeline-execution-part-results.js';

export const SYSTEM_UPGRADE_PIPELINES = {
  check: 'pipelines/system-upgrade-check.json',
  execute: 'pipelines/system-upgrade-execute.json',
} as const;

export type SystemUpgradeMode = keyof typeof SYSTEM_UPGRADE_PIPELINES;

export function parseSystemUpgradeArgs(argv: readonly string[]): {
  mode: SystemUpgradeMode;
  pipelineArgs: string[];
} {
  let mode: SystemUpgradeMode = 'check';
  const pipelineArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--mode') {
      const value = argv[index + 1];
      if (!value) throw new Error('--mode requires check or execute');
      mode = asSystemUpgradeMode(value);
      index += 1;
    } else if (arg.startsWith('--mode=')) {
      mode = asSystemUpgradeMode(arg.slice('--mode='.length));
    } else {
      pipelineArgs.push(arg);
    }
  }
  return { mode, pipelineArgs };
}

function asSystemUpgradeMode(value: string): SystemUpgradeMode {
  if (value === 'check' || value === 'execute') return value;
  throw new Error(`unknown system upgrade mode: ${value}. Choose check or execute`);
}

export function buildSystemUpgradeArgs(
  mode: SystemUpgradeMode,
  pipelineArgs: readonly string[] = []
): string[] {
  return ['--input', SYSTEM_UPGRADE_PIPELINES[mode], ...pipelineArgs];
}

export async function runSystemUpgrade(
  argv: readonly string[] = currentProcessArgv().slice(2)
): Promise<number> {
  const { mode, pipelineArgs } = parseSystemUpgradeArgs(argv);
  process.exitCode = undefined;
  await runPipelineMain(buildSystemUpgradeArgs(mode, pipelineArgs));
  const rawStatus = process.exitCode;
  const parsedStatus = rawStatus === undefined ? 0 : Number(rawStatus);
  const status = Number.isFinite(parsedStatus) ? parsedStatus : 1;
  process.exitCode = undefined;
  if (status !== 0) {
    throw new ScriptExitError(status, `system upgrade ${mode} failed`, true);
  }
  return status;
}

if (
  isDirectScript(import.meta.url, 'system_upgrade.ts') ||
  isDirectScript(import.meta.url, 'system_upgrade.js')
) {
  void defineScript({
    name: 'system:upgrade',
    flags: [],
    run: (context) => runSystemUpgrade(context.argv),
  })();
}
