import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core';

const mocks = vi.hoisted(() => ({
  safeExec: vi.fn(),
  safeReadFile: vi.fn(),
  checkPrKnowledgeReadiness: vi.fn(),
  ghPrCreate: vi.fn(),
}));

vi.mock('@agent/core/vcs', async (original) => ({
  ...(await original<typeof import('@agent/core/vcs')>()),
  ghPrCreate: mocks.ghPrCreate,
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

import {
  PRE_PR_READINESS_CHECKLIST,
  buildGhArgs,
  buildReadinessCheckArgs,
  main,
  parseDefaultBranchResponse,
  parsePublishArgs,
  resolveKnowledgeDiffBase,
  resolvePublishTitle,
  runKnowledgeReadinessGate,
  runPrePrReadiness,
} from './publish_pull_request.js';

/** Default `safeExec` stub covering every gh/git call `main()` makes before `gh pr create`. */
function stubGhAndGit(): void {
  mocks.ghPrCreate.mockReturnValue({
    status: 0,
    stdout: 'https://github.com/acme/repo/pull/1\n',
    stderr: '',
  });
  mocks.safeExec.mockImplementation((command: string, args: string[] = []) => {
    if (command === 'gh' && args[0] === '--version') return 'gh version 2.0.0\n';
    if (command === 'gh' && args[0] === 'auth') return 'Logged in to github.com\n';
    if (command === 'gh' && args[0] === 'repo') return '{"defaultBranchRef":{"name":"main"}}';
    if (command === 'git' && args[0] === 'branch') return 'agent/kl-03\n';
    if (command === 'git' && args[0] === 'rev-parse') return 'a'.repeat(40) + '\n';
    if (command === 'gh' && args[0] === 'pr') return 'https://github.com/acme/repo/pull/1\n';
    throw new Error(`unexpected safeExec(${command}, ${JSON.stringify(args)})`);
  });
}

describe('publish_pull_request', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('parses explicit publish flags', () => {
    const options = parsePublishArgs(['--title', 'fix(pr): validate before publish', '--no-fill']);
    expect(options.title).toBe('fix(pr): validate before publish');
    expect(options.fill).toBe(false);
    expect(options.draft).toBe(true);
    expect(options.skipReadiness).toBe(false);
  });

  it('parses --skip-readiness for emergency bypass', () => {
    const options = parsePublishArgs([
      '--title',
      'fix(pr): validate before publish',
      '--skip-readiness',
    ]);
    expect(options.skipReadiness).toBe(true);
  });

  it('parses --mission-root (KL-03)', () => {
    const options = parsePublishArgs(['--mission-root', '/main/checkout']);
    expect(options.missionRoot).toBe('/main/checkout');
    expect(parsePublishArgs([]).missionRoot).toBeUndefined();
  });

  it('rejects a non-conventional PR title before publish', () => {
    expect(() => resolvePublishTitle('[codex] update docs')).toThrow(/Conventional Commit header/);
  });

  it('builds a guarded gh pr create command', () => {
    const args = buildGhArgs(
      {
        title: 'fix(pr): validate before publish',
        draft: true,
        fill: true,
        skipReadiness: false,
      },
      { head: 'codex/pr-guard', defaultBranch: 'main' }
    );

    expect(args).toEqual([
      'pr',
      'create',
      '--draft',
      '--fill',
      '--title',
      'fix(pr): validate before publish',
      '--base',
      'main',
      '--head',
      'codex/pr-guard',
    ]);
  });

  it('rejects unsafe default-branch responses before publish', () => {
    expect(parseDefaultBranchResponse('{"defaultBranchRef":{"name":"main"}}')).toBe('main');
    expect(() =>
      parseDefaultBranchResponse('{"defaultBranchRef":{"__proto__":{"name":"evil"}}}')
    ).toThrow('dangerous JSON key');
  });

  it('routes gh output through the shared harness printer and wires readiness', async () => {
    // Bypass this file's `safeExec`/`safeReadFile` mock (below) to read the
    // real script source rather than whatever the current test set the mock
    // to return.
    const actualSecureIo =
      await vi.importActual<typeof import('@agent/core/secure-io')>('@agent/core/secure-io');
    const source = String(
      actualSecureIo.safeReadFile(pathResolver.rootResolve('scripts/publish_pull_request.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
    expect(source).toContain('runPrePrReadiness');
    expect(source).toContain('--skip-readiness');
    expect(source).toContain(PRE_PR_READINESS_CHECKLIST);
    expect(source).toContain("['check', '--', '--changed']");
    expect(source).toContain('checkPrKnowledgeReadiness');
    expect(source).toContain('--mission-root');
  });
});

describe('resolveKnowledgeDiffBase (KL-03 diff-base fix)', () => {
  it('defaults to origin/main', () => {
    expect(resolveKnowledgeDiffBase(undefined)).toBe('origin/main');
    expect(resolveKnowledgeDiffBase('')).toBe('origin/main');
  });

  it('maps a bare branch name to origin/<base>', () => {
    expect(resolveKnowledgeDiffBase('main')).toBe('origin/main');
    expect(resolveKnowledgeDiffBase('release-1.2')).toBe('origin/release-1.2');
    expect(resolveKnowledgeDiffBase('release/2026-10')).toBe('origin/release/2026-10');
  });

  it('leaves an already-qualified ref alone', () => {
    expect(resolveKnowledgeDiffBase('origin/main')).toBe('origin/main');
    expect(resolveKnowledgeDiffBase('refs/heads/main')).toBe('refs/heads/main');
  });

  it('rejects a ref with a leading dash (argument-injection guard)', () => {
    expect(() => resolveKnowledgeDiffBase('--upload-pack=evil')).toThrow(/not a valid git ref/);
  });
});

describe('runKnowledgeReadinessGate (KL-03)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('fails closed with no --body-file (e.g. --fill) without calling the readiness evaluator', () => {
    expect(() =>
      runKnowledgeReadinessGate({
        draft: true,
        fill: true,
        skipReadiness: false,
      })
    ).toThrow();
    expect(mocks.checkPrKnowledgeReadiness).not.toHaveBeenCalled();
  });

  it('reads --body-file and evaluates readiness; passes through when ok', () => {
    mocks.safeReadFile.mockReturnValue('## Knowledge\nnone — no mission for this PR\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({ ok: true, violations: [] });

    expect(() =>
      runKnowledgeReadinessGate({
        draft: true,
        fill: true,
        skipReadiness: false,
        bodyFile: 'body.md',
        missionRoot: '/main/checkout',
      })
    ).not.toThrow();

    expect(mocks.checkPrKnowledgeReadiness).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '## Knowledge\nnone — no mission for this PR\n',
        missionRootInput: expect.objectContaining({ explicitRoot: '/main/checkout' }),
        base: 'origin/main',
      })
    );
  });

  it('maps a bare --base branch name to origin/<base> before the readiness check', () => {
    mocks.safeReadFile.mockReturnValue('## Knowledge\nnone — no mission for this PR\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({ ok: true, violations: [] });

    runKnowledgeReadinessGate({
      draft: true,
      fill: true,
      skipReadiness: false,
      bodyFile: 'body.md',
      base: 'release-1.2',
    });

    expect(mocks.checkPrKnowledgeReadiness).toHaveBeenCalledWith(
      expect.objectContaining({ base: 'origin/release-1.2' })
    );
  });

  it('throws without calling gh when the evaluator reports a violation', () => {
    mocks.safeReadFile.mockReturnValue('## Summary\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({
      ok: false,
      violations: [{ code: 'missing_knowledge_section', message: 'no Knowledge section' }],
    });

    expect(() =>
      runKnowledgeReadinessGate({
        draft: true,
        fill: true,
        skipReadiness: false,
        bodyFile: 'body.md',
      })
    ).toThrow();
  });
});

