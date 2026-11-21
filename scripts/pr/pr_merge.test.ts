import { describe, expect, it, vi } from 'vitest';
import { approvalHint, formatDuration, main, parseMergeArgs } from './pr_merge.js';

describe('pr merge', () => {
  it('parses a PR ref with defaults', () => {
    expect(parseMergeArgs(['1534'])).toEqual({
      ref: '1534',
      checksTimeoutMinutes: 30,
      method: 'merge',
    });
    expect(
      parseMergeArgs([
        'https://github.com/o/r/pull/7',
        '--checks-timeout-minutes',
        '45',
        '--method',
        'squash',
      ])
    ).toEqual({ ref: 'https://github.com/o/r/pull/7', checksTimeoutMinutes: 45, method: 'squash' });
  });

  it('rejects refs and values that are not what they claim', () => {
    expect(() => parseMergeArgs([])).toThrow(/exactly one/);
    expect(() => parseMergeArgs(['main'])).toThrow(/not a PR number/);
    expect(() => parseMergeArgs(['007'])).toThrow(/not a PR number/);
    expect(() => parseMergeArgs(['https://evil/pull/1'])).toThrow(/not a PR number/);
    expect(() => parseMergeArgs(['1', '--checks-timeout-minutes', '0'])).toThrow(/1 to 180/);
    expect(() => parseMergeArgs(['1', '--method', 'force'])).toThrow(/--method/);
  });

  it('merges through the governed wait-then-merge verb and reports the merged head', async () => {
    const merge = vi.fn(async () => ({
      merged: true as const,
      number: 7,
      headSha: 'a'.repeat(40),
      waited_ms: 61_000,
    }));
    const lines: string[] = [];
    await main(['7', '--checks-timeout-minutes', '5'], (line) => lines.push(String(line)), merge);
    expect(merge).toHaveBeenCalledWith(
      expect.objectContaining({
        ref: '7',
        method: 'merge',
        deleteBranch: true,
        checksTimeoutMs: 300_000,
      })
    );
    expect(lines.at(-1)).toBe(
      '[pr:merge] Merged #7 at aaaaaaaaaa and deleted its branch (waited 1m01s for checks).'
    );
  });

  it('turns the merge approval request into the command that decides it', async () => {
    const merge = vi.fn(async () => {
      throw new Error('[EXTERNAL_APPROVAL_REQUIRED] needs approval | approval: req-42');
    });
    await expect(main(['7'], () => undefined, merge)).rejects.toThrow(
      'next: pnpm kyberion approvals --approve req-42, then rerun pnpm kyberion pr merge 7'
    );
    expect(approvalHint(new Error('other'), '7')).toBeUndefined();
  });

  it('formats the wait', () => {
    expect(formatDuration(412_000)).toBe('6m52s');
    expect(formatDuration(9_400)).toBe('9s');
  });

  it('surfaces a refusal instead of merging', async () => {
    const merge = vi.fn(async () => {
      throw new Error('[PR_MERGE_CHECKS_NOT_GREEN] merge refused; checks state=failure');
    });
    await expect(main(['7'], () => undefined, merge)).rejects.toThrow(/CHECKS_NOT_GREEN/);
  });
});
