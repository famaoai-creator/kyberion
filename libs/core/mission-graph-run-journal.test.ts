import { beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import {
  loadMissionGraphRunJournal,
  openOrCreateMissionGraphRunJournal,
} from './mission-graph-run-journal.js';
import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

describe('mission-graph-run-journal', () => {
  beforeEach(() => {
    process.env.MISSION_ROLE = 'mission_controller';
  });

  it('persists the latest node snapshot and restores it after reopening', () => {
    const missionId = 'MSN-GRAPH-JOURNAL-1';
    const runId = 'ME-RESUME-1';
    const coordinationPath = `${pathResolver.missionDir(missionId, 'public')}/coordination`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(coordinationPath, { recursive: true, force: true });
    });

    const journal = withExecutionContext('mission_controller', () =>
      openOrCreateMissionGraphRunJournal({
        missionId,
        runId,
        taskIds: ['task-a', 'task-b'],
      })
    );
    journal.append('node_state', {
      task_id: 'task-a',
      state: 'rework',
      task_snapshot: { task_id: 'task-a', status: 'rework', rework_count: 1 },
    });
    journal.append('node_state', {
      task_id: 'task-a',
      state: 'completed',
      outcome: { task_id: 'task-a', dispatched: true },
      task_snapshot: {
        task_id: 'task-a',
        status: 'completed',
        last_result: { summary: 'finished' },
      },
    });

    const reopened = withExecutionContext('mission_controller', () =>
      openOrCreateMissionGraphRunJournal({
        missionId,
        runId,
        taskIds: ['task-a', 'task-b'],
      })
    );
    const state = reopened.state();
    expect(state.task_ids).toEqual(['task-a', 'task-b']);
    expect(state.node_states.get('task-a')).toEqual({
      task_id: 'task-a',
      state: 'completed',
      outcome: { task_id: 'task-a', dispatched: true },
      task_snapshot: {
        task_id: 'task-a',
        status: 'completed',
        last_result: { summary: 'finished' },
      },
    });
    expect(state.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it('fails closed on a broken sequence instead of resuming partial state', () => {
    const missionId = 'MSN-GRAPH-JOURNAL-2';
    const runId = 'ME-BROKEN-1';
    const coordinationPath = `${pathResolver.missionDir(missionId, 'public')}/coordination`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(coordinationPath, { recursive: true, force: true });
    });
    const journal = withExecutionContext('mission_controller', () =>
      openOrCreateMissionGraphRunJournal({ missionId, runId, taskIds: ['task-a'] })
    );
    const raw = withExecutionContext('mission_controller', () =>
      String(safeReadFile(journal.path, { encoding: 'utf8' }) || '')
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(journal.path, { force: true });
    });
    withExecutionContext('mission_controller', () => {
      // Recreate a malformed journal through the governed secure-io path.
      safeWriteFile(
        journal.path,
        `${raw}{"version":1,"sequence":3,"run_id":"ME-BROKEN-1","mission_id":"MSN-GRAPH-JOURNAL-2","event":"node_state","timestamp":"2026-08-01T00:00:00.000Z","payload":{"task_id":"task-a","state":"completed"}}\n`
      );
    });
    expect(() =>
      withExecutionContext('mission_controller', () => loadMissionGraphRunJournal(missionId, runId))
    ).toThrow(/non-contiguous/);
  });
});
