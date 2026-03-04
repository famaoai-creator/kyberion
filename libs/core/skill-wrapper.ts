/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
 *
 * DESIGN NOTE: Library functions (wrapSkill, wrapSkillAsync, runSkill,
 * runSkillAsync) never call process.exit(). That decision belongs to CLI
 * entrypoints. Use runSkillCli() for the traditional "print + exit" behaviour.
 */

import type { SkillOutput } from './types.js';
import { metrics } from './metrics.js';
const chalk: any = require('chalk').default || require('chalk');

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
    },
  };

  if (status === 'success') {
    base.data = dataOrError as T;
    const extra: any = {};
    if (base.data && (base.data as any).metadata?.usage) {
      extra.usage = (base.data as any).metadata.usage;
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

import * as fs from 'node:fs';
import * as path from 'node:path';

function printOutput<T>(output: SkillOutput<T>) {
  const isHuman = process.env.GEMINI_FORMAT === 'human' || process.argv.includes('--format=human');

  // Persistence for Feedback Loop: Save the latest response to a physical file
  try {
    const sharedDir = path.join(process.cwd(), 'active/shared');
    if (!fs.existsSync(sharedDir)) fs.mkdirSync(sharedDir, { recursive: true });
    fs.writeFileSync(
      path.join(sharedDir, 'last_response.json'),
      JSON.stringify(output, null, 2),
      'utf8'
    );
  } catch (_) {
    /* Ignore silent failures in persistence */
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
    console.log(
      chalk.dim(`Duration: ${output.metadata.duration_ms}ms | ${output.metadata.timestamp}\n`)
    );
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

/**
 * Run a skill and print its output. Returns the output regardless of status.
 * Does NOT call process.exit — use runSkillCli for CLI entrypoints.
 */
export function runSkill<T>(skillName: string, fn: () => T): SkillOutput<T> {
  const output = wrapSkill(skillName, fn);
  printOutput(output);
  return output;
}

/**
 * Async variant of runSkill.
 */
export async function runSkillAsync<T>(
  skillName: string,
  fn: () => Promise<T>
): Promise<SkillOutput<T>> {
  const output = await wrapSkillAsync(skillName, fn);
  printOutput(output);
  return output;
}

/**
 * CLI entrypoint wrapper: runs the skill, prints output, and exits with
 * code 1 on error. Use this only in top-level CLI scripts, never in library
 * code that may be imported by tests or other skills.
 */
export function runSkillCli<T>(skillName: string, fn: () => T): void {
  const output = runSkill(skillName, fn);
  if (output.status === 'error') process.exit(1);
}

export async function runSkillAsyncCli<T>(skillName: string, fn: () => Promise<T>): Promise<void> {
  const output = await runSkillAsync(skillName, fn);
  if (output.status === 'error') process.exit(1);
}

export const runAsyncSkill = runSkillAsync;
