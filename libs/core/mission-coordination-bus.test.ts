import { describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import {
  MissionCoordinationBus,
  missionCoordinationBus,
  parseMissionCoordinationEvent,
  parseMissionCoordinationMessage,
} from './mission-coordination-bus.js';

describe('mission-coordination-bus', () => {
  it('normalizes message and acknowledgement event shapes', () => {
    const message = {
      message_id: 'MCB-1',
      mission_id: 'MSN-1',
      channel: 'handoff',
      from_agent: 'planner',
      content: 'Review this.',
      created_at: '2026-09-01T00:00:00.000Z',
      acknowledged_by: [],
    };
    expect(parseMissionCoordinationMessage(message)).toEqual(message);
    expect(parseMissionCoordinationEvent({ kind: 'message', message })).toEqual(message);
    expect(
      parseMissionCoordinationEvent({
        kind: 'ack',
        message_id: 'MCB-1',
        agent_id: 'reviewer',
        created_at: '2026-09-01T00:01:00.000Z',
      })
    ).toMatchObject({ kind: 'ack', message_id: 'MCB-1' });
  });

  it('rejects malformed coordination records before reconstruction', () => {
    expect(parseMissionCoordinationMessage([])).toBeUndefined();
    expect(
      parseMissionCoordinationMessage({
        message_id: 'MCB-1',
        mission_id: 'MSN-1',
        channel: 'unknown',
        from_agent: 'planner',
        content: 'Review this.',
        created_at: '2026-09-01T00:00:00.000Z',
        acknowledged_by: [],
      })
    ).toBeUndefined();
    expect(parseMissionCoordinationEvent({ kind: 'ack', message_id: 'MCB-1' })).toBeUndefined();
  });

  it('exposes a process-wide singleton so callers share the loaded cache', () => {
    expect(missionCoordinationBus).toBeInstanceOf(MissionCoordinationBus);
  });

  it('routes direct role-targeted messages and tracks acknowledgements', () => {
    const bus = new MissionCoordinationBus();
    const message = bus.send({
      mission_id: 'MSN-1',
      channel: 'task_contract',
      from_agent: 'owner',
      from_role: 'owner',
      to_role: 'reviewer',
      content: 'Review the worker handoff.',
    });

    const inbox = bus.getInbox({
      missionId: 'MSN-1',
      role: 'reviewer',
      unreadOnly: true,
      agentId: 'reviewer-a',
    });
    expect(inbox.map((entry) => entry.message_id)).toContain(message.message_id);

    bus.acknowledge({ messageId: message.message_id, agentId: 'reviewer-a' });
    const afterAck = bus.getInbox({
      missionId: 'MSN-1',
      role: 'reviewer',
      unreadOnly: true,
      agentId: 'reviewer-a',
    });
    expect(afterAck).toHaveLength(0);
  });

  it('persists messages and acknowledgements in append-only mission JSONL', () => {
    const missionId = 'MSN-BUS-PERSIST';
    const missionPath = withExecutionContext(
      'mission_controller',
      () => `${pathResolver.missionDir(missionId, 'public')}/coordination`
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
    });

    const bus = new MissionCoordinationBus();
    const message = bus.send({
      mission_id: missionId,
      channel: 'handoff',
      from_agent: 'planner',
      from_role: 'planner',
      to_role: 'reviewer',
      correlation_id: 'corr-1',
      task_id: 'task-1',
      content: 'Review persisted state.',
    });
    bus.acknowledge({ messageId: message.message_id, agentId: 'reviewer-a' });

    const persistedPath = `${missionPath}/bus.jsonl`;
    const persisted = withExecutionContext('mission_controller', () =>
      String(safeReadFile(persistedPath, { encoding: 'utf8' }) || '')
    )
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({
      kind: 'message',
      message: expect.objectContaining({
        mission_id: missionId,
        acknowledged_by: [],
      }),
    });
    expect(persisted[1]).toMatchObject({
      kind: 'ack',
      message_id: message.message_id,
      agent_id: 'reviewer-a',
    });

    const reloaded = new MissionCoordinationBus();
    const inbox = reloaded.getInbox({
      missionId,
      role: 'reviewer',
      unreadOnly: true,
      agentId: 'reviewer-a',
    });
    expect(inbox).toHaveLength(0);
    expect(reloaded.listMissionMessages(missionId)).toHaveLength(1);
  });

  it('persists messages under an existing confidential mission root', () => {
    const missionId = 'MSN-BUS-CONFIDENTIAL';
    const missionPath = pathResolver.missionDir(missionId, 'confidential');
    withExecutionContext('mission_controller', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
      safeMkdir(missionPath, { recursive: true });
    });

    try {
      const bus = new MissionCoordinationBus();
      bus.send({
        mission_id: missionId,
        channel: 'handoff',
        from_agent: 'planner',
        from_role: 'planner',
        to_role: 'reviewer',
        content: 'Confidential message.',
      });
      expect(safeExistsSync(`${missionPath}/coordination/bus.jsonl`)).toBe(true);
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });

  it('rotates archived bus segments and reloads all segments on restart', () => {
    const missionId = 'MSN-BUS-ROTATE';
    const missionPath = withExecutionContext(
      'mission_controller',
      () => `${pathResolver.missionDir(missionId, 'public')}/coordination`
    );
    withExecutionContext('mission_controller', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
    });

    const bus = new MissionCoordinationBus({ maxLinesPerFile: 1, maxArchiveCount: 2 });
    const first = bus.send({
      mission_id: missionId,
      channel: 'handoff',
      from_agent: 'planner',
      from_role: 'planner',
      to_role: 'reviewer',
      task_id: 'task-1',
      content: 'First message.',
    });
    const second = bus.send({
      mission_id: missionId,
      channel: 'handoff',
      from_agent: 'planner',
      from_role: 'planner',
      to_role: 'reviewer',
      task_id: 'task-2',
      content: 'Second message.',
    });
    bus.acknowledge({ messageId: first.message_id, agentId: 'reviewer-a' });

    expect(safeExistsSync(`${missionPath}/bus.jsonl`)).toBe(true);
    expect(safeExistsSync(`${missionPath}/bus.jsonl.1`)).toBe(true);
    expect(safeExistsSync(`${missionPath}/bus.jsonl.2`)).toBe(true);

    const reloaded = new MissionCoordinationBus({ maxLinesPerFile: 1, maxArchiveCount: 2 });
    const messages = reloaded.listMissionMessages(missionId);
    expect(messages.map((entry) => entry.message_id)).toEqual([
      first.message_id,
      second.message_id,
    ]);
    expect(
      reloaded.getInbox({ missionId, role: 'reviewer', unreadOnly: true, agentId: 'reviewer-a' })
    ).toHaveLength(1);
  });

  it('rejects a symlinked coordination directory before bus access', () => {
    const missionId = 'MSN-BUS-SYMLINK';
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    const coordinationPath = `${missionPath}/coordination`;
    const externalPath = pathResolver.sharedTmp('coordination-bus-external');
    withExecutionContext('mission_controller', () => {
      safeMkdir(missionPath, { recursive: true });
      safeMkdir(externalPath, { recursive: true });
      safeRmSync(coordinationPath, { recursive: true, force: true });
      safeSymlinkSync(externalPath, coordinationPath, 'dir');
    });
    try {
      expect(() => new MissionCoordinationBus().listMissionMessages(missionId)).toThrow(
        '[RESOURCE_PATH_SYMLINK]'
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(coordinationPath, { recursive: true, force: true });
        safeRmSync(missionPath, { recursive: true, force: true });
        safeRmSync(externalPath, { recursive: true, force: true });
      });
    }
  });

  it('fails closed when the current bus stream is replaced by a directory', () => {
    const missionId = 'MSN-BUS-DIRECTORY';
    const missionPath = pathResolver.missionDir(missionId, 'public');
    const busPath = `${missionPath}/coordination/bus.jsonl`;
    withExecutionContext('mission_controller', () => {
      safeRmSync(missionPath, { recursive: true, force: true });
      safeMkdir(busPath, { recursive: true });
    });
    try {
      expect(() => new MissionCoordinationBus().listMissionMessages(missionId)).toThrow(
        'stream must be a regular file'
      );
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(missionPath, { recursive: true, force: true });
      });
    }
  });

  it('rejects a symlinked archived bus segment before loading history', () => {
    const missionId = 'MSN-BUS-ARCHIVE-SYMLINK';
    const missionPath = withExecutionContext('mission_controller', () =>
      pathResolver.missionDir(missionId, 'public')
    );
    const coordinationPath = `${missionPath}/coordination`;
    const externalPath = pathResolver.sharedTmp('coordination-bus-archive-external');
    const externalArchive = `${externalPath}/bus.jsonl.1`;
    withExecutionContext('mission_controller', () => {
      safeMkdir(`${missionPath}/coordination`, { recursive: true });
      safeMkdir(externalPath, { recursive: true });
      safeWriteFile(externalArchive, '{"kind":"message"}\n');
      safeSymlinkSync(externalArchive, `${coordinationPath}/bus.jsonl.1`);
    });
    try {
      expect(() =>
        new MissionCoordinationBus({ maxArchiveCount: 1 }).listMissionMessages(missionId)
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      withExecutionContext('mission_controller', () => {
        safeRmSync(coordinationPath, { recursive: true, force: true });
        safeRmSync(missionPath, { recursive: true, force: true });
        safeRmSync(externalPath, { recursive: true, force: true });
      });
    }
  });
});
