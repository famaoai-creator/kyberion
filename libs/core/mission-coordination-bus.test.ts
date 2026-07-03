import { describe, expect, it } from 'vitest';
import { withExecutionContext } from './authority.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import { pathResolver } from './path-resolver.js';
import { MissionCoordinationBus } from './mission-coordination-bus.js';

describe('mission-coordination-bus', () => {
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
});
