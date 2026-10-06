import { safeExecResult, type SafeExecOptions } from '../secure-io.js';

/**
 * Typed git verbs over the governed safeExecResult boundary — the single
 * implementation behind `vcs-actuator` and the scripts that used to embed
 * raw `safeExec('git', …)` argv. Per-mission-repo plumbing
 * (libs/core/mission/mission-git.ts & friends) intentionally stays direct:
 * those repos are the mission-owner-only contract, not this shared surface.
 *
 * Every helper takes an injectable `run` seam (default safeExecResult) so
 * callers with their own command-runner dependency (e.g. system-actuator's
 * PR lifecycle) keep their testability. Callers check `status` themselves —
 * `gh pr checks` legitimately exits non-zero while pending.
 */

export interface VcsCommandResult {
  stdout: string;
  stderr: string;
  status: number | null;
  error?: Error;
}

export type VcsCommandRunner = (
  command: string,
  args: string[],
  options?: SafeExecOptions
) => VcsCommandResult;

export function gitRun(
  args: string[],
  cwd: string,
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  return run('git', args, { cwd });
}

/** Reject a value that would land in an argv position but parses as a flag. */
export function assertNotFlagLike(value: string, label: string): void {
  if (!value.trim() || value.trim().startsWith('-') || /\s/u.test(value.trim())) {
    throw new Error(`[VCS_GIT_INVALID] ${label} must be a non-empty, non-flag value`);
  }
}

export function gitStatus(
  cwd: string,
  options: { short?: boolean; untracked?: boolean } = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  const args = ['status'];
  if (options.short) args.push('--short');
  if (options.untracked === false) args.push('--untracked-files=no');
  return gitRun(args, cwd, run);
}

export function gitDiff(
  cwd: string,
  options: {
    ref?: string;
    stat?: boolean;
    cached?: boolean;
    nameOnly?: boolean;
    diffFilter?: string;
  } = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  const args = ['diff'];
  if (options.stat) args.push('--stat');
  if (options.cached) args.push('--cached');
  if (options.nameOnly) args.push('--name-only');
  if (options.diffFilter) args.push(`--diff-filter=${options.diffFilter}`);
  if (options.ref?.trim()) args.push(options.ref.trim());
  return gitRun(args, cwd, run);
}

/** NUL-separated changed-path list (`--name-only -z`), parsed to entries. */
export function gitDiffChangedPaths(
  cwd: string,
  options: { cached?: boolean; diffFilter?: string } = {},
  run: VcsCommandRunner = safeExecResult
): { paths: string[]; result: VcsCommandResult } {
  const args = ['diff', '--name-only', '-z'];
  if (options.cached) args.push('--cached');
  if (options.diffFilter) args.push(`--diff-filter=${options.diffFilter}`);
  const result = gitRun(args, cwd, run);
  const paths =
    result.error || result.status !== 0 ? [] : result.stdout.split('\0').filter(Boolean);
  return { paths, result };
}

export function gitLog(
  cwd: string,
  options: { limit?: number; oneline?: boolean } = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  const args = ['log'];
  if (options.oneline) args.push('--oneline');
  if (Number.isInteger(options.limit) && Number(options.limit) > 0) {
    args.push('-n', String(options.limit));
  }
  return gitRun(args, cwd, run);
}

export function gitBranch(
  cwd: string,
  action: 'list' | 'create' | 'delete',
  name?: string,
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  if (action === 'list') return gitRun(['branch', '--list'], cwd, run);
  if (!name?.trim()) throw new Error(`[VCS_GIT_INVALID] branch ${action} requires a name`);
  assertNotFlagLike(name, 'branch name');
  return gitRun(
    action === 'create' ? ['branch', name.trim()] : ['branch', '-d', name.trim()],
    cwd,
    run
  );
}

