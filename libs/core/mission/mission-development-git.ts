/** Closed owner-only local Git adapter. Network publication stays in the VCS host. */
import * as path from 'node:path';
import { devNull } from 'node:os';
import { safeExecResult } from '../secure-io.js';
import { hardenedLocalWorkspaceGitOptions } from '../shell/git-probe-hardening.js';
import { assertMissionOwnerPath } from './mission-git.js';
import type { VcsCommandRunner } from '../vcs/git.js';
import { gitFetch } from '../vcs/git.js';
import { assertVcsCwdScope } from '../vcs/cwd-scope.js';
import { pathResolver } from '../path-resolver.js';

export function createDevelopmentWorkspaceGitRunner(
  cwd: string,
  sourcePaths: readonly string[],
  taskId: string
): VcsCommandRunner {
  return (command, args, options = {}) => {
    assertMissionOwnerPath('read or mutate the exact development candidate');
    assertVcsCwdScope(cwd);
    if (command !== 'git' || path.resolve(options.cwd ?? cwd) !== path.resolve(cwd))
      throw new Error('Development Git adapter scope mismatch');
    const exact = (...expected: string[]) =>
      args.length === expected.length && args.every((value, index) => value === expected[index]);
    const read =
      exact('branch', '--show-current') ||
      exact('status', '--porcelain') ||
      exact('rev-parse', 'HEAD') ||
      exact('show-ref', '--verify', '--quiet', 'refs/heads/agent/kyberion-development') ||
      exact('diff', '--name-only', '-z') ||
      exact('diff', '--name-only', '-z', '--cached') ||
      exact('ls-files', '--others', '--exclude-standard', '-z');
    const mutation =
      exact('checkout', '-b', 'agent/kyberion-development') ||
      (args.length === 3 &&
        args[0] === 'add' &&
        args[1] === '--' &&
        sourcePaths.includes(args[2])) ||
      exact('commit', '-m', `feat: implement ${taskId}`);
    if (!read && !mutation)
      throw new Error('Development Git adapter refuses an undeclared local command');
    if (mutation) assertMissionOwnerPath('mutate the exact development candidate');
    return safeExecResult(
      'git',
      ['-c', 'commit.gpgsign=false', ...args],
      hardenedLocalWorkspaceGitOptions({
        ...options,
        cwd,
        env: {
          ...options.env,
          GIT_AUTHOR_NAME: 'Kyberion Development',
          GIT_COMMITTER_NAME: 'Kyberion Development',
          GIT_AUTHOR_EMAIL: 'kyberion-development@localhost.invalid',
          GIT_COMMITTER_EMAIL: 'kyberion-development@localhost.invalid',
        },
      })
    );
  };
}

export function cloneIsolatedDevelopmentRepository(
  source: string,
  target: string,
  repositoryUrl: string,
  assertCurrent: () => void
): void {
  if (path.resolve(source) !== path.resolve(pathResolver.rootDir()))
    throw new Error('Private clone source must be the trusted governance checkout');
  assertVcsCwdScope(source);
  const execute = (args: string[], cwd: string) => {
    assertCurrent();
    assertMissionOwnerPath('create the isolated private development repository');
    assertVcsCwdScope(cwd);
    const result = safeExecResult(
      'git',
      args,
      hardenedLocalWorkspaceGitOptions({ cwd, timeoutMs: 120_000, maxOutputMB: 2 })
    );
    assertCurrent();
    if (result.status !== 0 || result.error)
      throw new Error('Private repository setup failed; reconcile its registered workspace');
  };
  execute(
    [
      'clone',
      '--no-checkout',
      '--no-local',
      '--no-hardlinks',
      '--dissociate',
      '--single-branch',
      '--branch',
      'main',
      '--template=',
      '--',
      source,
      target,
    ],
    source
  );
  execute(['remote', 'set-url', 'origin', repositoryUrl], target);
  // Only this just-created, unclaimed clone may initialize its baseline. Local
  // main in the governance checkout can lag the reviewed destination.
  const fetched = gitFetch(
    target,
    { remote: repositoryUrl, ref: 'refs/heads/main' },
    (command, args, options) => {
      assertCurrent();
      assertMissionOwnerPath('read the reviewed development baseline');
      assertVcsCwdScope(target);
      if (
        command !== 'git' ||
        path.resolve(options?.cwd ?? '') !== path.resolve(target) ||
        args.length !== 3 ||
        args[0] !== 'fetch' ||
        args[1] !== repositoryUrl ||
        args[2] !== 'refs/heads/main'
      )
        throw new Error('Development baseline fetch differs from the reviewed repository');
      return safeExecResult(
        'git',
        [
          '-c',
          `core.hooksPath=${devNull}`,
          '-c',
          'core.fsmonitor=false',
          '-c',
          'gc.auto=0',
          '-c',
          'maintenance.auto=false',
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.https.allow=always',
          ...args,
        ],
        {
          cwd: target,
          timeoutMs: 120_000,
          maxOutputMB: 2,
          // Preserve the canonical Git credential configuration. Local-only
          // probe options intentionally disable HTTPS and credential helpers.
          env: {
            GIT_TERMINAL_PROMPT: '0',
            GIT_DIR: undefined,
            GIT_COMMON_DIR: undefined,
            GIT_WORK_TREE: undefined,
            GIT_INDEX_FILE: undefined,
            GIT_OBJECT_DIRECTORY: undefined,
            GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
          },
        }
      );
    }
  );
  assertCurrent();
  if (fetched.status !== 0 || fetched.error)
    throw new Error(
      'Reviewed remote main could not be fetched; reconcile the registered workspace'
    );
  assertMissionOwnerPath('read the fetched development baseline');
  assertVcsCwdScope(target);
  const baseline = safeExecResult(
    'git',
    ['rev-parse', '--verify', 'FETCH_HEAD'],
    hardenedLocalWorkspaceGitOptions({ cwd: target, timeoutMs: 10_000, maxOutputMB: 1 })
  );
  if (
    baseline.status !== 0 ||
    baseline.error ||
    !/^[a-f0-9]{40,64}$/iu.test(baseline.stdout.trim())
  )
    throw new Error('Reviewed remote main has no immutable baseline');
  execute(['checkout', '-B', 'main', baseline.stdout.trim()], target);
}
