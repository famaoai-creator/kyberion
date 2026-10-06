import { describe, expect, it } from 'vitest';
import {
  ghPrChecks,
  ghPrChecksWait,
  ghPrCreate,
  ghPrMerge,
  ghRepoDefaultBranch,
  type PrCheckEntry,
} from './github.js';
import {
  gitCheckout,
  gitDiffChangedPaths,
  gitPull,
  gitPush,
  gitWorktree,
  type VcsCommandRunner,
} from './git.js';

function stubRunner(
  handlers: Array<{ match: (args: string[]) => boolean; stdout: string; status?: number }>
): { run: VcsCommandRunner; calls: string[][] } {
  const calls: string[][] = [];
  const run: VcsCommandRunner = (_command, args) => {
    calls.push(args);
    const handler = handlers.find((h) => h.match(args));
    if (!handler) return { stdout: '', stderr: `unexpected: ${args.join(' ')}`, status: 1 };
    return { stdout: handler.stdout, stderr: '', status: handler.status ?? 0 };
  };
  return { run, calls };
}

const checksJson = (checks: PrCheckEntry[]) => JSON.stringify(checks);

describe('libs/core/vcs', () => {
  it('ghPrChecks maps buckets to a verdict (pending wins over pass)', () => {
    const { run } = stubRunner([
      {
        match: (a) => a[1] === 'checks',
        stdout: checksJson([
          { name: 'build', bucket: 'pass' },
          { name: 'lint', bucket: 'pending' },
        ]),
        status: 1, // gh exits non-zero while pending
      },
    ]);
    const result = ghPrChecks({ ref: '12' }, run);
    expect(result.state).toBe('pending');
    expect(result.pending).toEqual(['lint']);
  });

  it('ghPrChecks returns failure with failing names and honors ignore list', () => {
    const { run } = stubRunner([
      {
        match: (a) => a[1] === 'checks',
        stdout: checksJson([
          { name: 'build', bucket: 'fail' },
          { name: 'flaky', bucket: 'fail' },
          { name: 'lint', bucket: 'pass' },
        ]),
        status: 8,
      },
    ]);
    const result = ghPrChecks({ ref: '12', ignore: ['flaky'] }, run);
    expect(result.state).toBe('failure');
    expect(result.failing).toEqual(['build']);
  });

  it('ghPrChecks returns none for an empty payload', () => {
    const { run } = stubRunner([{ match: (a) => a[1] === 'checks', stdout: '', status: 0 }]);
    expect(ghPrChecks({ ref: '12' }, run).state).toBe('none');
  });

  it('ghPrChecksWait polls until terminal (pending → success)', async () => {
    const { run, calls } = stubRunner([
      {
        match: (a) => a[1] === 'checks',
        stdout: checksJson([{ name: 'build', bucket: 'pending' }]),
        status: 1,
      },
    ]);
    // Flip to success after the first poll by mutating the stub.
    let result = await ghPrChecksWait(
      { ref: '9', intervalMs: 1_000, timeoutMs: 60_000 },
      ((command, args, options) => {
        const out = run(command, args, options);
        if (calls.length > 1) {
          return { stdout: checksJson([{ name: 'build', bucket: 'pass' }]), stderr: '', status: 0 };
        }
        return out;
      }) as VcsCommandRunner,
      async () => {}
    );
    expect(result.state).toBe('success');
    expect(result.timed_out).toBe(false);
    expect(calls.filter((a) => a[1] === 'checks').length).toBe(2);
  });

  it('ghPrChecksWait keeps polling while no checks are reported yet', async () => {
    const { run, calls } = stubRunner([
      { match: (a) => a[1] === 'checks', stdout: '[]', status: 1 },
    ]);
    let callCount = 0;
    const result = await ghPrChecksWait(
      { ref: '9', intervalMs: 1_000, timeoutMs: 60_000 },
      ((command, args, options) => {
        callCount += 1;
        if (callCount >= 3) {
          return { stdout: checksJson([{ name: 'build', bucket: 'pass' }]), stderr: '', status: 0 };
        }
        return run(command, args, options);
      }) as VcsCommandRunner,
      async () => {}
    );
    expect(result.state).toBe('success');
    expect(result.timed_out).toBe(false);
    expect(callCount).toBe(3);
  });

  it('ghPrChecksWait tolerates transient gh failures before succeeding', async () => {
    let callCount = 0;
    const result = await ghPrChecksWait(
      { ref: '9', intervalMs: 1_000, timeoutMs: 60_000 },
      ((command, args) => {
        callCount += 1;
        if (callCount < 3) return { stdout: '', stderr: 'network blip', status: 1 };
        return { stdout: checksJson([{ name: 'build', bucket: 'pass' }]), stderr: '', status: 0 };
      }) as VcsCommandRunner,
      async () => {}
    );
    expect(result.state).toBe('success');
    expect(callCount).toBe(3);
  });

  it('ghPrChecksWait aborts after consecutive gh failures', async () => {
    const run: VcsCommandRunner = () => ({ stdout: '', stderr: 'boom', status: 1 });
    await expect(
      ghPrChecksWait({ ref: '9', intervalMs: 1_000, timeoutMs: 60_000 }, run, async () => {})
    ).rejects.toThrow(/VCS_GH_WAIT_FAILED/);
  });

  it('ghPrChecksWait reports timed_out when checks never settle', async () => {
    const { run } = stubRunner([
      {
        match: (a) => a[1] === 'checks',
        stdout: checksJson([{ name: 'build', bucket: 'pending' }]),
        status: 1,
      },
    ]);
    const result = await ghPrChecksWait(
      { ref: '9', intervalMs: 1_000, timeoutMs: 1_000 },
      run,
      async () => {}
    );
    expect(result.state).toBe('pending');
    expect(result.timed_out).toBe(true);
  });

  it('ghRepoDefaultBranch extracts defaultBranchRef.name', () => {
    const { run } = stubRunner([
      {
        match: (a) => a[0] === 'repo',
        stdout: JSON.stringify({ defaultBranchRef: { name: 'main' } }),
      },
    ]);
    expect(ghRepoDefaultBranch({}, run)).toBe('main');
  });

  it('ghPrCreate builds the argv contract (body-file wins, draft honored)', () => {
    const { run, calls } = stubRunner([
      { match: (a) => a[0] === 'pr' && a[1] === 'create', stdout: 'https://example/pull/1' },
    ]);
    const out = ghPrCreate(
      {
        title: 'T',
        body: 'ignored',
        bodyFile: '/tmp/b.md',
        base: 'main',
        head: 'f/x',
        draft: true,
      },
      run
    );
    expect(out.stdout).toContain('/pull/1');
    const argv = calls[0].join(' ');
    expect(argv).toContain('--body-file');
    expect(argv).toContain('--draft');
    expect(argv).not.toContain('--body ');
  });

  it('rejects flag-like values in every argv position (injection guard)', () => {
    const { run } = stubRunner([]);
    expect(() => gitCheckout('/x', '--force', {}, run)).toThrow(/VCS_GIT_INVALID/);
    const ghOps = [
      () => ghPrChecks({ ref: '--repo=evil/x' }, run),
      () => ghPrMerge({ ref: '--admin' }, run),
      () => ghPrCreate({ title: 't', head: '--repo=evil/x' }, run),
    ];
    for (const call of ghOps) expect(call).toThrow(/VCS_GIT_INVALID/);
    expect(() => gitPush('/x', { ref: '--force' }, run)).toThrow(/VCS_GIT_INVALID/);
    expect(() => gitPull('/x', { remote: '--all' }, run)).toThrow(/VCS_GIT_INVALID/);
    expect(() => gitWorktree('/x', 'add', { path: '-b' }, run)).toThrow(/VCS_GIT_INVALID/);
  });

  it('gitDiffChangedPaths parses the NUL-separated list', () => {
    const { run } = stubRunner([{ match: (a) => a[0] === 'diff', stdout: 'a.ts\0b/c.ts\0' }]);
    const { paths, result } = gitDiffChangedPaths('/x', { cached: true }, run);
    expect(result.status).toBe(0);
    expect(paths).toEqual(['a.ts', 'b/c.ts']);
  });

  it('gitWorktree requires a path for add/remove', () => {
    const { run, calls } = stubRunner([{ match: (a) => a[0] === 'worktree', stdout: '' }]);
    expect(() => gitWorktree('/x', 'add', {}, run)).toThrow(/requires params\.path/);
    gitWorktree('/x', 'add', { path: '../wt', ref: 'feat/y' }, run);
    expect(calls.at(-1)).toEqual(['worktree', 'add', '../wt', 'feat/y']);
  });
});
