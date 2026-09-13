import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import { cancelMission, pauseMission } from './mission-lifecycle-operator-actions.js';
import type { MissionState } from './mission-types.js';

/**
 * FD-10 wave 1b (front-desk redesign plan §2.5 principle 4): `decided_by` is
 * additive on the PAUSE/CANCEL history entries these operator actions write.
 * Hermetic: each test uses its own mission id under active/missions/public
 * and cleans it up afterward (mirrors mission-lifecycle.test.ts).
 */

const pauseMissionId = 'MSN-OPERATOR-ACTIONS-DECIDED-BY-PAUSE';
const cancelMissionId = 'MSN-OPERATOR-ACTIONS-DECIDED-BY-CANCEL';
const pausePath = pathResolver.missionDir(pauseMissionId, 'public');
const cancelPath = pathResolver.missionDir(cancelMissionId, 'public');

function seedActiveMissionState(missionPath: string, missionId: string): void {
  safeMkdir(missionPath, { recursive: true });
  safeWriteFile(
    `${missionPath}/mission-state.json`,
    JSON.stringify(
      {
        mission_id: missionId,
        tier: 'public',
        status: 'active',
        execution_mode: 'local',
        priority: 1,
        assigned_persona: 'tester',
        confidence_score: 1,
        git: { branch: 'test', start_commit: 'abc123', latest_commit: 'abc123', checkpoints: [] },
        history: [],
        context: {},
      },
      null,
      2
    )
  );
}

function readState(missionPath: string): MissionState {
  return JSON.parse(
    safeReadFile(`${missionPath}/mission-state.json`, { encoding: 'utf8' }) as string
  ) as MissionState;
}

beforeEach(() => {
  process.env.MISSION_ROLE = 'mission_controller';
  process.env.KYBERION_PERSONA = 'worker';
  seedActiveMissionState(pausePath, pauseMissionId);
  seedActiveMissionState(cancelPath, cancelMissionId);
});

afterEach(() => {
  if (safeExistsSync(pausePath)) safeRmSync(pausePath, { recursive: true, force: true });
  if (safeExistsSync(cancelPath)) safeRmSync(cancelPath, { recursive: true, force: true });
});

describe('mission-lifecycle-operator-actions — FD-10 wave 1b decided_by', () => {
  it('pauseMission stamps decided_by on the PAUSE history entry when provided', async () => {
    const decidedBy = {
      kind: 'human' as const,
      id: 'user:owner-1',
      display_name: 'Owner One',
      role: 'owner' as const,
    };
    await pauseMission(pauseMissionId, 'operator paused it', decidedBy);

    const state = readState(pausePath);
    expect(state.status).toBe('paused');
    const entry = state.history.at(-1);
    expect(entry.event).toBe('PAUSE');
    expect(entry.decided_by).toEqual(decidedBy);
  });

  it('pauseMission omits decided_by when not provided (legacy behavior preserved)', async () => {
    await pauseMission(pauseMissionId, 'operator paused it');

    const state = readState(pausePath);
    const entry = state.history.at(-1);
    expect(entry.event).toBe('PAUSE');
    expect(entry.decided_by).toBeUndefined();
  });

  it('cancelMission stamps decided_by on the CANCEL history entry when provided', async () => {
    const decidedBy = {
      kind: 'human' as const,
      id: 'user:approver-2',
      display_name: 'Approver Two',
      role: 'approver' as const,
    };
    await cancelMission(cancelMissionId, 'operator cancelled it', decidedBy);

    const state = readState(cancelPath);
    expect(state.status).toBe('failed');
    const entry = state.history.at(-1);
    expect(entry.event).toBe('CANCEL');
    expect(entry.decided_by).toEqual(decidedBy);
  });

  it('cancelMission omits decided_by when not provided (legacy behavior preserved)', async () => {
    await cancelMission(cancelMissionId, 'operator cancelled it');

    const state = readState(cancelPath);
    const entry = state.history.at(-1);
    expect(entry.event).toBe('CANCEL');
    expect(entry.decided_by).toBeUndefined();
  });
});
