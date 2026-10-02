/** Typed PR lifecycle; execution retains the actuator's governed unsafe-exec gate. */
import { safeExecResult, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { logger } from '@agent/core/core';
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
  const run = (command: string, args: string[]): string => {
    const result = deps.exec(command, args, { cwd });
    if (result.status !== 0 || result.error) {
      throw new Error(
        '[PR_LIFECYCLE_COMMAND_FAILED] ' +
          command +
          ' ' +
          args[0] +
          ': ' +
          (result.stderr || result.error?.message || result.status)
      );
    }
    return result.stdout;
  };
  run('git', ['check-ref-format', '--branch', params.branch_name]);
  run('git', ['checkout', '-b', params.branch_name]);
  const paths = run('git', ['diff', '--name-only', '-z', '--diff-filter=ACMRTUXB'])
    .split('\0')
    .filter(Boolean);
  for (const file of paths) run('git', ['add', '--', file]);
  if (run('git', ['diff', '--cached', '--name-only', '-z'])) {
    run('git', ['commit', '-m', params.commit_message]);
  }
  run('git', ['push', '-u', 'origin', params.branch_name]);
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
    run('gh', ['pr', 'checks', url]);
    run('gh', ['pr', 'merge', url, '--merge', '--delete-branch']);
    run('git', ['checkout', 'main']);
    run('git', ['pull', '--ff-only', 'origin', 'main']);
  }
  return { stdout: url, status: 0 };
}
