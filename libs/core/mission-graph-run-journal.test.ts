import { beforeEach, describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import {
  loadMissionGraphRunJournal,
  openOrCreateMissionGraphRunJournal,
} from './mission-graph-run-journal.js';
import { pathResolver } from './path-resolver.js';
import {
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';

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

  it('rejects a schema-invalid journal event before recovery', () => {
    const missionId = 'MSN-GRAPH-JOURNAL-SCHEMA';
    const runId = 'ME-SCHEMA-1';
    const coordinationPath = `${pathResolver.missionDir(missionId, 'public')}/coordination`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(coordinationPath, { recursive: true, force: true });
    });
    const journal = withExecutionContext('mission_controller', () =>
      openOrCreateMissionGraphRunJournal({ missionId, runId, taskIds: ['task-a'] })
    );
    withExecutionContext('mission_controller', () => {
      safeWriteFile(
        journal.path,
        `${JSON.stringify({
          version: 1,
          sequence: 2,
          run_id: runId,
          mission_id: missionId,
          event: 'node_state',
          timestamp: new Date().toISOString(),
          payload: { task_id: 'task-a' },
          unexpected: true,
        })}\n`
      );
    });
    expect(() =>
      withExecutionContext('mission_controller', () => loadMissionGraphRunJournal(missionId, runId))
    ).toThrow(/Invalid catalog mission-graph-run-journal-event/);
  });

  it('re-reads the sequence under the fence when two handles append after a restart', () => {
    const missionId = 'MSN-GRAPH-JOURNAL-3';
    const runId = 'ME-STALE-HANDLES-1';
    const coordinationPath = `${pathResolver.missionDir(missionId, 'public')}/coordination`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(coordinationPath, { recursive: true, force: true });
    });

    const first = withExecutionContext('mission_controller', () =>
      openOrCreateMissionGraphRunJournal({ missionId, runId, taskIds: ['task-a'] })
    );
    const second = withExecutionContext('mission_controller', () =>
      openOrCreateMissionGraphRunJournal({ missionId, runId, taskIds: ['task-a'] })
    );

    withExecutionContext('mission_controller', () => {
      first.append('node_state', { task_id: 'task-a', state: 'rework' });
      second.append('graph_finished', { status: 'completed' });
    });

    const state = withExecutionContext('mission_controller', () =>
      loadMissionGraphRunJournal(missionId, runId)
    );
    expect(state.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(state.finished?.status).toBe('completed');
  });

  it('rejects a symlinked coordination directory before journal access', () => {
    const missionId = 'MSN-GRAPH-JOURNAL-SYMLINK';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const coordinationPath = `${missionPath}/coordination`;
    const externalPath = pathResolver.sharedTmp('graph-journal-external');
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionPath, { recursive: true });
      safeMkdir(externalPath, { recursive: true });
      safeRmSync(coordinationPath, { recursive: true, force: true });
      safeSymlinkSync(externalPath, coordinationPath, 'dir');
    });
    try {
      expect(() =>
        withExecutionContext('mission_controller', () =>
          openOrCreateMissionGraphRunJournal({
            missionId,
            runId: 'ME-SYMLINK-1',
            taskIds: ['task-a'],
          })
        )
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(coordinationPath, { recursive: true, force: true });
        safeRmSync(missionPath, { recursive: true, force: true });
        safeRmSync(externalPath, { recursive: true, force: true });
      });
    }
  });

  it('rejects a journal file that is replaced by a symbolic link before append', () => {
    const missionId = 'MSN-GRAPH-JOURNAL-FILE-SYMLINK';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const externalPath = pathResolver.sharedTmp('graph-journal-file-external');
    const journal = withExecutionContext('mission_controller', () =>
      openOrCreateMissionGraphRunJournal({
        missionId,
        runId: 'ME-FILE-SYMLINK-1',
        taskIds: ['task-a'],
      })
    );
    withExecutionContext('mission_controller', () => {
      safeWriteFile(externalPath, '');
      safeRmSync(journal.path, { force: true });
      safeSymlinkSync(externalPath, journal.path);
    });
    try {
      expect(() =>
        withExecutionContext('mission_controller', () =>
          journal.append('node_state', { task_id: 'task-a', state: 'completed' })
        )
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(journal.path, { recursive: true, force: true });
        safeRmSync(missionPath, { recursive: true, force: true });
        safeRmSync(externalPath, { force: true });
      });
    }
  });

  it('uses an existing confidential mission root for graph recovery journals', () => {
    const missionId = 'MSN-GRAPH-JOURNAL-CONFIDENTIAL';
    const missionPath = pathResolver.missionDir(missionId, 'confidential');
    withExecutionContext('mission_controller', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
      safeMkdir(missionPath, { recursive: true });
    });

    try {
      const journal = withExecutionContext('mission_controller', () =>
        openOrCreateMissionGraphRunJournal({
          missionId,
          runId: 'ME-CONFIDENTIAL-1',
          taskIds: ['task-a'],
        })
      );
      expect(journal.path).toContain('/active/missions/confidential/');
      expect(journal.path).toContain('/coordination/graph-run-ME-CONFIDENTIAL-1.jsonl');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });
});
