import * as nodePath from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '../secure-io.js';
import { TASK_STATUS_RANK, updateNextTasksReflection } from './mission-workitem-dispatch-ticket.js';

const missionId = 'MSN-TICKET-RANK-TEST';
const missionPath = pathResolver.missionDir(missionId, 'public');
let previousRole: string | undefined;

beforeEach(() => {
  previousRole = process.env.MISSION_ROLE;
  process.env.MISSION_ROLE = 'mission_controller';
  safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    nodePath.join(missionPath, 'mission-state.json'),
    JSON.stringify({ mission_id: missionId, tier: 'public' })
  );
});

afterEach(() => {
  safeRmSync(missionPath, { recursive: true, force: true });
  if (previousRole === undefined) delete process.env.MISSION_ROLE;
  else process.env.MISSION_ROLE = previousRole;
});

describe('ticket outcome reflection on NEXT_TASKS', () => {
  it('ranks superseded above every ticket outcome, so no outcome reverts it', () => {
    expect(TASK_STATUS_RANK.superseded).toBeGreaterThan(
      Math.max(TASK_STATUS_RANK.accepted, TASK_STATUS_RANK.completed)
    );
    safeWriteFile(
      nodePath.join(missionPath, 'NEXT_TASKS.json'),
      JSON.stringify([{ task_id: 'old', status: 'superseded' }])
    );
    updateNextTasksReflection(missionPath, missionId, 'old', { work_item_id: 'WI-1' }, 'done');
    const tasks = JSON.parse(
      String(safeReadFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), { encoding: 'utf8' }))
    ) as Array<Record<string, unknown>>;
    expect(tasks[0]).toMatchObject({
      status: 'superseded',
      ticket_dispatch: { work_item_id: 'WI-1' },
    });
  });
});

describe('WorkItem dependency satisfaction', () => {
  it('an item archived by supersede-task never satisfies a dependency', async () => {
    const {
      clearWorkCoordinationNamespace,
      clearWorkCoordinationStore,
      createWorkItem,
      setWorkCoordinationNamespace,
    } = await import('../workforce/work-coordination.js');
    const { areMissionTaskDependenciesSatisfied } =
      await import('./mission-workitem-dispatch-execution.js');
    setWorkCoordinationNamespace(`mission-ticket-rank-test-${process.pid}`);
    clearWorkCoordinationStore();
    try {
      const item = (taskId: string, status: 'archived' | 'ready', superseded = false) =>
        createWorkItem({
          itemId: `witem-rank-${taskId}`,
          title: taskId,
          description: taskId,
          status,
          projectId: 'PRJ-RANK',
          context: { mission_id: missionId, project_id: 'PRJ-RANK', task_id: taskId },
          metadata: { task_id: taskId, ...(superseded ? { superseded_by: 'new' } : {}) },
        });
      item('old', 'archived', true);
      item('archived', 'archived');
      const dependent = item('after', 'ready');
      const state = {
        mission_id: missionId,
        tier: 'public',
        relationships: { project: { project_id: 'PRJ-RANK', relationship_type: 'belongs_to' } },
      } as unknown as Parameters<typeof areMissionTaskDependenciesSatisfied>[0];
      expect(
        areMissionTaskDependenciesSatisfied(state, { ...dependent, dependencies: ['archived'] })
      ).toBe(true);
      expect(
        areMissionTaskDependenciesSatisfied(state, { ...dependent, dependencies: ['old'] })
      ).toBe(false);
    } finally {
      clearWorkCoordinationStore();
      clearWorkCoordinationNamespace();
    }
  });
});
