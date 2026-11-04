import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  safeReadFile: vi.fn(),
  checkPrKnowledgeReadiness: vi.fn(),
}));

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeExec: mocks.safeExec,
  safeReadFile: mocks.safeReadFile,
}));

vi.mock('@agent/core/knowledge/pr-knowledge-readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/knowledge/pr-knowledge-readiness')>()),
  checkPrKnowledgeReadiness: mocks.checkPrKnowledgeReadiness,
}));

import { main, runAffectedTests } from './pr_preflight.js';

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

    it('runs vitest --changed for code and the reader tests for changed docs', () => {
      const runs: string[][] = [];
      const output: string[] = [];
      const result = runAffectedTests((v) => output.push(String(v)), undefined, {
        git: fakeGit(['libs/core/a.ts', 'CONTRIBUTING.md'], {
          'CONTRIBUTING.md': ['tests/good-first-issue-guidance-contract.test.ts'],
        }),
        run: (args) => runs.push(args),
      });
      expect(runs).toEqual([
        ['exec', 'vitest', 'run', '--changed', 'abc123', '--passWithNoTests'],
        [
          'exec',
          'vitest',
          'run',
          '--passWithNoTests',
          'tests/good-first-issue-guidance-contract.test.ts',
        ],
      ]);
      expect(result).toEqual({
        codeRun: true,
        readerTests: ['tests/good-first-issue-guidance-contract.test.ts'],
      });
      expect(output.join('\n')).toContain(
        'CONTRIBUTING.md → tests/good-first-issue-guidance-contract.test.ts'
      );
    });

    it('says so when nothing is selected instead of reporting a pass', () => {
      const runs: string[][] = [];
      const output: string[] = [];
      runAffectedTests((v) => output.push(String(v)), undefined, {
        git: fakeGit(['changelog.d/x.md']),
        run: (args) => runs.push(args),
      });
      expect(runs).toEqual([]);
      expect(output.join('\n')).toContain('No affected tests selected');
    });

    it('fails preflight when an affected test run fails', () => {
      expect(() =>
        runAffectedTests(() => undefined, undefined, {
          git: fakeGit(['libs/core/a.ts']),
          run: () => {
            throw new Error('vitest failed');
          },
        })
      ).toThrow('vitest failed');
    });
  });
});
