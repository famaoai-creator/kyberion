/** Owner-only candidate branch and exact-file commit stage for the existing executor root. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from '../secure-io.js';
import {
  TASK_SOURCE_ROOTS,
  validateTaskSourcePaths,
} from '../foundation/task-tool-grant-validation.js';
import { assertMissionOwnerPath } from './mission-git.js';
import {
  gitAdd,
  gitCheckout,
  gitCommit,
  gitDiffChangedPaths,
  gitRun,
  type VcsCommandRunner,
} from '../vcs/git.js';
import { listWorkspaces, registerWorkspace } from '../workforce/workspace-ledger.js';
import { checkWorkspaceBudget } from '../workforce/workspace-budget.js';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import { storagePartitionSegments } from '../storage-layout.js';
import type { MissionState } from './mission-types.js';
import {
  createDevelopmentWorkspaceGitRunner,
  cloneIsolatedDevelopmentRepository,
} from './mission-development-git.js';
import { normalizeRepositoryTarget } from '../governance/external-operation-target.js';

/** Proposed source is never the live governance checkout, even for public tasks. */
export function ensureMissionDevelopmentSourceWorkspace(
  state: Pick<MissionState, 'mission_id' | 'tier' | 'tenant_slug'>,
  taskId: string,
  sourcePaths: string[],
  assertCurrent: () => void,
  options: { create?: boolean; repositoryUrl?: string } = {}
): { cwd: string; sourcePaths: string[]; created: boolean } | undefined {
  const namespace = storagePartitionSegments({
    kind: 'tier',
    tier: state.tier,
    ...(state.tenant_slug ? { tenant: state.tenant_slug } : {}),
  });
  const parent = pathResolver.rootResolve(
    path.posix.join(
      runtimeStatePath('task.workspacesRoot').physicalPath,
      ...namespace,
      'development'
    )
  );
  const name = `development-${createHash('sha256')
    .update(JSON.stringify([state.mission_id, taskId]))
    .digest('hex')
    .slice(0, 16)}`;
  const cwd = path.join(parent, name);
  const record = listWorkspaces().find((row) => row.path === cwd);
  let created = false;
  if (record) {
    if (
      !record.live ||
      record.kind !== 'scratch-dir' ||
      record.owner.mission_id !== state.mission_id ||
      record.owner.task_id !== taskId
    )
      throw new Error('Private development workspace ownership does not match the current task');
  } else {
    if (options.create === false)
      throw new Error('Terminal mission has no private development workspace evidence');
    if (
      !options.repositoryUrl ||
      normalizeRepositoryTarget(options.repositoryUrl) !== options.repositoryUrl
    )
      throw new Error('Private clone requires the exact reviewed repository URL');
    assertCurrent();
    assertMissionOwnerPath('allocate the isolated private development repository');
    const budget = checkWorkspaceBudget(cwd, 0, { allowedRoots: [parent] });
    if (!budget.allowed) throw new Error('Private development workspace budget denied');
    registerWorkspace(
      { path: cwd, kind: 'scratch-dir', owner: { mission_id: state.mission_id, task_id: taskId } },
      { allowedRoots: [parent] }
    );
    cloneIsolatedDevelopmentRepository(
      pathResolver.rootDir(),
      cwd,
      options.repositoryUrl,
      assertCurrent
    );
    assertCurrent();
    created = true;
  }
  const gitDir = assertSafeRepositoryPath(path.join(cwd, '.git'));
  const common = gitRun(['rev-parse', '--git-common-dir'], cwd);
  if (
    !safeLstat(gitDir).isDirectory() ||
    common.status !== 0 ||
    common.error ||
    path.resolve(cwd, common.stdout.trim()) !== gitDir ||
    safeExistsSync(path.join(gitDir, 'objects/info/alternates'))
  )
    throw new Error(
      'Private development repository shares Git objects or metadata outside its workspace'
    );
  const prefix = pathResolver.toRepoRelative(cwd).replace(/\\/gu, '/');
  return { cwd, sourcePaths: sourcePaths.map((source) => `${prefix}/${source}`), created };
}

