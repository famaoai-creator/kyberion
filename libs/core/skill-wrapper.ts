/**
 * libs/core/skill-wrapper.ts
 * Provides typed wrappers for capability execution with standardized output.
 * [SECURE-IO COMPLIANT VERSION]
 */

import type { SkillOutput } from './types.js';
import { metrics } from './metrics.js';
import { fileUtils } from './core.js';
import { safeWriteFile } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import chalk from 'chalk';
import * as path from 'node:path';

function buildOutput<T>(
  skillName: string,
  status: 'success' | 'error',
  dataOrError: T | Error,
  startTime: number
): SkillOutput<T> {
  const durationMs = Date.now() - startTime;
  const base: SkillOutput<T> = {
    skill: skillName,
    status,
    metadata: {
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
      system_directive: fileUtils.getGoldenRule(),
    },
  };

  if (status === 'success') {
    base.data = dataOrError as T;
    const extra: any = {};
    if (base.data) {
      const data = base.data as any;
      if (data.metadata?.usage) extra.usage = data.metadata.usage;
      if (data.metadata?.model) extra.model = data.metadata.model;
      if (data.intervention) extra.intervention = true;
    }
    metrics.record(skillName, durationMs, 'success', extra);
  } else {
    const err = dataOrError as Error;
    base.error = {
      code: (err as any).code || 'EXECUTION_ERROR',
      message: err.message || String(err),
    };
    metrics.record(skillName, durationMs, 'error');
  }
  return base;
}

function printOutput<T>(output: SkillOutput<T>) {
  const isHuman = process.env.KYBERION_FORMAT === 'human' || process.argv.includes('--format=human');

  // Persistence for Feedback Loop: Save the latest response via Secure IO
  try {
    const sharedPath = path.join(pathResolver.rootDir(), 'active/shared/last_response.json');
    safeWriteFile(sharedPath, JSON.stringify(output, null, 2));
  } catch (_) {
    /* Silent fail for background persistence */
  }

  if (isHuman) {
    if (output.status === 'success') {
      console.log(chalk.green(`\n✅ ${output.skill} success`));
      if (output.data) {
        if (typeof output.data === 'string') {
          console.log(output.data);
        } else if ((output.data as any).message) {
          console.log((output.data as any).message);
        } else {
          console.log(JSON.stringify(output.data, null, 2));
        }
      }
    } else {
      console.log(chalk.red(`\n❌ ${output.skill} error`));
      console.log(chalk.yellow(`Code: ${output.error?.code}`));
      console.log(output.error?.message);
    }
    if (output.metadata) {
      console.log(
        chalk.dim(`Duration: ${output.metadata.duration_ms}ms | ${output.metadata.timestamp}\n`)
      );
    }
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
}

export function wrapSkill<T>(skillName: string, fn: () => T): SkillOutput<T> {
  const startTime = Date.now();
  try {
    return buildOutput<T>(skillName, 'success', fn(), startTime);
  } catch (err) {
    return buildOutput<T>(skillName, 'error', err as Error, startTime);
  }
}

export async function wrapSkillAsync<T>(
  skillName: string,
  fn: () => Promise<T>
): Promise<SkillOutput<T>> {
  const startTime = Date.now();
  try {
    return buildOutput<T>(skillName, 'success', await fn(), startTime);
  } catch (err) {
    return buildOutput<T>(skillName, 'error', err as Error, startTime);
  }
}

export function runSkill<T>(skillName: string, fn: () => T): SkillOutput<T> {
  const output = wrapSkill(skillName, fn);
  printOutput(output);
  return output;
}

export async function runSkillAsync<T>(
  skillName: string,
  fn: () => Promise<T>
): Promise<SkillOutput<T>> {
  const output = await wrapSkillAsync(skillName, fn);
  printOutput(output);
  return output;
}

export function runSkillCli<T>(skillName: string, fn: () => T): void {
  const output = runSkill(skillName, fn);
  if (output.status === 'error') process.exit(1);
}

export async function runSkillAsyncCli<T>(skillName: string, fn: () => Promise<T>): Promise<void> {
  const output = await runSkillAsync(skillName, fn);
  if (output.status === 'error') process.exit(1);
}

export const runAsyncSkill = runSkillAsync;
