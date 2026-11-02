/** Explicit task source edits: an owner-authored path grant plus content-bound approval. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { createScopedRuntimeApprovalHandler } from '../agent/agent-task-approval.js';
import { withExecutionContext } from '../authority.js';
import {
  safeExistsSync,
  safeReadFileSnapshot,
  safeWriteFile,
  assertSafeRepositoryPath,
} from '../secure-io.js';
import { withLock } from '../foundation/lock-utils.js';
import { withCoordinationMutation } from './work-coordination-ledger.js';
import { pathResolver } from '../path-resolver.js';
import { writeScopedArtifact } from './artifact-store.js';
import { listWorkspaces, workspaceOwnerScope, type WorkspaceRecord } from './workspace-ledger.js';
import type { TaskToolBinding, TaskToolHandler } from './task-tool-runtime.js';
import { currentScopeEnvelope } from '../scope-envelope.js';
import { classifyStorageFloorPath } from '../storage-layout.js';
import { runtimeStatePath } from '../foundation/runtime-state-roots.js';
import {
  TASK_SOURCE_WORKSPACE_ROLE,
  taskSourceWorkspaceIoActive,
  withTaskSourceWorkspaceIo,
} from './task-source-workspace-io.js';
import {
  validateTaskSourcePaths,
  TASK_SOURCE_ROOTS as SOURCE_ROOTS,
} from '../foundation/task-tool-grant-validation.js';
export { validateTaskSourcePaths } from '../foundation/task-tool-grant-validation.js';

export interface TaskSourceEditOptions {
  rootDir?: string;
  assertCurrent(): void;
  approve?: (method: string, params: Record<string, unknown>) => Promise<boolean>;
  read?: (file: string) => string | undefined;
  write?: (file: string, content: string) => void;
  artifact?: typeof writeScopedArtifact;
  requiresApproval?: boolean;
  workspaces?: () => WorkspaceRecord[];
  ownerScope?: typeof workspaceOwnerScope;
  lock?: <T>(name: string, run: () => Promise<T>) => Promise<T>;
}
export function assertTaskSourcePathGrant(
  binding: TaskToolBinding,
  relative: string,
  options: Pick<TaskSourceEditOptions, 'rootDir' | 'workspaces' | 'ownerScope'> = {}
): void {
  const root = options.rootDir ?? pathResolver.rootDir();
  if (SOURCE_ROOTS.some((prefix) => relative.startsWith(prefix))) {
    if (binding.scope.tier !== 'public')
      throw new Error(
        '[TASK_SOURCE_DECLASSIFICATION_REQUIRED] Private tasks cannot write public source without a declassification broker'
      );
    return;
  }
  const absolute = path.resolve(root, relative);
  const workspace = (options.workspaces ?? listWorkspaces)().find(
    (record) =>
      record.live &&
      record.owner.mission_id === binding.missionId &&
      record.owner.task_id === binding.taskId &&
      absolute.startsWith(path.resolve(record.path) + path.sep)
  );
  const owner = workspace && (options.ownerScope ?? workspaceOwnerScope)(workspace.owner);
  const envelope = currentScopeEnvelope();
  if (
    !workspace ||
    !owner ||
    owner.tier !== binding.scope.tier ||
    owner.tenant !== (binding.scope.tenant_slug ?? 'shared') ||
    (owner.organization_id ?? '') !== (binding.scope.organization_id ?? '') ||
    (owner.project_id ?? '') !== (binding.scope.project_id ?? '') ||
    (envelope &&
      (envelope.policy.write_tier !== binding.scope.tier ||
        envelope.identity.tier !== binding.scope.tier ||
        (envelope.identity.tenant_slug ?? '') !== (binding.scope.tenant_slug ?? '') ||
        (envelope.identity.organization_id ?? '') !== (binding.scope.organization_id ?? '') ||
        (envelope.identity.project_id ?? '') !== (binding.scope.project_id ?? '')))
  )
    throw new Error(
      '[TASK_SOURCE_GRANT_INVALID] Source workspace is not live and owned by this exact task scope'
    );
  if (binding.scope.tier !== 'public') {
    const expected = `${runtimeStatePath('task.workspacesRoot').physicalPath}/${binding.scope.tier}/${binding.scope.tenant_slug ?? 'shared'}/`;
    const floor = classifyStorageFloorPath(relative)?.partition;
    if (
      !relative.startsWith(expected) &&
      !(
        floor?.kind === 'tier' &&
        floor.tier === binding.scope.tier &&
        (floor.tenant ?? 'shared') === (binding.scope.tenant_slug ?? 'shared')
      )
    )
      throw new Error(
        '[TASK_SOURCE_SCOPE_DENIED] Private source needs a physical same-tier workspace'
      );
  }
}

/** Reuses the exact edit grant for reading private source and output read-back. */
export function readTaskSourceFile(
  binding: TaskToolBinding,
  relative: string,
  options: Pick<TaskSourceEditOptions, 'rootDir' | 'workspaces' | 'ownerScope' | 'assertCurrent'>
): string | undefined {
  options.assertCurrent();
  assertTaskSourcePathGrant(binding, relative, options);
  const root = options.rootDir ?? pathResolver.rootDir();
  const file = assertSafeRepositoryPath(path.join(root, relative), { allowMissingLeaf: true });
  const read = () =>
    safeExistsSync(file) ? safeReadFileSnapshot(file, 1_048_576).toString('utf8') : undefined;
  if (binding.scope.tier === 'public') return read();
  return withTaskSourceWorkspaceIo(
    binding,
    root,
    file,
    false,
    () => {
      options.assertCurrent();
      assertTaskSourcePathGrant(binding, relative, options);
    },
    () =>
      withExecutionContext(
        TASK_SOURCE_WORKSPACE_ROLE,
        read,
        undefined,
        binding.scope.tenant_slug,
        binding.scope.organization_id
      )
  );
}
export function createTaskSourceEditTool(
  binding: TaskToolBinding,
  paths: readonly string[],
  options: TaskSourceEditOptions
): TaskToolHandler {
  const root = options.rootDir ?? pathResolver.rootDir();
  const allowed = validateTaskSourcePaths(paths);
  const assertPathGrant = (relative: string) =>
    assertTaskSourcePathGrant(binding, relative, options);
  for (const relative of allowed) assertPathGrant(relative);
  const artifact = options.artifact ?? writeScopedArtifact;
  const authorize = (method: string, params: Record<string, unknown>) =>
    method === 'task/sourceEdit' &&
    typeof params.path === 'string' &&
    allowed.includes(params.path) &&
    typeof params.content === 'string' &&
    Buffer.byteLength(params.content) <= 1_048_576;
  const approve =
    options.approve ??
    createScopedRuntimeApprovalHandler({
      agentId: binding.actorId,
      provider: 'task-tools',
      cwd: root,
      missionId: binding.missionId,
      scope: binding.scope,
      assertCurrent: options.assertCurrent,
      authorize,
      recordRequest(request) {
        const output = artifact({
          scope: { mission: binding.missionId, task: binding.taskId },
          artifact_class: 'evidence',
          name: `source-edit-${request.digest}.json`,
          content: request,
          format: 'json',
          tier: binding.scope.tier,
          publish: {
            kind: 'approval',
            preview_text: 'Review exact proposed source edit, preimage and task scope.',
          },
        });
        if (!output.artifact_id)
          throw new Error(
            '[TASK_SOURCE_APPROVAL_EVIDENCE] Source edit approval requires published evidence'
          );
        return `artifact:${output.artifact_id}`;
      },
    });
  const read =
    options.read ??
    ((file: string) =>
      readTaskSourceFile(binding, path.relative(root, file).split(path.sep).join('/'), options));
  const write =
    options.write ??
    ((file: string, content: string) => {
      const action = () =>
        withExecutionContext(
          binding.scope.tier === 'public' ? 'ecosystem_architect' : TASK_SOURCE_WORKSPACE_ROLE,
          () => {
            if (binding.scope.tier === 'public') options.assertCurrent();
            else if (!taskSourceWorkspaceIoActive())
              throw new Error('[TASK_SOURCE_SCOPE_DENIED] Private source IO window expired');
            const relative = path.relative(root, file).split(path.sep).join('/');
            if (!allowed.includes(relative))
              throw new Error('[TASK_SOURCE_DENIED] Exact write grant changed');
            if (binding.scope.tier === 'public') assertPathGrant(relative);
            safeWriteFile(file, content, { mkdir: true });
          },
          binding.scope.tier === 'public' ? 'ecosystem_architect' : undefined,
          binding.scope.tenant_slug,
          binding.scope.organization_id
        );
      if (binding.scope.tier === 'public') return withCoordinationMutation(action);
      return withTaskSourceWorkspaceIo(
        binding,
        root,
        file,
        true,
        () => {
          options.assertCurrent();
          assertPathGrant(path.relative(root, file).split(path.sep).join('/'));
        },
        action
      );
    });
  return {
    definition: {
      name: 'kyberion_task_write_source',
      description: `Write an owner-declared source file within the task grant. Exact content approval is required when the task contract requests it. Allowed exact paths: ${allowed.join(', ')}. Approval cannot expand this list.`,
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string', enum: allowed }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    op: 'file:write',
    async execute(input) {
      options.assertCurrent();
      if (!authorize('task/sourceEdit', input))
        throw new Error('[TASK_SOURCE_DENIED] Source path/content is outside the task grant');
      const relative = input.path as string;
      const file = assertSafeRepositoryPath(path.join(root, relative), { allowMissingLeaf: true });
      const lock = 'task-source-edit:' + createHash('sha256').update(file).digest('hex');
      return (options.lock ?? withLock)(lock, async () => {
        options.assertCurrent();
        const previous = read(file);
        const params = {
          path: relative,
          content: input.content,
          before_content: previous ?? null,
          before_sha256:
            previous === undefined ? null : createHash('sha256').update(previous).digest('hex'),
          work_item_id: binding.workItemId,
          task_id: binding.taskId,
        };
        assertPathGrant(relative);
        if (options.requiresApproval !== false && !(await approve('task/sourceEdit', params)))
          throw new Error('[TASK_SOURCE_DENIED] Source edit approval denied');
        options.assertCurrent();
        if (read(file) !== previous)
          throw new Error(
            '[TASK_SOURCE_CONFLICT] Source changed during approval; request fresh review'
          );
        write(assertSafeRepositoryPath(file, { allowMissingLeaf: true }), input.content as string);
        return {
          status: 'written',
          path: relative,
          sha256: createHash('sha256')
            .update(input.content as string)
            .digest('hex'),
        };
      });
    },
  };
}
