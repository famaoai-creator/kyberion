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

import { main, PREFLIGHT_PR_CLI, runAffectedTests } from './pr_preflight.js';
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
        ['run', '--changed', 'abc123', '--passWithNoTests', ...ciTestPaths()],
        ['run', '--passWithNoTests', 'tests/good-first-issue-guidance-contract.test.ts'],
      ]);
      expect(result).toEqual({
        testFiles: 4,
        readerTests: ['tests/good-first-issue-guidance-contract.test.ts'],
        notRun: [],
      });
      const log = output.join('\n');
      expect(log).toContain('CONTRIBUTING.md → tests/good-first-issue-guidance-contract.test.ts');
      expect(log).toContain('Test Files  2 passed (2)');
      expect(log).toContain('Affected tests passed (4 test file(s))');
    });

    it('never reports a pass when no test file ran', () => {
      const output: string[] = [];
      runAffectedTests((v) => output.push(String(v)), undefined, {
        git: fakeGit(['libs/core/a.ts']),
        vitest: () => ({
          status: 0,
          stdout: 'No test files found, exiting with code 0\n',
          stderr: '',
        }),
        exists: always,
      });
      const log = output.join('\n');
      expect(log).toContain('0 test files ran');
      expect(log).not.toContain('Affected tests passed');
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
            ...ciTestPaths(),
          ],
          expect.objectContaining({
            env: {
              LANG: 'C.UTF-8',
              LC_ALL: 'C.UTF-8',
              CI: 'true',
              KYBERION_TEST_LEAK_STRICT: '1',
              KYBERION_PERSONA: '',
              MISSION_ROLE: '',
              MISSION_ID: '',
              KYBERION_SUDO: '',
            },
            maxOutputMB: 50,
          })
        );
      }
    });

    it('fails preflight with the vitest output tail when a run fails', () => {
      expect(() =>
        runAffectedTests(() => undefined, undefined, {
          git: fakeGit(['libs/core/a.ts']),
          vitest: () => ({ status: 1, stdout: 'FAIL tests/x.test.ts\n', stderr: '' }),
          exists: always,
        })
      ).toThrow(/code tests failed \(exit 1\)[\s\S]*FAIL tests\/x\.test\.ts/u);
    });
  });
});
