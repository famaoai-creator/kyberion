import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMissionProgressController,
  isRegularMissionProgressArtifactPath,
} from './mission-orchestration-progress.js';
import { renderProcessTemplateSkeleton } from './mission-planning-packet.js';
import * as pathResolver from '../path-resolver.js';
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
    // Mission paths are owner-derived: the mission exists once its state is recorded.
    fs.writeFileSync(
      path.join(confidentialMissionPath, 'mission-state.json'),
      JSON.stringify({ mission_id: confidentialMissionId, tier: 'confidential' })
    );
    fs.writeFileSync(
      path.join(confidentialMissionPath, 'NEXT_TASKS.json'),
      JSON.stringify([{ task_id: 'confidential-task', status: 'planned' }])
    );

    const tasks = controller((raw) => raw as PlannedNextTask[]).loadAllNextTasks(
      confidentialMissionId
    );

    expect(tasks).toEqual([{ task_id: 'confidential-task', status: 'planned' }]);
  });

  it('never lets a worker write revert a superseded task, and counts it on the task board', () => {
    const previousRole = process.env.MISSION_ROLE;
    process.env.MISSION_ROLE = 'mission_controller';
    try {
      fs.mkdirSync(missionPath, { recursive: true });
      fs.writeFileSync(
        path.join(missionPath, 'mission-state.json'),
        JSON.stringify({ mission_id: missionId, tier: 'public' })
      );
      const record = {
        by_task_id: 'new',
        at: '2026-10-26T00:00:00.000Z',
        actor_id: 'operator',
        reason_sha256: 'a'.repeat(64),
        approval_request_id: 'approval-1',
      };
      const rewrite = { from: 'old', to: 'new', at: '2026-10-26T00:00:00.000Z' };
      fs.writeFileSync(
        path.join(missionPath, 'NEXT_TASKS.json'),
        JSON.stringify([
          { task_id: 'old', status: 'superseded', superseded: record },
          { task_id: 'new', status: 'planned' },
          {
            task_id: 'after',
            status: 'planned',
            dependencies: ['new'],
            dependencies_rewritten_from: [rewrite],
          },
          { task_id: 'other', status: 'planned' },
        ])
      );
      fs.writeFileSync(
        path.join(missionPath, 'TASK_BOARD.md'),
        '# TASK_BOARD\n\n## Status: Execution Ready\n'
      );
      const progress = controller((raw) => raw as PlannedNextTask[]);
      // A stale in-memory board (loaded before the supersede) is written back.
      progress.writeNextTasks(missionId, [
        { task_id: 'old', status: 'blocked' },
        { task_id: 'new', status: 'completed' },
        // The worker's own dependency edit ('other') is kept; only old → new is re-applied.
        { task_id: 'after', status: 'planned', dependencies: ['old', 'other'] },
        // A worker write never introduces a supersede.
        { task_id: 'other', status: 'superseded', superseded: record },
      ]);
      const written = progress.loadAllNextTasks(missionId);
      expect(written.map((task) => task.status)).toEqual([
        'superseded',
        'completed',
        'planned',
        'planned',
      ]);
      expect(written[0].superseded).toEqual(record);
      expect(written[2]).toMatchObject({
        dependencies: ['new', 'other'],
        dependencies_rewritten_from: [rewrite],
      });
      expect(written[3]).not.toHaveProperty('superseded');
      // A write that lacks the superseded task and its replacement keeps both.
      progress.writeNextTasks(missionId, [{ task_id: 'other', status: 'planned' }]);
      expect(
        progress
          .loadAllNextTasks(missionId)
          .map((task) => task.task_id)
          .sort()
      ).toEqual(['new', 'old', 'other']);
      // Restore the board for the outcome summary below.
      progress.writeNextTasks(missionId, [
        { task_id: 'old', status: 'superseded' },
        { task_id: 'new', status: 'completed' },
      ]);
      expect(progress.summarizeMissionTaskOutcomes(missionId)).toMatchObject({
        completedCount: 1,
        supersededCount: 1,
      });
      progress.reconcileMissionProgress(missionId);
      const board = fs.readFileSync(path.join(missionPath, 'TASK_BOARD.md'), 'utf8');
      expect(board).toMatch(/^Superseded tasks: 1$/mu);
      progress.reconcileMissionProgress(missionId);
      expect(
        fs.readFileSync(path.join(missionPath, 'TASK_BOARD.md'), 'utf8').match(/Superseded tasks/gu)
      ).toHaveLength(1);
    } finally {
      if (previousRole === undefined) delete process.env.MISSION_ROLE;
      else process.env.MISSION_ROLE = previousRole;
    }
  });

  it('rejects a symlinked mission directory before loading NEXT_TASKS', () => {
    const externalMissionPath = pathResolver.sharedTmp('mission-progress-external');
    fs.mkdirSync(externalMissionPath, { recursive: true });
    fs.writeFileSync(
      path.join(externalMissionPath, 'NEXT_TASKS.json'),
      JSON.stringify([{ task_id: 'escaped-task' }])
    );
    fs.writeFileSync(
      path.join(externalMissionPath, 'mission-state.json'),
      JSON.stringify({ mission_id: missionId, tier: 'public' })
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
