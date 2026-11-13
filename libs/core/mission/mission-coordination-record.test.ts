import { afterAll, describe, expect, it } from 'vitest';
import { withExecutionContext } from '../authority.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import {
  parseMissionCoordinationRecordRow,
  recordMissionCoordinationMessage,
} from './mission-coordination-record.js';
import { writeMissionStateAtPath } from './mission-state-reader.js';

const seededMissionDirs: string[] = [];

/** The record lives in the existing mission's own directory, so the mission must exist. */
function seedMission(missionId: string, tier: 'public' | 'confidential' = 'public'): void {
  withExecutionContext('mission_controller', () => {
    const dir = pathResolver.missionDir(missionId, tier);
    writeMissionStateAtPath(`${dir}/mission-state.json`, {
      mission_id: missionId,
      tier,
      status: 'active',
      execution_mode: 'local',
      priority: 1,
      org_role: 'worker',
      confidence_score: 1,
      git: {
        branch: `mission/${missionId}`,
        start_commit: 'a',
        latest_commit: 'a',
        checkpoints: [],
      },
      history: [],
    } as never);
    seededMissionDirs.push(dir);
  });
}

function readRows(file: string): Record<string, unknown>[] {
  return withExecutionContext('mission_controller', () =>
    String(safeReadFile(file, { encoding: 'utf8' }) || '')
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

afterAll(() => {
  withExecutionContext('mission_controller', () => {
    for (const dir of seededMissionDirs) safeRmSync(dir, { recursive: true, force: true });
  });
});

describe('mission-coordination-record', () => {
  it('parses message rows, bare rows and ignores acknowledgement rows', () => {
    const message = {
      message_id: 'MCB-1',
      mission_id: 'MSN-1',
      channel: 'handoff',
      from_agent: 'planner',
      content: 'Review this.',
      created_at: '2026-09-01T00:00:00.000Z',
      acknowledged_by: [],
    };
    expect(parseMissionCoordinationRecordRow(message)).toEqual(message);
    expect(parseMissionCoordinationRecordRow({ kind: 'message', message })).toEqual(message);
    expect(
      parseMissionCoordinationRecordRow({
        kind: 'ack',
        message_id: 'MCB-1',
        agent_id: 'reviewer',
        created_at: '2026-09-01T00:01:00.000Z',
      })
    ).toBeUndefined();
  });

  it('rejects malformed rows', () => {
    expect(parseMissionCoordinationRecordRow([])).toBeUndefined();
    expect(
      parseMissionCoordinationRecordRow({
        message_id: 'MCB-1',
        mission_id: 'MSN-1',
        channel: 'unknown',
        from_agent: 'planner',
        content: 'Review this.',
        created_at: '2026-09-01T00:00:00.000Z',
        acknowledged_by: [],
      })
    ).toBeUndefined();
    expect(parseMissionCoordinationRecordRow({ kind: 'ack', message_id: 'MCB-1' })).toBeUndefined();
  });

  it('reads an old ledger with acknowledgement events and all four channels without error', () => {
    const missionId = 'MSN-REC-LEGACY';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    seedMission(missionId);
    const channels = ['task_contract', 'handoff', 'review', 'runtime_notice'] as const;
    const lines = channels.map((channel, index) =>
      JSON.stringify({
        kind: 'message',
        message: {
          message_id: `MCB-OLD${index}`,
          mission_id: missionId,
          channel,
          from_agent: 'owner',
          content: `old ${channel}`,
          created_at: '2026-09-01T00:00:00.000Z',
          acknowledged_by: index === 0 ? ['reviewer-a'] : [],
        },
      })
    );
    lines.splice(
      2,
      0,
      JSON.stringify({
        kind: 'ack',
        message_id: 'MCB-OLD0',
        agent_id: 'reviewer-a',
        created_at: '2026-09-01T00:01:00.000Z',
      }),
      'not json {'
    );
    withExecutionContext('mission_controller', () => {
      safeMkdir(`${missionPath}/coordination`, { recursive: true });
      safeWriteFile(`${missionPath}/coordination/bus.jsonl`, `${lines.join('\n')}\n`);
    });
    const parsed = withExecutionContext('mission_controller', () =>
      String(safeReadFile(`${missionPath}/coordination/bus.jsonl`, { encoding: 'utf8' }))
    )
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => {
        try {
          return parseMissionCoordinationRecordRow(JSON.parse(line));
        } catch {
          return undefined;
        }
      })
      .filter((row) => row !== undefined);
    expect(parsed.map((row) => row?.channel)).toEqual([...channels]);

    // New writes append to the same ledger without touching old rows.
    recordMissionCoordinationMessage({
      mission_id: missionId,
      channel: 'handoff',
      from_agent: 'owner',
      content: 'new',
    });
    const raw = withExecutionContext('mission_controller', () =>
      String(safeReadFile(`${missionPath}/coordination/bus.jsonl`, { encoding: 'utf8' }))
    );
    expect(raw.split(/\r?\n/u).filter((l) => l.startsWith('{"kind":"message"'))).toHaveLength(5);
    expect(raw).toContain('not json {');
  });

  it('writes the same row shape for the rework handoff', () => {
    const missionId = 'MSN-REC-HANDOFF';
    seedMission(missionId);
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const message = recordMissionCoordinationMessage({
      mission_id: missionId,
      channel: 'handoff',
      from_agent: 'reviewer-agent',
      from_role: 'reviewer',
      to_agent: 'impl-agent',
      to_role: 'implementer',
      task_id: 'task-1',
      content: 'Review round 1 sent 2 finding(s) back to task-1 for rework.',
    });
    const [row] = readRows(`${missionPath}/coordination/bus.jsonl`);
    expect(row).toEqual({
      kind: 'message',
      message: {
        message_id: message.message_id,
        mission_id: missionId,
        channel: 'handoff',
        from_agent: 'reviewer-agent',
        from_role: 'reviewer',
        to_agent: 'impl-agent',
        to_role: 'implementer',
        task_id: 'task-1',
        content: 'Review round 1 sent 2 finding(s) back to task-1 for rework.',
        created_at: message.created_at,
        acknowledged_by: [],
      },
    });
    expect(message.message_id).toMatch(/^MCB-[0-9A-F]{8}$/u);
  });

  it('writes the same row shape for the artifact review request', () => {
    const missionId = 'MSN-REC-REVIEW';
    seedMission(missionId);
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const message = recordMissionCoordinationMessage({
      mission_id: missionId,
      channel: 'review',
      from_agent: 'mission_orchestration_worker',
      to_agent: 'agent-r',
      to_role: 'reviewer',
      task_id: 'task-2',
      content: 'Artifact review requested for task task-2.',
    });
    const [row] = readRows(`${missionPath}/coordination/bus.jsonl`);
    expect(row).toEqual({
      kind: 'message',
      message: {
        message_id: message.message_id,
        mission_id: missionId,
        channel: 'review',
        from_agent: 'mission_orchestration_worker',
        to_agent: 'agent-r',
        to_role: 'reviewer',
        task_id: 'task-2',
        content: 'Artifact review requested for task task-2.',
        created_at: message.created_at,
        acknowledged_by: [],
      },
    });
  });

  it('persists under an existing confidential mission root', () => {
    const missionId = 'MSN-REC-CONFIDENTIAL';
    const missionPath = pathResolver.missionDir(missionId, 'confidential');
    withExecutionContext('mission_controller', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
      safeMkdir(missionPath, { recursive: true });
    });
    seedMission(missionId, 'confidential');
    try {
      recordMissionCoordinationMessage({
        mission_id: missionId,
        channel: 'handoff',
        from_agent: 'planner',
        content: 'Confidential message.',
      });
      expect(safeExistsSync(`${missionPath}/coordination/bus.jsonl`)).toBe(true);
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });

  it('fails closed for an unknown mission', () => {
    expect(() =>
      recordMissionCoordinationMessage({
        mission_id: 'MSN-REC-DOES-NOT-EXIST',
        channel: 'handoff',
        from_agent: 'planner',
        content: 'x',
      })
    ).toThrow();
  });

  it('rotates archived segments', () => {
    const missionId = 'MSN-REC-ROTATE';
    const missionPath = `${pathResolver.missionDir(missionId, 'public')}/coordination`;
    seedMission(missionId);
    const options = { maxLinesPerFile: 1, maxArchiveCount: 2 };
    for (const n of [1, 2, 3]) {
      recordMissionCoordinationMessage(
        { mission_id: missionId, channel: 'handoff', from_agent: 'planner', content: `m${n}` },
        options
      );
    }
    expect(safeExistsSync(`${missionPath}/bus.jsonl`)).toBe(true);
    expect(safeExistsSync(`${missionPath}/bus.jsonl.1`)).toBe(true);
    expect(safeExistsSync(`${missionPath}/bus.jsonl.2`)).toBe(true);
  });

  it('rejects a symlinked coordination directory', () => {
    const missionId = 'MSN-REC-SYMLINK';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const coordinationPath = `${missionPath}/coordination`;
    const externalPath = pathResolver.sharedTmp('coordination-record-external');
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionPath, { recursive: true });
      safeMkdir(externalPath, { recursive: true });
      safeRmSync(coordinationPath, { recursive: true, force: true });
      safeSymlinkSync(externalPath, coordinationPath, 'dir');
    });
    seedMission(missionId);
    try {
      expect(() =>
        recordMissionCoordinationMessage({
          mission_id: missionId,
          channel: 'handoff',
          from_agent: 'planner',
          content: 'x',
        })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(coordinationPath, { recursive: true, force: true });
        safeRmSync(missionPath, { recursive: true, force: true });
        safeRmSync(externalPath, { recursive: true, force: true });
      });
    }
  });

  it('fails closed when the current stream is replaced by a directory', () => {
    const missionId = 'MSN-REC-DIRECTORY';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    withExecutionContext('mission_controller', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
      safeMkdir(`${missionPath}/coordination/bus.jsonl`, { recursive: true });
    });
    seedMission(missionId);
    try {
      expect(() =>
        recordMissionCoordinationMessage({
          mission_id: missionId,
          channel: 'handoff',
          from_agent: 'planner',
          content: 'x',
        })
      ).toThrow('stream must be a regular file');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });
});
