import { describe, expect, it } from 'vitest';
import * as yaml from 'js-yaml';
import config from '../vitest.config.mjs';
import { safeExecResult, safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  CORE_AFFECTED_TEST_EXCLUDES,
  CORE_AFFECTED_TEST_SHARDS,
  isCoreAffectedTest,
} from '../scripts/pr_preflight.js';
import { ciTestPaths, isCiTest } from '../scripts/lib/affected-tests.js';
import { matchesGatePath } from '../scripts/lib/changed-gate-selection.js';
import { TEST_SUITES } from '../scripts/test_suite.js';

describe('affected core profile inventory', () => {
  it('partitions the real eligible inventory without dropping or repeating a selected test', () => {
    const result = safeExecResult(
      'git',
      [
        '-c',
        'core.quotePath=false',
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
        '--',
        ':(glob)**/*.test.*',
      ],
      { cwd: pathResolver.rootDir(), timeoutMs: 60_000 }
    );
    expect(result.status, result.stderr).toBe(0);
    const include = config.test?.include ?? [];
    const exclude = config.test?.exclude ?? [];
    expect(include.length).toBeGreaterThan(0);
    const eligible = [...new Set(result.stdout.split('\0').filter(Boolean))]
      .filter((file) => include.some((glob) => matchesGatePath(file, glob)))
      .filter((file) => !exclude.some((glob) => matchesGatePath(file, glob)))
      .sort();
    const original = eligible.filter((file) => isCiTest(file, ciTestPaths()));
    const coreSelectors = TEST_SUITES.core.filter((entry) => !entry.startsWith('-'));
    const core = eligible.filter((file) => isCiTest(file, coreSelectors));
    const excluded = (file: string) =>
      CORE_AFFECTED_TEST_EXCLUDES.some((glob) => matchesGatePath(file, glob));
    const nonCore = original.filter((file) => !excluded(file));
    expect(core.length).toBeGreaterThan(0);
    // Three independently used classifications must agree: Vitest's original
    // selectors, the non-core exclusion globs, and exact-reader ownership.
    expect(original.filter(excluded)).toEqual(core);
    expect(eligible.filter(isCoreAffectedTest)).toEqual(core);
    expect(core.filter((file) => nonCore.includes(file))).toEqual([]);
    expect([...new Set([...core, ...nonCore])].sort()).toEqual(original);
  });
  it('keeps every local core shard aligned with both CI matrices', () => {
    interface Workflow {
      jobs: Record<
        string,
        {
          strategy: { matrix: { shard: number[]; total?: number[] } };
          steps: Array<{ run?: string }>;
        }
      >;
    }
    const read = (file: string) =>
      yaml.load(
        String(
          safeReadFile(pathResolver.rootResolve(file), {
            encoding: 'utf8',
          })
        )
      ) as Workflow;
    const pr = read('.github/workflows/pr-validation.yml').jobs['test-core'];
    const ci = read('.github/workflows/ci.yml').jobs['core-coverage-shards'];
    if (!pr || !ci) throw new Error('Canonical core CI jobs are missing');
    const shards = Array.from({ length: CORE_AFFECTED_TEST_SHARDS }, (_, index) => index + 1);
    expect(CORE_AFFECTED_TEST_SHARDS).toBeGreaterThan(0);
    expect(pr.strategy.matrix.shard).toEqual(shards);
    expect(pr.strategy.matrix.total).toEqual([CORE_AFFECTED_TEST_SHARDS]);
    expect(ci.strategy.matrix.shard).toEqual(shards);
    expect(pr.steps.map((step) => step.run ?? '').join('\n')).toContain(
      '--shard=${{ matrix.shard }}/${{ matrix.total }}'
    );
    expect(ci.steps.map((step) => step.run ?? '').join('\n')).toContain(
      '--shard=${{ matrix.shard }}/' + CORE_AFFECTED_TEST_SHARDS
    );
  });
});