export const MISSION_DEVELOPMENT_BRANCH = 'agent/kyberion-development';
/** Compatibility name for callers predating isolation of public source. */
export const ensureMissionDevelopmentPrivateWorkspace = ensureMissionDevelopmentSourceWorkspace;
export interface MissionDevelopmentWorkspaceInput {
  cwd: string;
  sourcePaths: string[];
  owned: boolean;
  commit: boolean;
  taskId: string;
  assertCurrent: () => void;
  reserve: () => void;
}
export function prepareMissionDevelopmentWorkspace(
  input: MissionDevelopmentWorkspaceInput,
  run?: VcsCommandRunner,
  runtimeRoot = pathResolver.rootDir()
): 'ready' | 'advanced' {
  const cwd = path.resolve(runtimeRoot, input.cwd);
  if (path.resolve(cwd) !== path.resolve(runtimeRoot))
    throw new Error('Development executor must run in its dedicated repository root');
  assertSafeRepositoryPath(path.join(cwd, 'package.json'), { allowMissingLeaf: true });
  const paths = validateTaskSourcePaths(input.sourcePaths);
  if (
    !paths.length ||
    paths.some((name) => !TASK_SOURCE_ROOTS.some((root) => name.startsWith(root)))
  )
    throw new Error('Development requires exact reviewed repository-relative code file paths');
  run ??= createDevelopmentWorkspaceGitRunner(cwd, paths, input.taskId);
  const read = (args: string[]) => {
    const result = gitRun(args, cwd, run);
    if (result.status !== 0 || result.error) throw new Error('Development workspace read failed');
    return result.stdout.trim();
  };
  const mutation = (action: () => { status: number | null; error?: Error }) => {
    input.assertCurrent();
    assertMissionOwnerPath('prepare or commit the development candidate');
    const result = action();
    if (result.status !== 0 || result.error)
      throw new Error('Development workspace mutation failed; inspect repository before retrying');
    input.assertCurrent();
  };
  const staged = gitDiffChangedPaths(cwd, { cached: true }, run);
  if (staged.result.status !== 0 || staged.paths.length)
    throw new Error('Preexisting staged changes require owner reconciliation');
  const currentBranch = read(['branch', '--show-current']);
  if (currentBranch !== MISSION_DEVELOPMENT_BRANCH) {
    if (currentBranch !== 'main' || read(['status', '--porcelain']))
      throw new Error(
        'Development requires a clean dedicated main checkout before creating its candidate'
      );
    const existing = gitRun(
      ['show-ref', '--verify', '--quiet', `refs/heads/${MISSION_DEVELOPMENT_BRANCH}`],
      cwd,
      run
    );
    if (existing.status !== 1 || existing.error)
      throw new Error('Existing development candidate must be reconciled by its owner');
    input.reserve();
    mutation(() => gitCheckout(cwd, MISSION_DEVELOPMENT_BRANCH, { createBranch: true }, run));
    return 'advanced';
  }
  if (!input.owned) throw new Error('Existing development candidate is not owned by this WorkItem');
  if (!input.commit) return 'ready';
  const modified = gitDiffChangedPaths(cwd, {}, run);
  const untracked = gitRun(['ls-files', '--others', '--exclude-standard', '-z'], cwd, run);
  if (modified.result.status !== 0 || untracked.status !== 0 || untracked.error)
    throw new Error('Cannot enumerate development changes');
  const changed = [
    ...new Set([...modified.paths, ...untracked.stdout.split('\0').filter(Boolean)]),
  ];
  if (changed.some((name) => !paths.includes(name)))
    throw new Error('Development changes exceed the reviewed exact source file scope');
  if (!changed.length) return 'ready';
  input.assertCurrent();
  assertMissionOwnerPath('stage development source files');
  for (const result of gitAdd(cwd, changed, run)) {
    if (result.status !== 0 || result.error)
      throw new Error('Exact-file development staging failed; reconcile the index');
  }
  const final = gitDiffChangedPaths(cwd, { cached: true }, run);
  if (final.result.status !== 0 || final.paths.some((name) => !paths.includes(name)))
    throw new Error('Development index changed outside the reviewed source scope');
  mutation(() => gitCommit(cwd, `feat: implement ${input.taskId}`, run));
  return 'advanced';
}
