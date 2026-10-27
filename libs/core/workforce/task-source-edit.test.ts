import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  createTaskSourceEditTool,
  validateTaskSourcePaths,
  type TaskSourceEditOptions,
} from './task-source-edit.js';
import type { TaskToolBinding } from './task-tool-runtime.js';
import type { WorkspaceRecord } from './workspace-ledger.js';

const binding: TaskToolBinding = {
  scope: { scope_kind: 'task', tier: 'public', mission_id: 'MSN-SOURCE', task_id: 'edit' },
  actorId: 'source-worker',
  workItemId: 'source-work',
  taskId: 'edit',
  missionId: 'MSN-SOURCE',
  leaseId: 'source-lease',
  capabilityProfile: 'implementer',
  readRoots: [],
  writeRoots: [],
};
const target = 'libs/core/workforce/synthetic-task-source.ts';
function ports() {
  let content = 'before';
  const options: TaskSourceEditOptions = {
    assertCurrent: vi.fn(),
    approve: vi.fn(async () => true),
    read: () => content,
    write: vi.fn((_file, next) => {
      content = next;
    }),
    lock: async (_name, run) => run(),
  };
  return {
    options,
    setContent: (value: string) => {
      content = value;
    },
  };
}
describe('owner-declared task source edit tool', () => {
  it('writes only the exact declared file after approving full content and preimage', async () => {
    const h = ports();
    const tool = createTaskSourceEditTool(binding, [target], h.options);
    expect(await tool.execute({ path: target, content: 'after' }, binding)).toMatchObject({
      status: 'written',
      path: target,
    });
    expect(h.options.approve).toHaveBeenCalledWith(
      'task/sourceEdit',
      expect.objectContaining({
        path: target,
        content: 'after',
        before_content: 'before',
        work_item_id: binding.workItemId,
      })
    );
    expect(h.options.write).toHaveBeenCalledWith(path.join(process.cwd(), target), 'after');
    await expect(
      tool.execute({ path: 'libs/core/secure-io.ts', content: 'ungranted' }, binding)
    ).rejects.toThrow('TASK_SOURCE_DENIED');
  });
  it('does not add approval friction to an already granted reversible owner contract', async () => {
    const h = ports();
    const tool = createTaskSourceEditTool(binding, [target], {
      ...h.options,
      requiresApproval: false,
    });
    await tool.execute({ path: target, content: 'approved scope change' }, binding);
    expect(h.options.approve).not.toHaveBeenCalled();
    expect(h.options.write).toHaveBeenCalledTimes(1);
  });
  it('rechecks the preimage after waiting for approval', async () => {
    const h = ports();
    h.options.approve = vi.fn(async () => {
      h.setContent('someone else changed it');
      return true;
    });
    const tool = createTaskSourceEditTool(binding, [target], h.options);
    await expect(tool.execute({ path: target, content: 'stale write' }, binding)).rejects.toThrow(
      'TASK_SOURCE_CONFLICT'
    );
    expect(h.options.write).not.toHaveBeenCalled();
  });
  it.each([
    '.git/config',
    'knowledge/personal/private.txt',
    'knowledge/confidential/other/private.txt',
    'libs/../secrets.txt',
    'libs/.git/config',
  ])('refuses ungrantable path %s', (target) => {
    expect(() => validateTaskSourcePaths([target])).toThrow('TASK_SOURCE_GRANT_INVALID');
  });
  it('does not permit private-to-public source declassification through an edit grant', () => {
    expect(() =>
      createTaskSourceEditTool(
        { ...binding, scope: { ...binding.scope, tier: 'confidential', tenant_slug: 'tenant-a' } },
        [target],
        ports().options
      )
    ).toThrow('TASK_SOURCE_DECLASSIFICATION_REQUIRED');
  });
  it('permits a same-tier registered workspace only for its exact owning task', async () => {
    const workspacePath = 'active/shared/tmp/confidential/tenant-a/source-workspace';
    const scoped = {
      ...binding,
      scope: { ...binding.scope, tier: 'confidential' as const, tenant_slug: 'tenant-a' },
    };
    const workspace = {
      id: 'workspace-source',
      path: path.join(process.cwd(), workspacePath),
      owner: { mission_id: binding.missionId, task_id: binding.taskId },
      live: true,
    } as WorkspaceRecord;
    const h = ports();
    const options: TaskSourceEditOptions = {
      ...h.options,
      requiresApproval: false,
      workspaces: () => [workspace],
      ownerScope: () => ({
        owner: { kind: 'mission', id: binding.missionId },
        tier: 'confidential',
        tenant: 'tenant-a',
        dir: workspace.path,
      }),
    };
    const source = `${workspacePath}/module.ts`;
    const tool = createTaskSourceEditTool(scoped, [source], options);
    await tool.execute({ path: source, content: 'tenant-scoped code' }, scoped);
    expect(h.options.write).toHaveBeenCalledTimes(1);
    workspace.owner.task_id = 'other-task';
    await expect(tool.execute({ path: source, content: 'wrong task' }, scoped)).rejects.toThrow(
      'TASK_SOURCE_GRANT_INVALID'
    );
  });
});
