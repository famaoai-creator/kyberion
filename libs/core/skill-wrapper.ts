/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
 *
 * Usage:
 *   import { runSkill } from '../../scripts/lib/skill-wrapper.js';
 *   runSkill<MyResult>('my-skill', () => ({ result: 'data' }));
 */

import type { SkillOutput } from './types.js';
// @ts-ignore
import { metrics } from './metrics.cjs';

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
    // Record metrics
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
  console.log(JSON.stringify(output, null, 2));
  if (output.status === 'error') process.exit(1);
  return output;
}

export async function runSkillAsync<T>(
  skillName: string,
  fn: () => Promise<T>
): Promise<SkillOutput<T>> {
  const output = await wrapSkillAsync(skillName, fn);
  console.log(JSON.stringify(output, null, 2));
  if (output.status === 'error') process.exit(1);
  return output;
}
