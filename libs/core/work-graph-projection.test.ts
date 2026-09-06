import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  setWorkCoordinationNamespace,
} from './work-coordination.js';
import { projectWorkGraphToNextTasks, readCanonicalWorkGraph } from './work-graph-projection.js';
import { pathResolver, safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './index.js';

const missionPath = pathResolver.sharedTmp('work-graph-projection-test');

beforeEach(() => {
  setWorkCoordinationNamespace('work-graph-projection-test');
  clearWorkCoordinationStore();
  safeRmSync(missionPath, { recursive: true, force: true });
});

afterEach(() => {
  clearWorkCoordinationStore();
  clearWorkCoordinationNamespace();
  safeRmSync(missionPath, { recursive: true, force: true });
});

describe('work graph projection', () => {
  it('reads canonical WorkItems even when NEXT_TASKS is absent or stale', () => {
    const item = createWorkItem({
      itemId: 'canonical-read-item',
      title: 'Canonical state',
      description: 'Canonical state description.',
      projectId: 'PRJ-PROJECTION',
      status: 'ready',
      context: { project_id: 'PRJ-PROJECTION', task_id: 'canonical-read' },
    });
    const canonical = readCanonicalWorkGraph('PRJ-PROJECTION');
    expect(canonical.items.map((entry) => entry.item_id)).toEqual([item.item_id]);
    expect(canonical.graph.ready_item_ids).toEqual([item.item_id]);
    expect(safeExistsSync(nodePath.join(missionPath, 'NEXT_TASKS.json'))).toBe(false);
  });

  it('keeps canonical reads tenant-scoped when project IDs overlap', () => {
    const tenantA = createWorkItem({
      itemId: 'canonical-tenant-a',
      title: 'Tenant A task',
      description: 'Tenant A task description.',
      projectId: 'PRJ-SHARED-ID',
      context: { project_id: 'PRJ-SHARED-ID', tenant_slug: 'tenant-a', task_id: 'task-a' },
    });
    createWorkItem({
      itemId: 'canonical-tenant-b',
      title: 'Tenant B task',
      description: 'Tenant B task description.',
      projectId: 'PRJ-SHARED-ID',
      context: { project_id: 'PRJ-SHARED-ID', tenant_slug: 'tenant-b', task_id: 'task-b' },
    });

    const canonical = readCanonicalWorkGraph('PRJ-SHARED-ID', { tenantSlug: 'tenant-a' });
    expect(canonical.items.map((entry) => entry.item_id)).toEqual([tenantA.item_id]);
  });

  it('regenerates NEXT_TASKS from canonical WorkItems after the projection is deleted', () => {
    const item = createWorkItem({
      itemId: 'canonical-regeneration-item',
      title: 'Regenerate projection',
      description: 'Regenerate the compatibility projection from canonical state.',
      projectId: 'PRJ-PROJECTION',
      status: 'ready',
      context: { project_id: 'PRJ-PROJECTION', task_id: 'regenerate-projection' },
    });
    const first = projectWorkGraphToNextTasks({
      missionId: 'MSN-PROJECTION',
      projectId: 'PRJ-PROJECTION',
      missionPath,
      apply: true,
    });
    expect(first.applied).toBe(true);
    safeRmSync(nodePath.join(missionPath, 'NEXT_TASKS.json'));
    expect(safeExistsSync(nodePath.join(missionPath, 'NEXT_TASKS.json'))).toBe(false);

    const regenerated = projectWorkGraphToNextTasks({
      missionId: 'MSN-PROJECTION',
      projectId: 'PRJ-PROJECTION',
      missionPath,
      apply: true,
    });
    expect(regenerated.applied).toBe(true);
    expect(
      JSON.parse(String(safeReadFile(regenerated.next_tasks_path, { encoding: 'utf8' })))
    ).toEqual([
      expect.objectContaining({
        task_id: 'regenerate-projection',
        work_item_id: item.item_id,
        origin: 'canonical_work_graph',
      }),
    ]);
  });

  it('projects canonical WorkItems and reports drift without applying by default', () => {
    const completed = createWorkItem({
      itemId: 'projection-item-a',
      title: 'Prepare artifact',
      description: 'Prepare the artifact.',
      projectId: 'PRJ-PROJECTION',
      status: 'done',
      context: {
        project_id: 'PRJ-PROJECTION',
        task_id: 'task-a',
        work_shape: 'improvement_experiment',
      },
      metadata: { team_role: 'implementer', acceptance_criteria: ['artifact exists'] },
    });
    createWorkItem({
      itemId: 'projection-item-b',
      title: 'Review artifact',
      description: 'Review the artifact.',
      projectId: 'PRJ-PROJECTION',
      dependencies: [completed.item_id],
      context: {
        project_id: 'PRJ-PROJECTION',
        task_id: 'task-b',
        work_shape: 'improvement_experiment',
      },
      metadata: { team_role: 'reviewer', review_target: 'task-a', deliverable: 'REVIEW-task-a.md' },
    });

    const result = projectWorkGraphToNextTasks({
      missionId: 'MSN-PROJECTION',
      projectId: 'PRJ-PROJECTION',
      missionPath,
    });

    expect(result.applied).toBe(false);
    expect(result.graph_valid).toBe(true);
    expect(result.drift.map((entry) => entry.task_id)).toEqual(['task-a', 'task-b']);
    expect(result.projected_tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task_id: 'task-a', status: 'completed' }),
        expect.objectContaining({ task_id: 'task-b', dependencies: [completed.item_id] }),
      ])
    );
  });

  it('fails closed on stale projection entries instead of applying over legacy tasks', () => {
    createWorkItem({
      itemId: 'projection-item',
      title: 'Canonical task',
      description: 'Canonical description.',
      projectId: 'PRJ-PROJECTION',
      context: { project_id: 'PRJ-PROJECTION', task_id: 'canonical-task' },
    });
    const first = projectWorkGraphToNextTasks({
      missionId: 'MSN-PROJECTION',
      projectId: 'PRJ-PROJECTION',
      missionPath,
      apply: true,
    });
    expect(first.applied).toBe(true);

    const current = JSON.parse(
      String(safeReadFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), { encoding: 'utf8' }))
    );
    current.push({ task_id: 'legacy-task', status: 'planned', description: 'Keep me.' });
    safeWriteFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), JSON.stringify(current, null, 2));

    const result = projectWorkGraphToNextTasks({
      missionId: 'MSN-PROJECTION',
      projectId: 'PRJ-PROJECTION',
      missionPath,
      apply: true,
    });
    const projected = JSON.parse(
      String(safeReadFile(result.next_tasks_path, { encoding: 'utf8' }))
    );
    expect(result.applied).toBe(false);
    expect(result.drift).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task_id: 'legacy-task', kind: 'stale_projection_entry' }),
      ])
    );
    expect(projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task_id: 'canonical-task', origin: 'canonical_work_graph' }),
        expect.objectContaining({ task_id: 'legacy-task', description: 'Keep me.' }),
      ])
    );
  });

  it('updates canonical execution facts without erasing process-template history', () => {
    const item = createWorkItem({
      itemId: 'process-template-item',
      title: 'Canonical process item',
      description: 'Canonical process item description.',
      projectId: 'PRJ-PROJECTION',
      status: 'done',
      context: {
        project_id: 'PRJ-PROJECTION',
        tenant_slug: 'tenant-a',
        task_id: 'process-task',
        work_shape: 'solution_project',
      },
      metadata: { team_role: 'planner', acceptance_criteria: ['artifact exists'] },
    });
    safeWriteFile(
      nodePath.join(missionPath, 'NEXT_TASKS.json'),
      JSON.stringify([
        {
          task_id: 'process-task',
          status: 'planned',
          assigned_to: { role: 'planner' },
          description: 'Template-owned description',
          dependencies: [],
          origin: 'process_template',
          work_item_id: item.item_id,
          context: { project_id: 'PRJ-PROJECTION', task_id: 'process-task' },
          ticket_dispatch: { attempt_count: 2 },
        },
      ])
    );

    const result = projectWorkGraphToNextTasks({
      missionId: 'MSN-PROJECTION',
      projectId: 'PRJ-PROJECTION',
      missionPath,
      apply: true,
    });
    expect(result.applied).toBe(true);
    const projected = JSON.parse(
      String(safeReadFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), { encoding: 'utf8' }))
    );
    expect(projected[0]).toMatchObject({
      task_id: 'process-task',
      status: 'completed',
      dependencies: [],
      description: 'Template-owned description',
      ticket_dispatch: { attempt_count: 2 },
    });
  });

  it('refuses to apply when an existing projection is malformed', () => {
    safeWriteFile(
      nodePath.join(missionPath, 'NEXT_TASKS.json'),
      JSON.stringify([{ description: 'missing task id' }])
    );
    expect(() =>
      projectWorkGraphToNextTasks({
        missionId: 'MSN-PROJECTION',
        projectId: 'PRJ-PROJECTION',
        missionPath,
        apply: true,
      })
    ).toThrow(/missing task_id/);
  });

  it('rejects a symlinked mission path before reading or writing the projection', () => {
    const externalMissionPath = nodePath.join(
      nodePath.dirname(missionPath),
      'work-graph-projection-external'
    );
    fs.mkdirSync(externalMissionPath, { recursive: true });
    safeRmSync(missionPath, { recursive: true, force: true });
    // Tests intentionally use the native symlink primitive to model an
    // attacker replacing the mission directory between discovery and use.
    fs.symlinkSync(externalMissionPath, missionPath, 'dir');
    try {
      expect(() =>
        projectWorkGraphToNextTasks({
          missionId: 'MSN-PROJECTION',
          projectId: 'PRJ-PROJECTION',
          missionPath,
          apply: true,
        })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      fs.unlinkSync(missionPath);
      safeRmSync(externalMissionPath, { recursive: true, force: true });
    }
  });
});
