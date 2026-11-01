import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import {
  buildVitestArgs,
  buildVitestEnv,
  gateCoveredTestFiles,
  parseTestSuiteArgs,
  TEST_SUITES,
  runTestSuite,
} from './test_suite.js';

describe('test suite dispatcher', () => {
  it('keeps every named suite explicit and deterministic', () => {
    expect(Object.keys(TEST_SUITES)).toEqual([
      'smoke',
      'unit',
      'core',
      'meeting-dry-run',
      'ui-voice-browser-smoke',
      'actuators',
      'scripts',
      'integration',
      'browser-bridge',
      'meet-copilot',
      'coverage',
      'tui',
    ]);
    expect(buildVitestArgs('core')).toEqual([
      'vitest',
      'run',
      'libs/core/',
      '--no-file-parallelism',
    ]);
  });

  it('extracts suite selection without swallowing Vitest options', () => {
    expect(parseTestSuiteArgs(['--suite', 'core', '--coverage'])).toEqual({
      suite: 'core',
      vitestArgs: ['--coverage'],
    });
    expect(parseTestSuiteArgs(['--suite=meeting-dry-run', '--reporter=dot'])).toEqual({
      suite: 'meeting-dry-run',
      vitestArgs: ['--reporter=dot'],
    });
  });

  it('forwards --shard through to vitest for sharded CI jobs', () => {
    const { suite, vitestArgs } = parseTestSuiteArgs(['--suite', 'scripts', '--shard=1/3']);
    expect(suite).toBe('scripts');
    expect(buildVitestArgs(suite, vitestArgs)).toEqual([
      'vitest',
      'run',
      'scripts/',
      '--shard=1/3',
    ]);
  });

  it('excludes only pr-gate vitest files under --skip-gate-tests', () => {
    expect(
      parseTestSuiteArgs(['--suite', 'integration', '--skip-gate-tests', '--shard=1/2'])
    ).toEqual({ suite: 'integration', vitestArgs: ['--shard=1/2'], skipGateTests: true });
    expect(parseTestSuiteArgs(['--suite', 'integration'])).not.toHaveProperty('skipGateTests');
    const vitest = ['node_modules/vitest/vitest.mjs', 'run'];
    expect(
      gateCoveredTestFiles({
        gates: [
          {
            id: 'pr-tests',
            scope: 'pr',
            args: [...vitest, '--maxWorkers=2', 'tests/b.test.ts', 'tests/a.test.ts'],
          },
          // full gates do not run on pull requests' pr-gates job: never excluded.
          { id: 'full-tests', scope: 'full', args: [...vitest, 'tests/full.test.ts'] },
          { id: 'not-vitest', scope: 'pr', args: ['scripts/check.ts', 'tests/c.test.ts'] },
        ],
      })
    ).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('skips the real registration-tests files in the CI integration suite', () => {
    const manifest = JSON.parse(
      String(
        safeReadFile(pathResolver.rootResolve('knowledge/product/governance/ci-gates.json'), {
          encoding: 'utf8',
        })
      )
    );
    const covered = gateCoveredTestFiles(manifest);
    expect(covered).toContain('tests/foundation-io-boundary.test.ts');
    expect(covered).toContain('tests/runtime-child-process-boundary.test.ts');
    const ci = String(
      safeReadFile(pathResolver.rootResolve('.github/workflows/ci.yml'), { encoding: 'utf8' })
    );
    expect(ci).toContain('pnpm test -- --suite integration --skip-gate-tests --shard=1/2');
    expect(ci).toContain('pnpm test -- --suite integration --skip-gate-tests --shard=2/2');
  });

  it('rejects missing and unknown suite names', () => {
    expect(() => parseTestSuiteArgs(['--suite'])).toThrow('--suite requires a suite name');
    expect(() => parseTestSuiteArgs(['--suite', 'unknown'])).toThrow('unknown test suite');
  });

  it('forwards the leak-guard strict switch past the safeExec env allowlist', () => {
    expect(buildVitestEnv({ KYBERION_TEST_LEAK_STRICT: '1' })).toEqual({
      KYBERION_TEST_LEAK_STRICT: '1',
    });
    expect(buildVitestEnv({})).toEqual({ KYBERION_TEST_LEAK_STRICT: undefined });
  });

  it('requires an explicit argv array at the dispatcher boundary', () => {
    expect(runTestSuite.length).toBe(1);
  });
});
