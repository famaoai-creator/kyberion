import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import {
  collectActiveMissions,
  collectMissionProgress,
  readJson,
} from './intelligence-observation-data';

const fixtureRoot = pathResolver.sharedTmp('chronos-intelligence-json-boundary-test');
const missionId = `chronos-progress-boundary-${process.pid}-${Date.now()}`;
const missionDir = pathResolver.rootResolve(`active/missions/public/${missionId}`);
const malformedMissionId = `chronos-malformed-state-${process.pid}-${Date.now()}`;
const malformedMissionDir = pathResolver.rootResolve(
  `active/missions/public/${malformedMissionId}`
);
const taskBoardTarget = pathResolver.sharedTmp(`${missionId}-TASK_BOARD.md`);
const assetTarget = pathResolver.sharedTmp(`${missionId}-deliverable.txt`);

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    safeRmSync(fixtureRoot, { recursive: true, force: true });
    safeRmSync(missionDir, { recursive: true, force: true });
    safeRmSync(malformedMissionDir, { recursive: true, force: true });
    safeRmSync(taskBoardTarget, { force: true });
    safeRmSync(assetTarget, { force: true });
  });
});

describe('chronos intelligence JSON resource boundaries', () => {
  it('returns no projection for a JSON resource reached through a symlink', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const targetPath = path.join(fixtureRoot, 'target.json');
    const linkedPath = path.join(fixtureRoot, 'linked.json');
    safeWriteFile(targetPath, JSON.stringify({ mission_id: 'MSN-LINKED' }));
    safeSymlinkSync(targetPath, linkedPath);

    expect(readJson(linkedPath)).toBeNull();
  });

  it('does not project symlinked task boards or generated assets', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(path.join(missionDir, 'deliverables'), { recursive: true });
      safeWriteFile(
        path.join(missionDir, 'mission-state.json'),
        JSON.stringify({ mission_id: missionId, status: 'active', tier: 'public' })
      );
      safeWriteFile(taskBoardTarget, '- [x] linked task\n');
      safeWriteFile(assetTarget, 'linked asset\n');
      safeSymlinkSync(taskBoardTarget, path.join(missionDir, 'TASK_BOARD.md'));
      safeSymlinkSync(assetTarget, path.join(missionDir, 'deliverables', 'linked.txt'));

      const activeMissions = collectActiveMissions();
      const mission = activeMissions.find((item) => item.missionId === missionId);
      expect(mission).toBeDefined();

      const progress = collectMissionProgress([mission!]).find(
        (item) => item.missionId === missionId
      );
      expect(progress?.boardStepsTotal).toBe(0);
      expect(progress?.generatedAssets).toEqual([]);
    });
  });

  it('does not project a mission whose state is a JSON array', () => {
    withExecutionContext('mission_controller', () => {
      safeMkdir(malformedMissionDir, { recursive: true });
      safeWriteFile(path.join(malformedMissionDir, 'mission-state.json'), JSON.stringify([]));
      safeWriteFile(path.join(malformedMissionDir, 'NEXT_TASKS.json'), JSON.stringify([]));

      expect(collectActiveMissions().some((item) => item.missionId === malformedMissionId)).toBe(
        false
      );
    });
  });
});
