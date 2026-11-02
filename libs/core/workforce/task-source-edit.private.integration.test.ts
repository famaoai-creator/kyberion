import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import * as paths from '../path-resolver.js';
import { safeMkdir, safeWriteFile, safeReadFile, safeRmSync } from '../secure-io.js';
import { withExecutionContext, resetRoleAssumptionPolicyCache } from '../authority.js';
import { detectTier, validateReadPermission } from '../tier-guard.js';
import { createTaskSourceEditTool, readTaskSourceFile } from './task-source-edit.js';
import type { TaskToolBinding } from './task-tool-runtime.js';
import { createRuntimeForTask } from './task-tool-runtime.js';
import type { WorkItem, WorkLease } from './work-coordination-types.js';
import type { WorkspaceRecord } from './workspace-ledger.js';

const sourceRoot = pathResolver.rootDir();
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetRoleAssumptionPolicyCache();
  for (const root of roots.splice(0)) safeRmSync(root, { recursive: true, force: true });
});

describe('actual private task source IO under canonical policy', () => {
  it.each(['personal', 'confidential'] as const)(
    'writes and reads an exact live %s workspace while public readers remain denied',
    async (tier) => {
      const root = path.join(sourceRoot, 'active/shared/tmp/vitest-private-source', randomUUID());
      roots.push(root);
      safeMkdir(path.join(root, 'knowledge/personal/tenants'), { recursive: true });
      safeWriteFile(
        path.join(root, 'knowledge/personal/tenants/acme.json'),
        JSON.stringify({
          tenant_slug: 'acme',
          status: 'active',
          assigned_role: 'owner',
          display_name: 'Fixture',
        })
      );
      vi.spyOn(pathResolver, 'rootDir').mockReturnValue(root);
      vi.spyOn(paths, 'rootDir').mockReturnValue(root);
      vi.spyOn(pathResolver, 'rootResolve').mockImplementation((value) =>
        path.resolve(root, value)
      );
      vi.stubEnv('SYSTEM_ROLE', '');
      vi.stubEnv('MISSION_ROLE', 'worker');
      vi.stubEnv('KYBERION_PERSONA', 'worker');
      vi.stubEnv('KYBERION_SUDO', 'false');
      vi.stubEnv('KYBERION_TENANT', tier === 'confidential' ? 'acme' : '');
      vi.stubEnv('KYBERION_TIER', tier);
      resetRoleAssumptionPolicyCache();
      const relative = `active/shared/runtime/workspaces/${tier}/${tier === 'confidential' ? 'acme' : 'shared'}/development/source/libs/core/example.ts`;
      const workspacePath = path.dirname(path.dirname(path.dirname(path.join(root, relative))));
      const binding: TaskToolBinding = {
        scope: {
          scope_kind: 'task',
          tier,
          mission_id: 'MSN-PRIVATE-SOURCE',
          task_id: 'implement',
          ...(tier === 'confidential'
            ? { tenant_slug: 'acme', organization_id: 'org-a', project_id: 'project-a' }
            : {}),
        },
        actorId: 'worker-a',
        workItemId: 'work-a',
        taskId: 'implement',
        missionId: 'MSN-PRIVATE-SOURCE',
        leaseId: 'lease-a',
        capabilityProfile: 'implementer',
        readRoots: [],
        writeRoots: [],
      };
      const workspace = {
        id: 'workspace-a',
        live: true,
        kind: 'git-worktree',
        path: workspacePath,
        owner: { mission_id: binding.missionId, task_id: binding.taskId },
      } as WorkspaceRecord;
      let current = true;
      const owner = {
        owner: { kind: 'mission' as const, id: binding.missionId },
        tier,
        tenant: tier === 'confidential' ? 'acme' : 'shared',
        dir: workspacePath,
        ...(tier === 'confidential' ? { organization_id: 'org-a', project_id: 'project-a' } : {}),
      };
      const options = {
        rootDir: root,
        lock: async <T>(_name: string, run: () => Promise<T>) => run(),
        requiresApproval: false,
        assertCurrent: () => {
          if (!current) throw new Error('lease lost');
        },
        workspaces: () => [workspace],
        ownerScope: () => owner,
      };
      const tool = createTaskSourceEditTool(binding, [relative], options);
      expect(detectTier(path.join(root, relative))).toBe(tier);
      await expect(
        tool.execute({ path: relative, content: 'private task implementation' }, binding)
      ).resolves.toMatchObject({ status: 'written' });
      expect(readTaskSourceFile(binding, relative, options)).toBe('private task implementation');
      const claimed = {
        item_id: binding.workItemId,
        status: 'in_progress',
        lease_id: binding.leaseId,
        claimed_by_peer_id: binding.actorId,
        context: binding.scope,
        metadata: { team_role: 'implementer' },
      } as unknown as WorkItem;
      const runtime = createRuntimeForTask(
        { work_item_id: binding.workItemId, capability_profile: 'implementer' },
        binding.scope,
        {
          rootDir: root,
          getItem: () => claimed,
          leases: () => [
            {
              lease_id: binding.leaseId,
              item_id: binding.workItemId,
              holder_peer_id: binding.actorId,
              status: 'active',
              expires_at: '2099-01-01T00:00:00Z',
            } as WorkLease,
          ],
          missionPath: () => path.join(root, 'active/missions', tier, binding.missionId),
          mission: () =>
            ({
              mission_id: binding.missionId,
              status: 'active',
              tier,
              tenant_slug: binding.scope.tenant_slug,
              organization_id: binding.scope.organization_id,
              relationships: binding.scope.project_id
                ? { project: { project_id: binding.scope.project_id } }
                : {},
            }) as never,
          tasks: () => [
            {
              task_id: binding.taskId,
              status: 'planned',
              assigned_to: { role: 'implementer' },
              source_edit_paths: [relative],
              source_edit_requires_approval: false,
            },
          ],
          sourceEditOptions: options,
        }
      )!;
      await expect(
        runtime.execute({
          name: 'kyberion_task_write_source',
          arguments: { path: relative, content: 'claimed private implementation' },
        })
      ).resolves.toMatchObject({ status: 'written' });
      await expect(
        runtime.execute({ name: 'kyberion_task_read_file', arguments: { path: relative } })
      ).resolves.toMatchObject({ content: 'claimed private implementation' });
      claimed.claimed_by_peer_id = 'foreign-worker';
      await expect(
        runtime.execute({
          name: 'kyberion_task_write_source',
          arguments: { path: relative, content: 'foreign claim' },
        })
      ).rejects.toThrow('TASK_TOOL_LEASE_LOST');
      claimed.claimed_by_peer_id = binding.actorId;
      vi.stubEnv('KYBERION_TIER', 'public');
      vi.stubEnv('KYBERION_TENANT', '');
      expect(
        withExecutionContext(
          'worker',
          () => validateReadPermission(path.join(root, relative)).allowed,
          'worker'
        )
      ).toBe(false);
      expect(() =>
        withExecutionContext('worker', () => safeReadFile(path.join(root, relative)), 'worker')
      ).toThrow();
      vi.stubEnv('KYBERION_TIER', tier);
      vi.stubEnv('KYBERION_TENANT', tier === 'confidential' ? 'acme' : '');
      expect(() => withExecutionContext('task_source_workspace', () => undefined)).toThrow(
        'TASK_SOURCE_SCOPE_DENIED'
      );
      workspace.owner.task_id = 'other-task';
      await expect(
        tool.execute({ path: relative, content: 'wrong task' }, binding)
      ).rejects.toThrow('TASK_SOURCE_GRANT_INVALID');
      workspace.owner.task_id = binding.taskId;
      workspace.owner.mission_id = 'MSN-OTHER';
      expect(() => readTaskSourceFile(binding, relative, options)).toThrow(
        'TASK_SOURCE_GRANT_INVALID'
      );
      workspace.owner.mission_id = binding.missionId;
      workspace.live = false;
      expect(() => readTaskSourceFile(binding, relative, options)).toThrow(
        'TASK_SOURCE_GRANT_INVALID'
      );
      workspace.live = true;
      if (tier === 'confidential') {
        owner.project_id = 'project-b';
        expect(() => readTaskSourceFile(binding, relative, options)).toThrow(
          'TASK_SOURCE_GRANT_INVALID'
        );
        owner.project_id = 'project-a';
        owner.tenant = 'other';
        expect(() => readTaskSourceFile(binding, relative, options)).toThrow(
          'TASK_SOURCE_GRANT_INVALID'
        );
        owner.tenant = 'acme';
      }
      current = false;
      await expect(
        tool.execute({ path: relative, content: 'stale lease' }, binding)
      ).rejects.toThrow('lease lost');
    }
  );
});
