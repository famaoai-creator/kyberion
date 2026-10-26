import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as paths from '../path-resolver.js';
import { safeRmSync, safeWriteFile } from '../secure-io.js';
import { acquireLock, releaseLock } from '../foundation/lock-utils.js';
import {
  missionMutationSnapshot,
  withMissionMutationExpectation,
  holdsMissionMutationLock,
} from './mission-mutation-snapshot.js';
import { saveState } from './mission-state.js';
import type { MissionState } from './mission-types.js';

const missionId = `MSN-SNAPSHOT-${process.pid}`;
const directory = paths.pathResolver.sharedTmp(`mission-snapshot-${process.pid}`);
const state = {
  mission_id: missionId,
  tier: 'public',
  status: 'active',
  execution_mode: 'local',
  priority: 1,
  assigned_persona: 'worker',
  confidence_score: 1,
  git: { branch: 'main', start_commit: 'start', latest_commit: 'latest', checkpoints: [] },
  history: [],
} as MissionState;
function seed() {
  vi.stubEnv('MISSION_ROLE', 'mission_controller');
  vi.spyOn(paths, 'findMissionPath').mockReturnValue(directory);
  safeWriteFile(path.join(directory, 'mission-state.json'), JSON.stringify(state), { mkdir: true });
  safeWriteFile(path.join(directory, 'NEXT_TASKS.json'), '[]');
}
afterEach(() => {
  releaseLock(`mission-${missionId}`);
  safeRmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe('approved canonical mission mutation', () => {
  it('rejects a snapshot changed while the child waits for its mission lock', async () => {
    seed();
    const hash = missionMutationSnapshot(missionId, 'verify');
    await acquireLock(`mission-${missionId}`);
    const effect = vi.fn(async () => undefined);
    const operation = withMissionMutationExpectation(
      { missionId, operation: 'verify', hash },
      effect
    );
    safeWriteFile(path.join(directory, 'NEXT_TASKS.json'), '[{"task_id":"changed"}]');
    releaseLock(`mission-${missionId}`);
    await expect(operation).rejects.toThrow('MCP_MISSION_STALE_APPROVAL');
    expect(effect).not.toHaveBeenCalled();
  });
  it('holds the approved lifecycle lock across saveState without reacquiring it', async () => {
    seed();
    const hash = missionMutationSnapshot(missionId, 'verify');
    await withMissionMutationExpectation({ missionId, operation: 'verify', hash }, async () => {
      expect(holdsMissionMutationLock(missionId)).toBe(true);
      expect(holdsMissionMutationLock('MSN-OTHER')).toBe(false);
      await saveState(missionId, { ...state, confidence_score: 0.9 }, { missionDir: directory });
    });
    expect(holdsMissionMutationLock(missionId)).toBe(false);
  });
});
