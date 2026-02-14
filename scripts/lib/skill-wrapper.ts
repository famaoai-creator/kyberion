/**
 * TypeScript version of skill-wrapper.
 * Provides typed wrappers for skill execution with standardized output.
 *
 * Usage:
 *   import { runSkill } from '../../scripts/lib/skill-wrapper.js';
 *   runSkill<MyResult>('my-skill', () => ({ result: 'data' }));
 */

import type { SkillOutput } from './types.js';

function buildOutput<T>(
  skillName: string,
  status: 'success' | 'error',
  dataOrError: T | Error,
  startTime: number
): SkillOutput<T> {
  const base: SkillOutput<T> = {
    skill: skillName,
    status,
    metadata: {
      duration_ms: Date.now() - startTime,
      timestamp: new Date().toISOString(),
    },
  };
  if (status === 'success') {
    base.data = dataOrError as T;
  } else {
    const err = dataOrError as Error;
    base.error = {
      code: (err as any).code || 'EXECUTION_ERROR',
      message: err.message || String(err),
    };
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
