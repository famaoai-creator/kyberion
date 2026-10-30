import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { saveTaskPlan } from '@agent/core/sdlc-artifact-store';
import { writeMissionNextTasks } from '@agent/core/mission';
import { decomposeIntoTasks, taskPlanToNextTasks } from './task-plan-ops.js';

describe('orchestrator task-plan input boundaries', () => {
  it('rejects an external requirements draft before reading it', async () => {
    await expect(
      decomposeIntoTasks({
        mission_id: 'MSN-TASK-PLAN-PATH-BOUNDARY-001',
        project_name: 'boundary-check',
        requirements_draft_path: '/tmp/external-requirements-draft.json',
      })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });
});

describe('orchestrator task plan to NEXT_TASKS', () => {
  const missionId = 'MSN-TASK-PLAN-BOARD-WRITER-001';
  const missionDir = pathResolver.missionDir(missionId, 'public');

  const savedEnv = { role: process.env.MISSION_ROLE, persona: process.env.KYBERION_PERSONA };

  beforeEach(() => {
    process.env.MISSION_ROLE = 'mission_controller';
    process.env.KYBERION_PERSONA = 'worker';
  });

  afterEach(() => {
    safeRmSync(missionDir, { recursive: true, force: true });
    if (savedEnv.role === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedEnv.role;
    if (savedEnv.persona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedEnv.persona;
  });

  it('writes the plan through the board writer, keeping a supersede on disk and rewiring to its replacement', () => {
    safeMkdir(missionDir, { recursive: true });
    safeWriteFile(
      `${missionDir}/mission-state.json`,
      JSON.stringify({ mission_id: missionId, tier: 'public', status: 'active', history: [] })
    );
    const superseded = {
      by_task_id: 'T-IMPL-2',
      at: '2026-10-30T00:00:00.000Z',
      actor_id: 'operator',
      reason_sha256: 'a'.repeat(64),
      approval_request_id: '0b9d6f2e-3c4a-4d5e-8f60-718293a4b5c6',
    };
    writeMissionNextTasks(
      missionDir,
      [
        { task_id: 'T-IMPL-1', status: 'superseded', superseded },
        { task_id: 'T-IMPL-2', status: 'planned' },
      ],
      { allowSupersede: true }
    );
    saveTaskPlan({
      missionId,
      projectName: 'board-writer',
      decomposed: {
        tasks: [
          {
            task_id: 'T-IMPL-1',
            title: 'Implement core',
            summary: 'core module',
            priority: 'must',
            estimate: 'M',
            test_criteria: ['core tests pass'],
          },
          {
            task_id: 'T-IMPL-2',
            title: 'Implement core again',
            summary: 'the replacement, planned after the original',
            priority: 'must',
            estimate: 'S',
            depends_on: ['T-IMPL-1'],
          },
          {
            task_id: 'T-REVIEW-1',
            title: 'Review',
            summary: 'PR review',
            priority: 'should',
            estimate: 'S',
            assigned_role: 'reviewer',
            depends_on: ['T-IMPL-1'],
          },
        ],
      },
    });

    expect(taskPlanToNextTasks({ mission_id: missionId }).task_count).toBe(3);
    const board = JSON.parse(
      String(safeReadFile(`${missionDir}/NEXT_TASKS.json`, { encoding: 'utf8' }))
    ) as Array<Record<string, unknown>>;
    expect(board.find((task) => task.task_id === 'T-IMPL-1')).toMatchObject({
      status: 'superseded',
      superseded,
    });
    // The replacement does not wait for itself.
    expect(board.find((task) => task.task_id === 'T-IMPL-2')?.dependencies).toEqual([]);
    // The review of the superseded task now reviews (and waits for) its replacement.
    expect(board.find((task) => task.task_id === 'T-REVIEW-1')).toMatchObject({
      dependencies: ['T-IMPL-2'],
      review_target: 'T-IMPL-2',
      deliverable: 'deliverables/REVIEW-T-IMPL-2.md',
    });
  });
});
