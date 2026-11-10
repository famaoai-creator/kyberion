import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  safeExecResult: vi.fn(),
  safeReadFile: vi.fn(),
  checkPrKnowledgeReadiness: vi.fn(),
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExec: mocks.safeExec,
  safeExecResult: mocks.safeExecResult,
  safeReadFile: mocks.safeReadFile,
}));

vi.mock('@agent/core/knowledge/pr-knowledge-readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/knowledge/pr-knowledge-readiness')>()),
  checkPrKnowledgeReadiness: mocks.checkPrKnowledgeReadiness,
}));

import {
  CORE_AFFECTED_TEST_SHARDS,
  isCoreAffectedTest,
  main,
  PREFLIGHT_PR_CLI,
  runAffectedTests,
} from './pr_preflight.js';
import { TEST_SUITES } from './test_suite.js';
import { PUBLISH_PR_CLI } from './publish_pull_request.js';
import { ciTestPaths } from './lib/affected-tests.js';

describe('pr preflight', () => {
  beforeEach(() => vi.resetAllMocks());

  it('runs the title check and the changed-path readiness gate without touching gh', async () => {
    mocks.safeExec.mockReturnValue('');
    const output: unknown[] = [];
    await main(
      [
        '--title',
        'feat(check): preflight',
        '--base',
        'main',
        '--check-jobs',
        '2',
        '--skip-affected-tests',
      ],
      (v) => output.push(v)
    );
    expect(mocks.safeExec).toHaveBeenCalledExactlyOnceWith(
      'pnpm',
      ['check', '--', '--changed', '--base', 'origin/main', '--jobs', '2'],
      { cwd: pathResolver.rootDir(), timeoutMs: 1_800_000 }
    );
    expect(mocks.safeExec.mock.calls.some(([command]) => command === 'gh')).toBe(false);
    expect(mocks.checkPrKnowledgeReadiness).not.toHaveBeenCalled();
    expect(output.join('\n')).toContain('Knowledge readiness (KL-03) not checked');
    expect(output.join('\n')).toContain('Affected tests skipped (--skip-affected-tests)');
  });

  it('runs the Knowledge-in-PR check when a body file is given', async () => {
    mocks.safeExec.mockReturnValue('');
    mocks.safeReadFile.mockReturnValue('## Knowledge\n- none — test\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({ ok: true, violations: [] });
    const output: unknown[] = [];
    await main(
      ['--title', 'feat(check): preflight', '--body-file', 'body.md', '--skip-affected-tests'],
      (v) => output.push(v)
    );
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'pnpm',
      ['check', '--', '--changed'],
      expect.any(Object)
    );
    expect(mocks.checkPrKnowledgeReadiness).toHaveBeenCalledOnce();
    expect(output.join('\n')).toContain('Knowledge readiness check passed');
  });

  it('rejects a non-conventional title before running any gate', async () => {
    await expect(main(['--title', 'did stuff'])).rejects.toThrow('--title is not valid');
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it('prints usage for --help and rejects unknown flags without running gates', async () => {
    const output: unknown[] = [];
    await main(['--help'], (v) => output.push(v));
    expect(String(output[0])).toContain('pnpm kyberion pr preflight');
    await expect(main(['--draft'])).rejects.toMatchObject({ code: 2 });
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it('accepts --skip-affected-tests only on preflight, not on pr create', () => {
    const flags = (spec: typeof PREFLIGHT_PR_CLI) => spec.options.map((option) => option.flag);
    expect(flags(PREFLIGHT_PR_CLI)).toContain('--skip-affected-tests');
    expect(flags(PUBLISH_PR_CLI)).not.toContain('--skip-affected-tests');
  });

  describe('affected tests (checklist step 3.5)', () => {
    type GitArgs = string[];
    const fakeGit =
      (changed: string[], readers: Record<string, string[]> = {}) =>
      (args: GitArgs) => {
        if (args[0] === 'merge-base') return { status: 0, stdout: 'abc123\n', stderr: '' };
        if (args[0] === 'diff') return { status: 0, stdout: changed.join('\n'), stderr: '' };
        if (args[0] === 'ls-files') return { status: 0, stdout: '', stderr: '' };
        if (args[0] === 'grep') {
          const needles = args.filter((_, i) => args[i - 1] === '-e');
          const hits = [...new Set(needles.flatMap((needle) => readers[needle] ?? []))];
          return hits.length
            ? { status: 0, stdout: hits.join('\n'), stderr: '' }
            : { status: 1, stdout: '', stderr: '' };
        }
        throw new Error(`unexpected git ${args.join(' ')}`);
      };

    const passed = (files: number) => ({
      status: 0,
      stdout: ` Test Files  ${files} passed (${files})\n      Tests  ${files * 3} passed (${files * 3})\n`,
      stderr: '',
    });
    const always = () => true;
    const coreCodeRuns = () =>
      Array.from({ length: 6 }, (_, index) => [
        'run',
        '--changed',
        'abc123',
        '--passWithNoTests',
        ...TEST_SUITES.core,
        `--shard=${index + 1}/6`,
      ]);

    it('runs vitest --changed for code and the reader tests for changed docs', () => {
      const runs: string[][] = [];
      const output: string[] = [];
      const result = runAffectedTests((v) => output.push(String(v)), undefined, {
        git: fakeGit(['libs/core/a.ts', 'CONTRIBUTING.md'], {
          'CONTRIBUTING.md': ['tests/good-first-issue-guidance-contract.test.ts'],
        }),
        vitest: (args) => {
          runs.push(args);
          return passed(2);
        },
        exists: always,
      });
      expect(runs).toEqual([
        ...coreCodeRuns(),
        [
          'run',
          '--changed',
          'abc123',
          '--passWithNoTests',
          ...ciTestPaths(),
          '--exclude',
          'libs/core/**',
          '--exclude',
          'libs/shared-*/**',
        ],
        ['run', '--passWithNoTests', 'tests/good-first-issue-guidance-contract.test.ts'],
      ]);
      expect(result).toEqual({
        testFiles: 16,
        readerTests: ['tests/good-first-issue-guidance-contract.test.ts'],
        notRun: [],
      });
      const log = output.join('\n');
      expect(log).toContain('CONTRIBUTING.md → tests/good-first-issue-guidance-contract.test.ts');
      expect(log).toContain('Test Files  2 passed (2)');
      expect(log).toContain('Affected tests passed (16 test file(s))');
    });

    it('never reports a pass when no test file ran', () => {
      const output: string[] = [];
      const runs: string[][] = [];
      runAffectedTests((v) => output.push(String(v)), undefined, {
        git: fakeGit(['libs/core/a.ts']),
        vitest: (args) => {
          runs.push(args);
          return {
            status: 0,
            stdout: 'No test files found, exiting with code 0\n',
            stderr: '',
          };
        },
        exists: always,
      });
      const log = output.join('\n');
      expect(log).toContain('0 test files ran');
      expect(log).not.toContain('Affected tests passed');
      expect(runs).toHaveLength(7);
      expect(runs.slice(0, 6)).toEqual(coreCodeRuns());
    });

    it('does not run the code selection when a vitest rerun trigger changed', () => {
      const runs: string[][] = [];
      const output: string[] = [];
      const result = runAffectedTests((v) => output.push(String(v)), undefined, {
        git: fakeGit(['libs/core/a.ts', 'package.json']),
        vitest: (args) => {
          runs.push(args);
          return passed(1);
        },
        exists: always,
      });
      expect(runs).toEqual([]);
      expect(result.notRun[0]).toContain('package.json changed');
      expect(output.join('\n')).toContain('NOT RUN — code tests');
    });

    it('runs vitest in the CI environment, not the operator profile', () => {
      mocks.safeExecResult.mockReturnValue(passed(1));
      {
        runAffectedTests(() => undefined, undefined, {
          git: fakeGit(['libs/core/a.ts']),
          exists: always,
        });
        expect(mocks.safeExecResult).toHaveBeenCalledWith(
          process.execPath,
          [
            expect.stringContaining('vitest.mjs'),
            'run',
            '--changed',
            'abc123',
            '--passWithNoTests',
            ...TEST_SUITES.core,
            '--shard=1/6',
          ],
          expect.objectContaining({
            env: {
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
              CI: 'true',
              KYBERION_TEST_LEAK_STRICT: '1',
              KYBERION_BASE_ROLE: '',
              KYBERION_PERSONA: '',
              MISSION_ROLE: '',
              MISSION_ID: '',
              KYBERION_SUDO: '',
            },
            maxOutputMB: 50,
            timeoutMs: 2_400_000,
          })
        );
        expect(mocks.safeExecResult).toHaveBeenCalledTimes(7);
        for (const [, , options] of mocks.safeExecResult.mock.calls) {
          expect(options.timeoutMs).toBe(2_400_000);
          expect(options.maxOutputMB).toBe(50);
          expect(options.env.KYBERION_TEST_LEAK_STRICT).toBe('1');
        }
      }
    });

    it('classifies readers by canonical core ownership rather than a tests substring', () => {
      for (const file of [
        'libs/core/reader.test.ts',
        'libs/core/nested/__tests__/reader.test.ts',
        'libs/shared-network/src/reader.test.ts',
      ])
        expect(isCoreAffectedTest(file), file).toBe(true);
      for (const file of [
        'tests/libs/core/reader.test.ts',
        'scripts/reader.test.ts',
        'libs/actuators/example/__tests__/reader.test.ts',
        'libs/sharedness/reader.test.ts',
      ])
        expect(isCoreAffectedTest(file), file).toBe(false);
    });

    it('drains core code and exact readers before the non-core code and readers', () => {
      const readers = [
        'libs/core/reader.test.ts',
        'libs/shared-network/src/reader.test.ts',
        'tests/libs/core/reader.test.ts',
        'libs/actuators/example/src/reader.test.ts',
      ];
      const runs: string[][] = [];
      runAffectedTests(() => undefined, 'origin/main', {
        git: fakeGit(['libs/core/a.ts', 'CONTRIBUTING.md'], { 'CONTRIBUTING.md': readers }),
        exists: always,
        vitest: (args) => {
          runs.push(args);
          return passed(1);
        },
      });
      expect(runs).toEqual([
        ...coreCodeRuns(),
        [
          'run',
          '--passWithNoTests',
          ...readers.filter(isCoreAffectedTest),
          '--no-file-parallelism',
        ],
        [
          'run',
          '--changed',
          'abc123',
          '--passWithNoTests',
          ...ciTestPaths(),
          '--exclude',
          'libs/core/**',
          '--exclude',
          'libs/shared-*/**',
        ],
        ['run', '--passWithNoTests', ...readers.filter((file) => !isCoreAffectedTest(file)).sort()],
      ]);
      expect(CORE_AFFECTED_TEST_SHARDS).toBe(6);
      expect(runs.filter((args) => args.some((arg) => arg.startsWith('--shard=')))).toEqual(
        coreCodeRuns()
      );
      // The explicit core test selectors also present in ciPaths never duplicate
      // the canonical core phase, and the non-core phase excludes every core owner.
      expect(runs[0].filter((arg) => !arg.startsWith('-')).slice(2)).not.toContain(
        'libs/core/meeting/meeting-participation-coordinator.test.ts'
      );
    });

    it('does not launch empty reader groups and keeps exact core readers serial', () => {
      const runs: string[][] = [];
      runAffectedTests(() => undefined, undefined, {
        git: fakeGit(['CONTRIBUTING.md'], {
          'CONTRIBUTING.md': ['libs/core/reader.test.ts'],
        }),
        exists: always,
        vitest: (args) => {
          runs.push(args);
          return passed(1);
        },
      });
      expect(runs).toEqual([
        ['run', '--passWithNoTests', 'libs/core/reader.test.ts', '--no-file-parallelism'],
      ]);
    });

    it('collects failures and rejected launches while completing all later selections', () => {
      const runs: string[][] = [];
      let message = '';
      try {
        runAffectedTests(() => undefined, undefined, {
          git: fakeGit(['libs/core/a.ts', 'CONTRIBUTING.md'], {
            'CONTRIBUTING.md': ['libs/core/reader.test.ts', 'tests/reader.test.ts'],
          }),
          exists: always,
          vitest: (args) => {
            runs.push(args);
            if (runs.length === 1) throw new Error('synthetic launch failure');
            if (args.includes('libs/core/reader.test.ts'))
              return {
                status: 1,
                stdout: 'FAIL libs/core/reader.test.ts\nError: reader failure',
                stderr: '',
              };
            return passed(1);
          },
        });
      } catch (error) {
        message = String(error);
      }
      expect(runs).toHaveLength(9);
      expect(runs.slice(0, 6)).toEqual(coreCodeRuns());
      expect(runs[7]).toContain('--exclude');
      expect(runs[8]).toContain('tests/reader.test.ts');
      expect(message).toContain('core code shard 1/6 tests failed: synthetic launch failure');
      expect(message).toContain('core readers tests failed (exit 1)');
      expect(message).toContain('Error: reader failure');
    });

    it('retains early failure cases and their error when later stacks exceed the tail', () => {
      const stdout = [
        '\u001b[31m FAIL tests/first.test.ts > boundary case\u001b[0m',
        'AssertionError: original boundary failure',
        ...Array.from({ length: 60 }, (_, i) => 'later stack ' + i),
        'FAIL tests/last.test.ts > later case',
        'Error: later failure',
      ].join('\n');
      let message = '';
      try {
        runAffectedTests(() => undefined, undefined, {
          git: fakeGit(['libs/core/a.ts']),
          vitest: () => ({ status: 1, stdout, stderr: '' }),
          exists: always,
        });
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain('FAIL tests/first.test.ts > boundary case');
      expect(message).toContain('AssertionError: original boundary failure');
      expect(message).toContain('FAIL tests/last.test.ts > later case');
      expect(message).toContain('Error: later failure');
      expect(message).not.toContain('later stack 10');
    });

    it('fails preflight with the vitest output tail when a run fails', () => {
      expect(() =>
        runAffectedTests(() => undefined, undefined, {
          git: fakeGit(['libs/core/a.ts']),
          vitest: () => ({ status: 1, stdout: 'FAIL tests/x.test.ts\n', stderr: '' }),
          exists: always,
        })
      ).toThrow(/core code shard 1\/6 tests failed \(exit 1\)[\s\S]*FAIL tests\/x\.test\.ts/u);
    });
  });
});
