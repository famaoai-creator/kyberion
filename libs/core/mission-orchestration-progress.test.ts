import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMissionProgressController,
  isRegularMissionProgressArtifactPath,
} from './mission-orchestration-progress.js';
import { renderProcessTemplateSkeleton } from './mission-planning-packet.js';
import * as pathResolver from './path-resolver.js';
import type { PlannedNextTask } from './mission-orchestration-worker-contracts.js';

const missionId = 'MSN-PROGRESS-PATH-001';
const missionPath = pathResolver.missionDir(missionId, 'public');
const confidentialMissionId = 'MSN-PROGRESS-PATH-002';
const confidentialMissionPath = pathResolver.missionDir(confidentialMissionId, 'confidential');

function controller(
  validatePlannedNextTasks: (raw: unknown, missionId: string) => PlannedNextTask[] = () => []
) {
  return createMissionProgressController({
    validatePlannedNextTasks,
    summarizeMissionGateState: () => ({ lines: [], reworkCount: 0 }),
  });
}

function removeTestPath(target: string): void {
  try {
    if (fs.lstatSync(target).isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

describe('mission orchestration progress path boundaries', () => {
  afterEach(() => {
    removeTestPath(missionPath);
    removeTestPath(confidentialMissionPath);
    removeTestPath(pathResolver.sharedTmp('mission-progress-external'));
  });

  it('accepts only regular files for progress artifacts', () => {
    const fixtureRoot = pathResolver.sharedTmp('mission-progress-artifact-loader');
    const filePath = path.join(fixtureRoot, 'TASK_BOARD.md');
    const directoryPath = path.join(fixtureRoot, 'TASK_BOARD-directory.md');
    try {
      fs.mkdirSync(fixtureRoot, { recursive: true });
      fs.writeFileSync(filePath, '# task board\n');
      fs.mkdirSync(directoryPath, { recursive: true });

      expect(isRegularMissionProgressArtifactPath(filePath)).toBe(true);
      expect(isRegularMissionProgressArtifactPath(directoryPath)).toBe(false);
      expect(isRegularMissionProgressArtifactPath(path.join(fixtureRoot, 'missing.md'))).toBe(
        false
      );
    } finally {
      removeTestPath(fixtureRoot);
    }
  });

  it('loads NEXT_TASKS from an existing confidential mission root', () => {
    fs.mkdirSync(confidentialMissionPath, { recursive: true });
    fs.writeFileSync(
      path.join(confidentialMissionPath, 'NEXT_TASKS.json'),
      JSON.stringify([{ task_id: 'confidential-task', status: 'planned' }])
    );

    const tasks = controller((raw) => raw as PlannedNextTask[]).loadAllNextTasks(
      confidentialMissionId
    );

    expect(tasks).toEqual([{ task_id: 'confidential-task', status: 'planned' }]);
  });

  it('rejects a symlinked mission directory before loading NEXT_TASKS', () => {
    const externalMissionPath = pathResolver.sharedTmp('mission-progress-external');
    fs.mkdirSync(externalMissionPath, { recursive: true });
    fs.writeFileSync(
      path.join(externalMissionPath, 'NEXT_TASKS.json'),
      JSON.stringify([{ task_id: 'escaped-task' }])
    );
    removeTestPath(missionPath);
    fs.symlinkSync(externalMissionPath, missionPath, 'dir');

    expect(() => controller().loadAllNextTasks(missionId)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });

  it('rejects a symlinked mission directory before rendering the planning skeleton', () => {
    const externalMissionPath = pathResolver.sharedTmp('mission-progress-external');
    fs.mkdirSync(externalMissionPath, { recursive: true });
    fs.writeFileSync(
      path.join(externalMissionPath, 'mission-state.json'),
      JSON.stringify({ process_template: { workflow_id: 'escaped-workflow' } })
    );
    removeTestPath(missionPath);
    fs.symlinkSync(externalMissionPath, missionPath, 'dir');

    expect(() => renderProcessTemplateSkeleton(missionId)).toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