describe('main() wiring (KL-03)', () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each(['GH_TOKEN', 'GITHUB_TOKEN'])('forwards %s only to gh subprocesses', async (name) => {
    vi.stubEnv('GH_TOKEN', undefined);
    vi.stubEnv('GITHUB_TOKEN', undefined);
    vi.stubEnv(name, 'fake-github-credential');
    vi.stubEnv('ANTHROPIC_API_KEY', 'fake-unrelated-credential');
    stubGhAndGit();
    mocks.safeReadFile.mockReturnValue('## Knowledge\nnone — no mission for this test\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({ ok: true, violations: [] });
    await main([
      '--title',
      'fix(pr): preserve authentication',
      '--body-file',
      'body.md',
      '--skip-readiness',
    ]);
    const ghCalls = mocks.safeExec.mock.calls.filter(([command]) => command === 'gh');
    expect(ghCalls.map(([, args]) => args[0])).toEqual(['--version', 'auth', 'repo']);
    expect(mocks.ghPrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          GH_TOKEN: undefined,
          GITHUB_TOKEN: undefined,
          [name]: 'fake-github-credential',
        },
      })
    );
    for (const [, , options] of ghCalls) {
      expect(options.env).toEqual({
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        [name]: 'fake-github-credential',
      });
    }
    for (const [command, , options] of mocks.safeExec.mock.calls) {
      if (command !== 'gh') expect(options.env).toBeUndefined();
    }
  });

  it('runs the knowledge check even with --skip-readiness, and still calls gh when it passes', async () => {
    stubGhAndGit();
    mocks.safeReadFile.mockReturnValue('## Knowledge\nnone — no mission for this PR\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({ ok: true, violations: [] });

    await main([
      '--title',
      'fix(pr): guard knowledge readiness',
      '--body-file',
      'body.md',
      '--skip-readiness',
    ]);

    expect(mocks.checkPrKnowledgeReadiness).toHaveBeenCalledTimes(1);
    expect(mocks.safeExec).not.toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['check']),
      expect.anything()
    );
    expect(mocks.ghPrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'fix(pr): guard knowledge readiness',
        base: 'main',
        head: 'agent/kl-03',
        bodyFile: 'body.md',
        draft: true,
      })
    );
    expect(
      mocks.safeExec.mock.calls.some(([command, args]) => command === 'gh' && args[0] === 'pr')
    ).toBe(false);
  });

  it('aborts before calling gh pr create when the knowledge check fails, even with --skip-readiness', async () => {
    stubGhAndGit();
    mocks.safeReadFile.mockReturnValue('## Summary\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({
      ok: false,
      violations: [{ code: 'missing_knowledge_section', message: 'no Knowledge section' }],
    });

    await expect(
      main([
        '--title',
        'fix(pr): guard knowledge readiness',
        '--body-file',
        'body.md',
        '--skip-readiness',
      ])
    ).rejects.toThrow();

    const prCreateCalls = mocks.safeExec.mock.calls.filter(
      ([command, args]) => command === 'gh' && Array.isArray(args) && args[0] === 'pr'
    );
    expect(prCreateCalls).toEqual([]);
    expect(mocks.ghPrCreate).not.toHaveBeenCalled();
  });

  it('preserves typed approval suspension without a generic mutation fallback', async () => {
    stubGhAndGit();
    const body = '  ## Knowledge\nnone — exact reviewed body\n\n';
    mocks.safeReadFile.mockReturnValue(body);
    mocks.checkPrKnowledgeReadiness.mockReturnValue({ ok: true, violations: [] });
    const pending = Object.assign(new Error('EXTERNAL_APPROVAL_REQUIRED'), {
      adfControlFlow: 'preflight',
    });
    mocks.ghPrCreate.mockImplementation(() => {
      throw pending;
    });
    await expect(
      main([
        '--title',
        'fix(pr): typed publication',
        '--body-file',
        'review body.md',
        '--skip-readiness',
        '--no-draft',
      ])
    ).rejects.toBe(pending);
    expect(mocks.checkPrKnowledgeReadiness).toHaveBeenCalledWith(expect.objectContaining({ body }));
    expect(mocks.ghPrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ bodyFile: 'review body.md', draft: false })
    );
    expect(
      mocks.safeExec.mock.calls.some(([command, args]) => command === 'gh' && args[0] === 'pr')
    ).toBe(false);
  });

  it('reports typed transport failure instead of printing a successful publication', async () => {
    stubGhAndGit();
    mocks.safeReadFile.mockReturnValue('## Knowledge\nnone\n');
    mocks.checkPrKnowledgeReadiness.mockReturnValue({ ok: true, violations: [] });
    mocks.ghPrCreate.mockReturnValue({ status: 1, stdout: '', stderr: 'publication failed' });
    await expect(
      main(['--title', 'fix(pr): typed publication', '--body-file', 'body.md', '--skip-readiness'])
    ).rejects.toThrow('publication failed');
  });

  it('aborts before calling gh pr create when --body-file is missing (e.g. --fill)', async () => {
    stubGhAndGit();

    await expect(
      main(['--title', 'fix(pr): guard knowledge readiness', '--skip-readiness'])
    ).rejects.toThrow();

    expect(mocks.checkPrKnowledgeReadiness).not.toHaveBeenCalled();
    const prCreateCalls = mocks.safeExec.mock.calls.filter(
      ([command, args]) => command === 'gh' && Array.isArray(args) && args[0] === 'pr'
    );
    expect(prCreateCalls).toEqual([]);
  });

  describe('CU-01 --help never creates a pull request', () => {
    it.each([['--help'], ['-h'], ['--title', 'fix(pr): x', '--help']])(
      'prints usage for %j without calling gh, git, or the readiness gates',
      async (...argv) => {
        stubGhAndGit();
        const output: unknown[] = [];
        await main(argv, (value) => output.push(value));
        expect(mocks.safeExec).not.toHaveBeenCalled();
        expect(mocks.safeReadFile).not.toHaveBeenCalled();
        expect(mocks.checkPrKnowledgeReadiness).not.toHaveBeenCalled();
        expect(String(output[0])).toContain('pnpm kyberion pr create');
        expect(String(output[0])).toContain('--body-file');
      }
    );

    it('rejects unknown flags before any gh call', async () => {
      stubGhAndGit();
      await expect(main(['--titel', 'fix(pr): typo'])).rejects.toMatchObject({ code: 2 });
      expect(mocks.safeExec).not.toHaveBeenCalled();
    });
  });
});

