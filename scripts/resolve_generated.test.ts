import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { setProcessExitCode } from './lib/harness.js';
import {
  GENERATED_ARTIFACT_STEPS,
  resolveGeneratedArtifacts,
  type GeneratedArtifactStep,
} from './resolve_generated.js';

function step(id: string, calls: string[][], exitCode?: number): GeneratedArtifactStep {
  return {
    id,
    tracked: [`${id}.out`],
    run: async (argv) => {
      calls.push([id, ...argv]);
      if (exitCode !== undefined) setProcessExitCode(exitCode);
    },
  };
}

describe('resolve_generated', () => {
  it('regenerates in dependency order and covers every merge-driver path', () => {
    expect(GENERATED_ARTIFACT_STEPS.map((item) => item.id)).toEqual([
      'env-registry',
      'knowledge-index',
      'role-assumption-reachability',
      'changelog-fragments',
    ]);
    // Every file the merge driver hands off must be something this command
    // regenerates, and vice versa (single list: .gitattributes).
    const attributes = String(
      safeReadFile(pathResolver.rootResolve('.gitattributes'), { encoding: 'utf8' })
    );
    const driverPaths = attributes
      .split('\n')
      .filter((line) => !line.startsWith('#') && line.includes('merge=kyberion-regenerate'))
      .map((line) => line.split(/\s+/)[0]);
    expect(GENERATED_ARTIFACT_STEPS.flatMap((item) => item.tracked).sort()).toEqual(
      driverPaths.sort()
    );
  });

  it('writes and stages every step, keeping validation-only steps in check mode', async () => {
    const calls: string[][] = [];
    const steps = [step('a', calls), { ...step('b', calls), tracked: [], checkOnly: true }];

    await expect(resolveGeneratedArtifacts({ check: false, stage: true }, steps)).resolves.toEqual({
      failed: [],
      staged: ['a.out'],
    });
    expect(calls).toEqual([
      ['a', '--quiet'],
      ['b', '--check', '--quiet'],
    ]);
  });

  it('reports drift per step without staging in check mode', async () => {
    const calls: string[][] = [];
    const result = await resolveGeneratedArtifacts({ check: true, stage: true }, [
      step('fresh', calls),
      step('stale', calls, 1),
    ]);

    expect(result).toEqual({ failed: ['stale'], staged: [] });
    expect(calls.every((call) => call.includes('--check'))).toBe(true);
  });
});
