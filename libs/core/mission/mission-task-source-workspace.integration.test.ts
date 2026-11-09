/** Real isolated Git, canonical task board, WorkItem lease and private runtime IO. */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { seedFirstJobTestRoot } from '../../../scripts/fixtures/first-job-approval-fixture.js';
import { safeWriteFile, safeReadFile, safeExecResult, safeRmSync } from '../secure-io.js';
import type { MissionState } from './mission-types.js';
const original = process.cwd();
const root = path.join(original, 'active/shared/tmp', `ordinary-source-${randomUUID()}`);
let sha = '';
function git(args: string[]) {
  const result = safeExecResult('git', args, { cwd: root });
  if (result.status !== 0 || result.error) throw new Error(result.stderr || 'Fixture Git failed');
  return result.stdout.trim();
}
beforeAll(() => {
  seedFirstJobTestRoot(original, root);
  const manifest = 'libs/actuators/vcs-actuator/manifest.json';
  safeWriteFile(path.join(root, manifest), safeReadFile(path.join(original, manifest)), {
    mkdir: true,
  });
  safeWriteFile(path.join(root, 'libs/core/example.ts'), 'export const value = 1;', {
    mkdir: true,
  });
  safeWriteFile(path.join(root, 'libs/core/ungranted.ts'), 'export const secret = true;', {
    mkdir: true,
  });
  safeWriteFile(
    path.join(root, 'knowledge/personal/tenants/acme.json'),
    JSON.stringify({
      tenant_slug: 'acme',
      display_name: 'Fixture',
      status: 'active',
      assigned_role: 'owner',
    }),
    { mkdir: true }
  );
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['add', 'libs/core/example.ts', 'libs/core/ungranted.ts']);
  git(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'seed']);
  sha = git(['rev-parse', 'HEAD']);
  process.chdir(root);
  vi.stubEnv('KYBERION_ROOT', root);
  for (const name of [
    'MISSION_ID',
    'SYSTEM_ROLE',
    'KYBERION_SUDO',
    'KYBERION_STANCE',
    'KYBERION_TASK_ID',
  ])
    vi.stubEnv(name, '');
  vi.stubEnv('KYBERION_TIER', 'confidential');
  vi.stubEnv('KYBERION_TENANT', 'acme');
  vi.stubEnv('KYBERION_ORGANIZATION_ID', 'org-a');
  vi.stubEnv('KYBERION_PROJECT_ID', 'project-a');
  vi.resetModules();
}, 60_000);
afterAll(() => {
  process.chdir(original);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  safeRmSync(root, { recursive: true, force: true });
});
it('prepares a confidential source target then edits only its exact private file under a real lease', async () => {
  const authority = await import('../authority.js');
  const io = await import('../secure-io.js');
  const facade = await import('./mission-task-source-workspace.js');
  const board = await import('./mission-lifecycle-completion.js');
  const coordination = await import('../workforce/work-coordination.js');
  const runtimeTools = await import('../workforce/task-tool-runtime.js');
  const id = 'MSN-ORDINARY-SOURCE';
  const dir = path.join(root, 'active/missions/confidential/acme', id);
  const scope = {
    tier: 'confidential' as const,
    tenant_slug: 'acme',
    organization_id: 'org-a',
    project_id: 'project-a',
    mission_id: id,
    task_id: 'implement',
    work_shape: 'improvement_experiment' as const,
  };
  const state: MissionState = {
    mission_id: id,
    tier: 'confidential',
    tenant_slug: 'acme',
    organization_id: 'org-a',
    relationships: { project: { project_id: 'project-a' } },
    status: 'active',
    execution_mode: 'local',
    priority: 1,
    org_role: 'tester',
    confidence_score: 1,
    git: { branch: 'main', start_commit: sha, latest_commit: sha, checkpoints: [] },
    history: [],
  };
  await authority.withExecutionContextAsync('mission_controller', async () => {
    io.safeMkdir(dir, { recursive: true });
    io.safeWriteFile(path.join(dir, 'mission-state.json'), JSON.stringify(state));
    board.writeMissionNextTasks(dir, [
      {
        task_id: 'implement',
        status: 'planned',
        assigned_to: { role: 'implementer' },
        target_path: 'libs/core/example.ts',
        source_edit_paths: ['libs/core/example.ts'],
        source_edit_requires_approval: false,
      },
    ]);
    const prepared = facade.prepareMissionTaskSourceWorkspace(id, 'implement', sha);
    expect(prepared.created).toBe(true);
    expect(io.safeExistsSync(path.join(prepared.cwd, 'knowledge/personal'))).toBe(false);
    // History retention: committed files outside the grant exist in the clone,
    // but remapped source_edit_paths / write grants stay exact to the reviewed set.
    expect(io.safeExistsSync(path.join(prepared.cwd, 'libs/core/ungranted.ts'))).toBe(true);
    expect(prepared.sourcePaths.every((entry) => !entry.endsWith('ungranted.ts'))).toBe(true);
    const rows = board.readMissionNextTasks(dir);
    expect(rows[0].target_path).toBe(prepared.sourcePaths[0]);
    expect(rows[0].source_edit_paths).toEqual(prepared.sourcePaths);
    expect(rows[0].source_workspace).toMatchObject({
      baseline_commit: sha,
      source_paths: ['libs/core/example.ts'],
    });
    const item = coordination.createWorkItem({
      title: 'Fixture implementation',
      description: 'Exact private source test',
      status: 'ready',
      context: scope,
      assigneePeerId: 'fixture-worker',
      metadata: { team_role: 'implementer' },
    });
    const claimed = coordination.claimWorkItem({
      itemId: item.item_id,
      actorPeerId: 'fixture-worker',
      purpose: 'fixture',
      ttlMs: 60_000,
    });
    const runtime = runtimeTools.createRuntimeForTask(
      {
        work_item_id: item.item_id,
        lease_id: claimed.lease.lease_id,
        capability_profile: 'implementer',
      },
      scope
    )!;
    await expect(
      runtime.execute({
        name: 'kyberion_task_write_source',
        arguments: { path: prepared.sourcePaths[0], content: 'export const value = 2;' },
      })
    ).resolves.toMatchObject({ status: 'written' });
    await expect(
      runtime.execute({
        name: 'kyberion_task_write_source',
        arguments: { path: 'libs/core/example.ts', content: 'escape' },
      })
    ).rejects.toThrow();
    expect(String(io.safeReadFile(path.join(root, 'libs/core/example.ts')))).toContain('value = 1');
    expect(String(io.safeReadFile(path.join(prepared.cwd, 'libs/core/example.ts')))).toContain(
      'value = 2'
    );
    expect(() => facade.prepareMissionTaskSourceWorkspace(id, 'implement', sha)).toThrow(
      /dispatch/i
    );
  });
}, 60_000);
