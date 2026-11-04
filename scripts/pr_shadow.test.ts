import { describe, expect, it } from 'vitest';
import {
  createGhPrPort,
  formatObserveResult,
  formatPrShadowSummary,
  runPrShadow,
} from './pr_shadow.js';

function runnerFor(responses: Record<string, { stdout: string; status: number }>) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    const key = args.slice(0, 3).join(' ');
    // The vcs-host seam resolves the canonical repository before each read.
    if (key === 'repo view --json')
      return {
        stdout: JSON.stringify({ nameWithOwner: 'o/r', url: 'https://github.com/o/r' }),
        status: 0,
      };
    const response = responses[key];
    if (!response) throw new Error(`unexpected gh call: ${args.join(' ')}`);
    return response;
  };
  return { run, calls };
}

describe('createGhPrPort', () => {
  it('lists open PRs with their head commit and draft flag', async () => {
    const { run, calls } = runnerFor({
      'pr list --repo': {
        status: 0,
        stdout: JSON.stringify([
          {
            number: 7,
            title: 'feat: x',
            headRefOid: 'abc',
            isDraft: true,
            author: { login: 'me' },
          },
        ]),
      },
    });
    expect(await createGhPrPort(run).listOpen()).toEqual([
      { number: 7, title: 'feat: x', headSha: 'abc', isDraft: true, author: 'me' },
    ]);
    expect(calls.find((args) => args[1] === 'list')).toContain('--state');
  });

  it('only ever uses read-only gh subcommands', async () => {
    const { run, calls } = runnerFor({
      'pr list --repo': { status: 0, stdout: '[]' },
      'pr view 7': { status: 0, stdout: JSON.stringify({ files: [], state: 'OPEN' }) },
      'pr checks 7': { status: 0, stdout: '[]' },
    });
    const port = createGhPrPort(run);
    await port.listOpen();
    await port.files(7);
    await port.ciState(7, []);
    await port.finalState(7);
    for (const args of calls) expect(['list', 'view', 'checks']).toContain(args[1]);
  });

  it('reads changed files with their line counts', async () => {
    const { run } = runnerFor({
      'pr view 7': {
        status: 0,
        stdout: JSON.stringify({ files: [{ path: 'docs/a.md', additions: 3, deletions: 1 }] }),
      },
    });
    expect(await createGhPrPort(run).files(7)).toEqual([
      { path: 'docs/a.md', additions: 3, deletions: 1 },
    ]);
  });

  it('judges CI from the checks that remain after the ignored ones', async () => {
    const checks = (list: Array<{ name: string; bucket: string }>) =>
      runnerFor({ 'pr checks 7': { status: 8, stdout: JSON.stringify(list) } });
    const failing = [
      { name: 'github-advanced-security', bucket: 'fail' },
      { name: 'lint', bucket: 'pass' },
    ];
    expect(
      await createGhPrPort(checks(failing).run).ciState(7, ['github-advanced-security'])
    ).toEqual({
      state: 'success',
      failing: [],
    });
    expect(await createGhPrPort(checks(failing).run).ciState(7, [])).toEqual({
      state: 'failure',
      failing: ['github-advanced-security'],
    });
    expect(
      await createGhPrPort(checks([{ name: 'tests', bucket: 'pending' }]).run).ciState(7, [])
    ).toEqual({ state: 'pending', failing: [] });
    expect(
      await createGhPrPort(runnerFor({ 'pr checks 7': { status: 1, stdout: '' } }).run).ciState(
        7,
        []
      )
    ).toEqual({ state: 'none', failing: [] });
    // malformed-but-successful gh output fails closed instead of reading as 'none'
    expect(
      await createGhPrPort(
        runnerFor({ 'pr checks 7': { status: 0, stdout: 'not-json{' } }).run
      ).ciState(7, [])
    ).toEqual({ state: 'failure', failing: ['gh-pr-checks-parse'] });
  });

  it('maps merged and closed PRs to their final state', async () => {
    const port = (state: string) =>
      createGhPrPort(
        runnerFor({
          'pr view 7': {
            status: 0,
            stdout: JSON.stringify({ state, mergedAt: '2026-10-05T00:00:00Z', closedAt: 'c' }),
          },
        }).run
      );
    expect(await port('MERGED').finalState(7)).toEqual({
      state: 'merged',
      at: '2026-10-05T00:00:00Z',
    });
    expect(await port('CLOSED').finalState(7)).toEqual({ state: 'closed', at: 'c' });
    expect(await port('OPEN').finalState(7)).toEqual({ state: 'open' });
  });

  it('fails a read when gh itself fails, instead of recording a guess', async () => {
    const { run } = runnerFor({ 'pr view 7': { status: 1, stdout: '' } });
    await expect(createGhPrPort(run).files(7)).rejects.toThrow('gh pr view failed');
  });
});

describe('formatting and arguments', () => {
  it('explains that shadow mode changes nothing', async () => {
    const text = formatPrShadowSummary({
      observed_prs: 2,
      settled_prs: 1,
      by_tier: [
        {
          tier: 'low',
          settled: 1,
          merged: 1,
          closed: 0,
          agreed: 1,
          false_positive: 0,
          merged_despite_ci: 0,
        },
      ],
      readiness: { low: 'collecting: 1/30 settled PRs', medium: '', high: '' },
    });
    expect(text).toContain('2 observed, 1 settled');
    expect(text).toContain('collecting: 1/30');
    expect(text).toContain('nothing was merged');
  });

  it('lists observe errors', async () => {
    expect(
      formatObserveResult({
        observed: 1,
        unchanged: 0,
        outcomes: 0,
        skippedDrafts: 0,
        errors: ['#1: boom'],
      })
    ).toContain('error: #1: boom');
  });

  it('rejects an unknown command and a bare --ignore-check', async () => {
    process.exitCode = undefined;
    try {
      expect(await runPrShadow(['merge'])).toBeUndefined();
      expect(process.exitCode).toBe(2);
      process.exitCode = undefined;
      expect(await runPrShadow(['observe', '--ignore-check'])).toBeUndefined();
      expect(process.exitCode).toBe(2);
    } finally {
      process.exitCode = undefined;
    }
  });
});