export function gitCheckout(
  cwd: string,
  ref: string,
  options: { createBranch?: boolean } = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  assertNotFlagLike(ref, 'checkout ref');
  const args = ['checkout'];
  if (options.createBranch) args.push('-b');
  args.push(ref.trim());
  return gitRun(args, cwd, run);
}

export function gitAdd(
  cwd: string,
  paths: string[],
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult[] {
  // One `git add -- <path>` per path: keeps the call shape identical to the
  // historical callers (NUL-delimited filenames with spaces/newlines stay
  // intact) and lets callers see which path failed.
  return paths.map((p) => gitRun(['add', '--', p], cwd, run));
}

export function gitAddAll(cwd: string, run: VcsCommandRunner = safeExecResult): VcsCommandResult {
  return gitRun(['add', '-A'], cwd, run);
}

export function gitCommit(
  cwd: string,
  message: string,
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  if (!message.trim()) throw new Error('[VCS_GIT_INVALID] commit requires a message');
  return gitRun(['commit', '-m', message.trim()], cwd, run);
}

export function gitPush(
  cwd: string,
  options: { remote?: string; ref?: string; setUpstream?: boolean } = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  if (options.remote !== undefined) assertNotFlagLike(options.remote, 'remote');
  if (options.ref !== undefined) assertNotFlagLike(options.ref, 'ref');
  const args = ['push'];
  if (options.setUpstream) args.push('-u');
  args.push(options.remote?.trim() || 'origin');
  if (options.ref?.trim()) args.push(options.ref.trim());
  return gitRun(args, cwd, run);
}

export function gitFetch(
  cwd: string,
  options: { remote?: string; ref?: string } = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  const remote = options.remote?.trim() || 'origin';
  const ref = options.ref?.trim();
  if (remote.startsWith('--')) {
    throw new Error('[VCS_GIT_INVALID] remote must not start with "--"');
  }
  assertNotFlagLike(remote, 'remote');
  const args = ['fetch', remote];
  if (ref !== undefined) {
    if (ref.startsWith('--')) {
      throw new Error('[VCS_GIT_INVALID] ref must not start with "--"');
    }
    assertNotFlagLike(ref, 'ref');
    args.push(ref);
  }
  return gitRun(args, cwd, run);
}

export function gitPull(
  cwd: string,
  options: { remote?: string; ref?: string; ffOnly?: boolean } = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  const remote = options.remote?.trim() || 'origin';
  const ref = options.ref?.trim();
  if (remote.startsWith('--')) {
    throw new Error('[VCS_GIT_INVALID] remote must not start with "--"');
  }
  assertNotFlagLike(remote, 'remote');
  const args = ['pull'];
  if (options.ffOnly !== false) args.push('--ff-only');
  args.push(remote);
  if (ref !== undefined) {
    if (ref.startsWith('--')) {
      throw new Error('[VCS_GIT_INVALID] ref must not start with "--"');
    }
    assertNotFlagLike(ref, 'ref');
    args.push(ref);
  }
  return gitRun(args, cwd, run);
}

export type GitWorktreeAction = 'list' | 'add' | 'remove' | 'prune';

export function gitWorktree(
  cwd: string,
  action: GitWorktreeAction,
  options: { path?: string; ref?: string } = {},
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  const args = ['worktree', action];
  if (action === 'add' || action === 'remove') {
    if (!options.path?.trim()) {
      throw new Error(`[VCS_GIT_INVALID] worktree ${action} requires params.path`);
    }
    if (options.path.trim().startsWith('-')) {
      throw new Error('[VCS_GIT_INVALID] worktree path must not start with -');
    }
    args.push(options.path.trim());
    if (action === 'add' && options.ref?.trim()) {
      assertNotFlagLike(options.ref, 'ref');
      args.push(options.ref.trim());
    }
  }
  return gitRun(args, cwd, run);
}

export function gitCheckRefFormat(
  cwd: string,
  branchName: string,
  run: VcsCommandRunner = safeExecResult
): VcsCommandResult {
  return gitRun(['check-ref-format', '--branch', branchName], cwd, run);
}
