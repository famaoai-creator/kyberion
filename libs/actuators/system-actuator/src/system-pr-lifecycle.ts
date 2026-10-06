/** Typed PR lifecycle; execution retains the actuator's governed unsafe-exec gate. */
import { safeExecResult, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { logger } from '@agent/core/core';
import {
  ghPrChecks,
  ghPrMerge,
  gitAdd,
  gitCheckRefFormat,
  gitCheckout,
  gitCommit,
  gitDiffChangedPaths,
  gitPull,
  gitPush,
  type VcsCommandResult,
} from '@agent/core/vcs';
import { main as publishPullRequest } from '../../../../scripts/publish_pull_request.js';

export interface StandardPrLifecycleParams {
  branch_name: string;
  commit_message: string;
  pr_title: string;
  pr_body: string;
  auto_merge?: boolean;
}
export interface PrLifecycleDependencies {
  exec: typeof safeExecResult;
  write: typeof safeWriteFile;
  publish: typeof publishPullRequest;
}

function assertOk(result: VcsCommandResult, label: string): void {
  if (result.error || result.status !== 0) {
    throw new Error(
      `[PR_LIFECYCLE_COMMAND_FAILED] ${label}: ${result.stderr || result.error?.message || `exit ${result.status}`}`
    );
  }
}

export async function runStandardPrLifecycle(
  params: StandardPrLifecycleParams,
  deps: PrLifecycleDependencies = {
    exec: safeExecResult,
    write: safeWriteFile,
    publish: publishPullRequest,
  }
): Promise<{ stdout: string; status: number }> {
  if (!params.branch_name || params.branch_name === 'main' || params.branch_name.startsWith('-')) {
    throw new Error('[PR_LIFECYCLE_INVALID_BRANCH] A dedicated branch name is required.');
  }
  const cwd = pathResolver.rootDir();
  const exec = deps.exec;
  assertOk(gitCheckRefFormat(cwd, params.branch_name, exec), 'git check-ref-format');
  assertOk(gitCheckout(cwd, params.branch_name, { createBranch: true }, exec), 'git checkout -b');
  const unstaged = gitDiffChangedPaths(cwd, { diffFilter: 'ACMRTUXB' }, exec);
  assertOk(unstaged.result, 'git diff');
  for (const addResult of gitAdd(cwd, unstaged.paths, exec)) {
    assertOk(addResult, 'git add');
  }
  const staged = gitDiffChangedPaths(cwd, { cached: true }, exec);
  assertOk(staged.result, 'git diff --cached');
  if (staged.paths.length > 0) {
    assertOk(gitCommit(cwd, params.commit_message, exec), 'git commit -m');
  }
  assertOk(
    gitPush(cwd, { remote: 'origin', ref: params.branch_name, setUpstream: true }, exec),
    'git push'
  );
  const bodyFile = pathResolver.rootResolve(
    'active/shared/tmp/standard-pr-lifecycle/' + encodeURIComponent(params.branch_name) + '.md'
  );
  deps.write(bodyFile, params.pr_body);
  let url = '';
  await deps.publish(
    ['--title', params.pr_title, '--body-file', bodyFile, '--base', 'main', '--no-draft'],
    (value) => {
      const line = String(value).trim();
      if (/^https:\/\/[^\s]+\/pull\/\d+$/u.test(line)) url = line;
      else logger.info(line);
    }
  );
  if (!url)
    throw new Error('[PR_LIFECYCLE_URL_MISSING] Governed publisher did not return a PR URL.');
  if (params.auto_merge === true) {
    let checks;
    try {
      checks = ghPrChecks({ ref: url, cwd }, exec);
    } catch (error) {
      throw new Error(
        `[PR_LIFECYCLE_COMMAND_FAILED] gh pr checks: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // Fail closed: merge only on an explicit success. 'none' (no checks
    // reported) refuses too — matching the old code, which threw on any
    // non-zero `gh pr checks` exit rather than merge with zero CI evidence.
    if (checks.state !== 'success') {
      throw new Error(
        `[PR_LIFECYCLE_CHECKS_FAILED] auto-merge refused; checks state=${checks.state}` +
          (checks.failing.length ? `; failing: ${checks.failing.join(', ')}` : '') +
          (checks.pending.length ? `; pending: ${checks.pending.join(', ')}` : '')
      );
    }
    assertOk(
      ghPrMerge({ ref: url, method: 'merge', deleteBranch: true, cwd }, exec),
      'gh pr merge'
    );
    assertOk(gitCheckout(cwd, 'main', {}, exec), 'git checkout main');
    assertOk(gitPull(cwd, { remote: 'origin', ref: 'main' }, exec), 'git pull --ff-only');
  }
  return { stdout: url, status: 0 };
}
