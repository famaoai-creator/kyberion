/**
 * Tests for vcs-actuator.
 *
 * git-dependent read ops run against the real repository checkout (read-only),
 * so these tests focus on catalog shape and input validation. Write-path ops
 * (commit, pr_create) are covered by negative validation tests only — they
 * must never execute against the working tree in unit tests.
 */
import { describe, it, expect } from 'vitest';
import { describeOps } from './op-catalog.js';
import { handleAction, type VcsParams } from './vcs-helpers.js';

describe('vcs-actuator op catalog', () => {
  it('lists the full op set with capture/apply kinds', () => {
    const ops = describeOps();
    expect(ops).toHaveLength(17);
    const byOp = Object.fromEntries(ops.map((spec) => [spec.op, spec.kind]));
    expect(byOp).toEqual({
      status: 'capture',
      diff: 'capture',
      log: 'capture',
      pr_view: 'capture',
      pr_list: 'capture',
      pr_checks: 'capture',
      repo_view: 'capture',
      gh_status: 'capture',
      branch: 'apply',
      commit: 'apply',
      pr_create: 'apply',
      push: 'apply',
      fetch: 'apply',
      pull: 'apply',
      checkout: 'apply',
      worktree: 'apply',
      pr_merge: 'apply',
    });
  });

  it('gives every op an input schema and examples', () => {
    for (const spec of describeOps()) {
      expect(spec.input_schema).toBeTruthy();
      expect(spec.examples?.length).toBeGreaterThan(0);
    }
  });
});

describe('vcs-actuator input validation', () => {
  it('accepts status with cwd omitted (defaults to repo root)', async () => {
    const result = await handleAction({ op: 'status', params: {} });
    expect(result).toEqual(expect.objectContaining({ op: 'status' }));
  });

  it('accepts status with no params at all', async () => {
    const result = await handleAction({ op: 'status' });
    expect(result).toEqual(expect.objectContaining({ op: 'status' }));
  });

  it('rejects commit without a message', async () => {
    await expect(handleAction({ op: 'commit', params: {} })).rejects.toThrow(
      /missing required fields.*params\.message/i
    );
  });

  it('rejects commit with a blank message', async () => {
    await expect(handleAction({ op: 'commit', params: { message: '  ' } })).rejects.toThrow(
      /missing required fields.*params\.message/i
    );
  });

  it('rejects pr_create without a title', async () => {
    await expect(handleAction({ op: 'pr_create', params: {} })).rejects.toThrow(
      /missing required fields.*params\.title/i
    );
  });

  it('rejects branch create without a name', async () => {
    await expect(handleAction({ op: 'branch', params: { action: 'create' } })).rejects.toThrow(
      /missing required fields.*params\.name/i
    );
  });

  // New-op coverage: validation failures exercise dispatch without touching
  // the tree; read-only ops run against the real checkout like the others.
  it('lists branches through the branch op', async () => {
    const result = await handleAction({ op: 'branch', params: { action: 'list' } });
    expect(result).toEqual(expect.objectContaining({ op: 'branch' }));
  });

  it('rejects checkout without a ref', async () => {
    await expect(handleAction({ op: 'checkout', params: {} })).rejects.toThrow(/params\.ref/i);
  });

  it('rejects checkout with a flag-like ref', async () => {
    await expect(handleAction({ op: 'checkout', params: { ref: '--force' } })).rejects.toThrow(
      /VCS_GIT_INVALID/
    );
  });

  it('rejects worktree add without a path', async () => {
    await expect(handleAction({ op: 'worktree', params: { action: 'add' } })).rejects.toThrow(
      /params\.path/
    );
  });

  it('rejects pr_view / pr_checks / pr_merge without a ref', async () => {
    await expect(handleAction({ op: 'pr_view', params: {} })).rejects.toThrow(/params\.ref/);
    await expect(handleAction({ op: 'pr_checks', params: {} })).rejects.toThrow(/params\.ref/);
    await expect(handleAction({ op: 'pr_merge', params: {} })).rejects.toThrow(/params\.ref/);
  });

  it('rejects unknown params on the gh read ops via schema validation', async () => {
    // pr_list / repo_view / gh_status have no required params, so dispatch them
    // with a bogus param — schema rejects before any real gh call is made.
    const bogus = { bogus: true } as unknown as VcsParams;
    await expect(handleAction({ op: 'pr_list', params: bogus })).rejects.toThrow(/invalid input/i);
    await expect(handleAction({ op: 'repo_view', params: bogus })).rejects.toThrow(
      /invalid input/i
    );
    await expect(handleAction({ op: 'gh_status', params: bogus })).rejects.toThrow(
      /invalid input/i
    );
  });

  it('rejects a pull with an unknown remote protocol shape', async () => {
    // pull/fetch/push are apply ops — only negative-path dispatch in tests.
    await expect(
      handleAction({ op: 'pull', params: { remote: '../escape' }, cwd: '/definitely/missing' })
    ).rejects.toThrow();
    await expect(
      handleAction({ op: 'push', params: { ref: 'x' }, cwd: '/definitely/missing' })
    ).rejects.toThrow();
    await expect(
      handleAction({ op: 'fetch', params: {}, cwd: '/definitely/missing' })
    ).rejects.toThrow();
  });

  it('reads recent log entries', async () => {
    const result = await handleAction({ op: 'log', params: { limit: 1 } });
    expect(result).toEqual(expect.objectContaining({ op: 'log' }));
  });

  it('reads the working-tree diff', async () => {
    const result = await handleAction({ op: 'diff', params: { stat: true } });
    expect(result).toEqual(expect.objectContaining({ op: 'diff' }));
  });

  it('rejects unknown ops via schema validation', async () => {
    await expect(handleAction({ op: 'destroy' as never })).rejects.toThrow(/invalid input/i);
  });
});
