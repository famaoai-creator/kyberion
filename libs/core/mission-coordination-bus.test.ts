import { describe, expect, it } from 'vitest';
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

    const inbox = bus.getInbox({ missionId: 'MSN-1', role: 'reviewer', unreadOnly: true, agentId: 'reviewer-a' });
    expect(inbox.map((entry) => entry.message_id)).toContain(message.message_id);

    bus.acknowledge({ messageId: message.message_id, agentId: 'reviewer-a' });
    const afterAck = bus.getInbox({ missionId: 'MSN-1', role: 'reviewer', unreadOnly: true, agentId: 'reviewer-a' });
    expect(afterAck).toHaveLength(0);
  });
});
