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
export function createTaskSourceEditTool(
  binding: TaskToolBinding,
  paths: readonly string[],
  options: TaskSourceEditOptions
): TaskToolHandler {
  const root = options.rootDir ?? pathResolver.rootDir();
  const allowed = validateTaskSourcePaths(paths);
  const assertPathGrant = (relative: string): void => {
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
    if (
      !workspace ||
      !owner ||
      owner.tier !== binding.scope.tier ||
      owner.tenant !== (binding.scope.tenant_slug ?? 'shared') ||
      (owner.organization_id ?? '') !== (binding.scope.organization_id ?? '') ||
      (owner.project_id ?? '') !== (binding.scope.project_id ?? '')
    )
      throw new Error(
        '[TASK_SOURCE_GRANT_INVALID] Source workspace is not live and owned by this exact task scope'
      );
  };
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
      safeExistsSync(file) ? safeReadFileSnapshot(file, 1_048_576).toString('utf8') : undefined);
  const write =
    options.write ??
    ((file: string, content: string) =>
      withCoordinationMutation(() =>
        withExecutionContext(
          'ecosystem_architect',
          () => {
            options.assertCurrent();
            const relative = path.relative(root, file).split(path.sep).join('/');
            if (!allowed.includes(relative))
              throw new Error('[TASK_SOURCE_DENIED] Exact write grant changed');
            assertPathGrant(relative);
            safeWriteFile(file, content, { mkdir: true });
          },
          'ecosystem_architect'
        )
      ));
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
