import { randomUUID } from 'node:crypto';

export type MissionCoordinationChannel =
  | 'task_contract'
  | 'handoff'
  | 'review'
  | 'runtime_notice';

export interface MissionCoordinationMessage {
  message_id: string;
  mission_id: string;
  channel: MissionCoordinationChannel;
  from_agent: string;
  from_role?: string;
  to_agent?: string;
  to_role?: string;
  correlation_id?: string;
  task_id?: string;
  content: string;
  created_at: string;
  acknowledged_by: string[];
}

function isAddressedTo(message: MissionCoordinationMessage, input: { agentId?: string; role?: string }): boolean {
  const targetsAgent = message.to_agent ? message.to_agent === input.agentId : true;
  const targetsRole = message.to_role ? message.to_role === input.role : true;
  return targetsAgent && targetsRole;
}

export class MissionCoordinationBus {
  private readonly messages: MissionCoordinationMessage[] = [];

  send(input: {
    mission_id: string;
    channel: MissionCoordinationChannel;
    from_agent: string;
    from_role?: string;
    to_agent?: string;
    to_role?: string;
    correlation_id?: string;
    task_id?: string;
    content: string;
  }): MissionCoordinationMessage {
    const message: MissionCoordinationMessage = {
      message_id: `MCB-${randomUUID().slice(0, 8).toUpperCase()}`,
      mission_id: input.mission_id.toUpperCase(),
      channel: input.channel,
      from_agent: input.from_agent,
      from_role: input.from_role,
      to_agent: input.to_agent,
      to_role: input.to_role,
      correlation_id: input.correlation_id,
      task_id: input.task_id,
      content: input.content,
      created_at: new Date().toISOString(),
      acknowledged_by: [],
    };
    this.messages.push(message);
    return message;
  }

  getInbox(input: { missionId: string; agentId?: string; role?: string; unreadOnly?: boolean }): MissionCoordinationMessage[] {
    return this.messages.filter((message) => {
      if (message.mission_id !== input.missionId.toUpperCase()) return false;
      if (!isAddressedTo(message, { agentId: input.agentId, role: input.role })) return false;
      if (input.unreadOnly && input.agentId && message.acknowledged_by.includes(input.agentId)) return false;
      return true;
    });
  }

  acknowledge(input: { messageId: string; agentId: string }): void {
    const message = this.messages.find((entry) => entry.message_id === input.messageId);
    if (!message) return;
    if (!message.acknowledged_by.includes(input.agentId)) {
      message.acknowledged_by.push(input.agentId);
    }
  }

  listMissionMessages(missionId: string): MissionCoordinationMessage[] {
    return this.messages.filter((message) => message.mission_id === missionId.toUpperCase());
  }
}