describe('publication check concurrency', () => {
  beforeEach(() => vi.resetAllMocks());

  it('parses bounded --check-jobs without changing defaults', () => {
    expect(parsePublishArgs([]).checkJobs).toBeUndefined();
    for (let jobs = 1; jobs <= 6; jobs++) {
      expect(parsePublishArgs(['--check-jobs', String(jobs)]).checkJobs).toBe(jobs);
    }
  });

  it.each(['0', '7', '-1', '1.5', '', '01', '1e0', 'NaN', ' 1'])(
    'rejects invalid concurrency before any external operation: %j',
    async (value) => {
      await expect(main(['--check-jobs', value])).rejects.toThrow();
      expect(mocks.safeExec).not.toHaveBeenCalled();
      expect(mocks.checkPrKnowledgeReadiness).not.toHaveBeenCalled();
    }
  );

  it.each([
    ['--check-jobs'],
    ['--check-jobs', '1', '--check-jobs', '2'],
    ['--check-jobs=1', '--check-jobs', '2'],
  ])('rejects missing or duplicate concurrency before external operations: %j', async (...args) => {
    await expect(main(args)).rejects.toThrow();
    expect(mocks.safeExec).not.toHaveBeenCalled();
  });

  it.each([undefined, 1, 6])('forwards jobs=%s to the real readiness command', (jobs) => {
    mocks.safeExec.mockReturnValue('');
    const print = vi.fn();
    runPrePrReadiness(print, jobs);
    expect(mocks.safeExec).toHaveBeenCalledExactlyOnceWith(
      'pnpm',
      ['check', '--', '--changed', ...(jobs === undefined ? [] : ['--jobs', String(jobs)])],
      { cwd: pathResolver.rootDir(), timeoutMs: 1_800_000 }
    );
    expect(print).toHaveBeenLastCalledWith('[pr:publish] PR readiness gate passed.');
  });

  it('diffs the changed-path readiness gate against origin/<base> when --base is given', () => {
    expect(buildReadinessCheckArgs(undefined, 'main')).toEqual([
      'check',
      '--',
      '--changed',
      '--base',
      'origin/main',
    ]);
    expect(buildReadinessCheckArgs(2, 'origin/develop')).toEqual([
      'check',
      '--',
      '--changed',
      '--base',
      'origin/develop',
      '--jobs',
      '2',
    ]);
    expect(() => buildReadinessCheckArgs(undefined, '--upload-pack=x')).toThrow(
      'not a valid git ref name'
    );
  });

  it('forwards the option through main and prevents publication when readiness fails', async () => {
    mocks.safeExec.mockImplementation((command: string, args: string[]) => {
      if (command === 'pnpm') throw new Error('readiness fixture failed');
      if (command === 'gh' && args[0] === '--version') return 'gh version 2.0.0';
      if (command === 'gh' && args[0] === 'auth') return 'Logged in';
      throw new Error('unexpected operation');
    });
    await expect(main(['--check-jobs=1', '--title', 'fix(check): concurrency'])).rejects.toThrow(
      'readiness fixture failed'
    );
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'pnpm',
      ['check', '--', '--changed', '--jobs', '1'],
      expect.any(Object)
    );
    expect(
      mocks.safeExec.mock.calls.some(([command, args]) => command === 'gh' && args[0] === 'pr')
    ).toBe(false);
    expect(mocks.checkPrKnowledgeReadiness).not.toHaveBeenCalled();
  });
});
