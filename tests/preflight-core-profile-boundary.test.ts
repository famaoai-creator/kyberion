import { describe, expect, it } from 'vitest';
import config from '../vitest.config.mjs';
import { safeExecResult } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { CORE_AFFECTED_TEST_EXCLUDES, isCoreAffectedTest } from '../scripts/pr_preflight.js';
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
});
