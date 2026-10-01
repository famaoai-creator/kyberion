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

import {
  PRE_PR_READINESS_CHECKLIST,
  buildGhArgs,
  main,
  parseDefaultBranchResponse,
  parsePublishArgs,
  resolveKnowledgeDiffBase,
  resolvePublishTitle,
  runKnowledgeReadinessGate,
} from './publish_pull_request.js';

/** Default `safeExec` stub covering every gh/git call `main()` makes before `gh pr create`. */
function stubGhAndGit(): void {
  mocks.safeExec.mockImplementation((command: string, args: string[] = []) => {
    if (command === 'gh' && args[0] === '--version') return 'gh version 2.0.0\n';
    if (command === 'gh' && args[0] === 'auth') return 'Logged in to github.com\n';
    if (command === 'gh' && args[0] === 'repo') return '{"defaultBranchRef":{"name":"main"}}';
    if (command === 'git' && args[0] === 'branch') return 'agent/kl-03\n';
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
    expect(source).toContain("['check', '--', '--scope', 'pr']");
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
  beforeEach(() => {
    vi.resetAllMocks();
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
    expect(mocks.safeExec).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['pr', 'create']),
      expect.anything()
    );
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
