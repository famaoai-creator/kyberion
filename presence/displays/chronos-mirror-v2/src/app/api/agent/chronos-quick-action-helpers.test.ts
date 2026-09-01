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
});
