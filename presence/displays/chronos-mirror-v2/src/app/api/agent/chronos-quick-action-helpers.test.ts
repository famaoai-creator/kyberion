import { describe, expect, it } from 'vitest';
import { collectActiveMissions } from './chronos-quick-action-helpers';

function makeCore(state: unknown, nextTasks: unknown) {
  const missionId = 'MSN-QUICK-ACTION';
  const core = {
    pathResolver: {
      active: (relativePath: string) => `/repo/active/${relativePath}`,
    },
    assertSafeRepositoryPath: (filePath: string) => filePath,
    safeExistsSync: () => true,
    safeLstat: (filePath: string) => ({
      isDirectory: () => !filePath.endsWith('.json') && !filePath.endsWith('PLAN.md'),
      isFile: () => filePath.endsWith('.json') || filePath.endsWith('PLAN.md'),
    }),
    safeReaddir: (directoryPath: string) =>
      directoryPath.endsWith('/missions/public') ? [missionId] : [],
    loadStateAtPath: (filePath: string) =>
      (filePath.endsWith('mission-state.json') && state && typeof state === 'object'
        ? state
        : null) as never,
    readJson: <T = unknown>(filePath: string) =>
      (filePath.endsWith('mission-state.json') ? state : nextTasks) as T,
    safeExecResult: () => ({ status: 0 }),
  };
  return core;
}

describe('chronos quick action mission projection', () => {
  it('ignores primitive and array mission state', () => {
    expect(collectActiveMissions(makeCore([], []))).toEqual([]);
  });

  it('narrows mission fields before exposing a quick-action projection', () => {
    expect(
      collectActiveMissions(
        makeCore(
          {
            mission_id: 'MSN-VALID',
            status: 'active',
            tier: 'confidential',
            mission_type: 'delivery',
            git: { checkpoints: [{ id: 'checkpoint-1' }] },
            execution_mode: 'local',
            priority: 1,
            assigned_persona: 'operator',
            confidence_score: 1,
            history: [],
          },
          [{ status: 'planned' }, { status: 'completed' }]
        )
      )
    ).toEqual([
      {
        missionId: 'MSN-VALID',
        status: 'active',
        tier: 'confidential',
        missionType: 'delivery',
        checkpoints: 1,
        nextTaskCount: 2,
        planReady: true,
      },
    ]);
  });

  it('does not count malformed NEXT_TASKS entries in the quick-action projection', () => {
    const mission = collectActiveMissions(
      makeCore(
        {
          mission_id: 'MSN-MALFORMED-TASKS',
          status: 'active',
          tier: 'public',
          git: { checkpoints: [] },
        },
        [{ task_id: 'task-1', status: 'planned' }, { task_id: 42 }]
      )
    )[0];

    expect(mission?.nextTaskCount).toBe(0);
  });
});
