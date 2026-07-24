import { randomUUID } from 'node:crypto';
import { withExecutionContext } from './authority.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeMoveSync,
  safeReadFile,
  safeRmSync,
} from './secure-io.js';
import { missionDir } from './path-resolver.js';

export type MissionCoordinationChannel = 'task_contract' | 'handoff' | 'review' | 'runtime_notice';

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

type MissionCoordinationEvent =
  | {
      kind: 'message';
      message: MissionCoordinationMessage;
    }
  | {
      kind: 'ack';
      message_id: string;
      agent_id: string;
      created_at: string;
    };

const DEFAULT_BUS_MAX_LINES = 10_000;
const DEFAULT_BUS_ARCHIVE_COUNT = 5;

function isAddressedTo(
  message: MissionCoordinationMessage,
  input: { agentId?: string; role?: string }
): boolean {
  const targetsAgent = message.to_agent ? message.to_agent === input.agentId : true;
  const targetsRole = message.to_role ? message.to_role === input.role : true;
  return targetsAgent && targetsRole;
}

export class MissionCoordinationBus {
  private readonly maxLinesPerFile: number;
  private readonly maxArchiveCount: number;
  private readonly messagesByMission = new Map<string, Map<string, MissionCoordinationMessage>>();
  private readonly loadedMissions = new Set<string>();

  constructor(options: { maxLinesPerFile?: number; maxArchiveCount?: number } = {}) {
    this.maxLinesPerFile =
      options.maxLinesPerFile && options.maxLinesPerFile > 0
        ? Math.floor(options.maxLinesPerFile)
        : DEFAULT_BUS_MAX_LINES;
    this.maxArchiveCount =
      options.maxArchiveCount && options.maxArchiveCount > 0
        ? Math.floor(options.maxArchiveCount)
        : DEFAULT_BUS_ARCHIVE_COUNT;
  }

  private busPath(missionId: string): string {
    return `${missionDir(missionId, 'public')}/coordination/bus.jsonl`;
  }

  private busArchivePath(missionId: string, index: number): string {
    return `${this.busPath(missionId)}.${index}`;
  }

  private ensureMissionDir(missionId: string): void {
    withExecutionContext('mission_controller', () => {
      safeMkdir(`${missionDir(missionId, 'public')}/coordination`);
    });
  }

  private ensureLoaded(missionId: string): void {
    const normalizedMissionId = missionId.toUpperCase();
    if (this.loadedMissions.has(normalizedMissionId)) return;
    this.loadedMissions.add(normalizedMissionId);
    const messages = new Map<string, MissionCoordinationMessage>();
    withExecutionContext('mission_controller', () => {
      const filePaths: string[] = [];
      for (let index = this.maxArchiveCount; index >= 1; index -= 1) {
        filePaths.push(this.busArchivePath(normalizedMissionId, index));
      }
      filePaths.push(this.busPath(normalizedMissionId));
      for (const filePath of filePaths) {
        if (!safeExistsSync(filePath)) continue;
        const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
        for (const line of raw.split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as
              | MissionCoordinationEvent
              | MissionCoordinationMessage;
            if ((event as MissionCoordinationEvent).kind === 'ack') {
              const ack = event as Extract<MissionCoordinationEvent, { kind: 'ack' }>;
              const message = messages.get(ack.message_id);
              if (message && !message.acknowledged_by.includes(ack.agent_id)) {
                message.acknowledged_by.push(ack.agent_id);
              }
              continue;
            }
            const message =
              'message' in event
                ? (event as MissionCoordinationEvent & { message: MissionCoordinationMessage })
                    .message
                : (event as MissionCoordinationMessage);
            messages.set(message.message_id, {
              ...message,
              acknowledged_by: Array.isArray(message.acknowledged_by)
                ? [...message.acknowledged_by]
                : [],
            });
          } catch {
            // Ignore malformed legacy lines; the bus is append-only and should preserve subsequent records.
          }
        }
      }
    });
    this.messagesByMission.set(normalizedMissionId, messages);
  }

  private countBusLines(filePath: string): number {
    if (!safeExistsSync(filePath)) return 0;
    const raw = String(
      withExecutionContext('mission_controller', () =>
        safeReadFile(filePath, { encoding: 'utf8' })
      ) || ''
    );
    return raw.split(/\r?\n/u).filter((line) => line.trim()).length;
  }

  private rotateBusFile(missionId: string): void {
    const currentPath = this.busPath(missionId);
    if (!safeExistsSync(currentPath)) return;
    for (let index = this.maxArchiveCount; index >= 1; index -= 1) {
      const source = index === 1 ? currentPath : this.busArchivePath(missionId, index - 1);
      const destination = this.busArchivePath(missionId, index);
      if (!safeExistsSync(source)) continue;
      if (safeExistsSync(destination)) {
        safeRmSync(destination, { force: true });
      }
      safeMoveSync(source, destination);
    }
  }

  private appendEvent(missionId: string, event: MissionCoordinationEvent): void {
    withExecutionContext('mission_controller', () => {
      this.ensureMissionDir(missionId);
      if (this.countBusLines(this.busPath(missionId)) >= this.maxLinesPerFile) {
        this.rotateBusFile(missionId);
      }
      safeAppendFileSync(this.busPath(missionId), `${JSON.stringify(event)}\n`);
    });
  }

  private missionMessages(missionId: string): Map<string, MissionCoordinationMessage> {
    const normalizedMissionId = missionId.toUpperCase();
    this.ensureLoaded(normalizedMissionId);
    let messages = this.messagesByMission.get(normalizedMissionId);
    if (!messages) {
      messages = new Map<string, MissionCoordinationMessage>();
      this.messagesByMission.set(normalizedMissionId, messages);
    }
    return messages;
  }

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
    const messages = this.missionMessages(input.mission_id);
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
    messages.set(message.message_id, message);
    this.appendEvent(message.mission_id, { kind: 'message', message });
    return message;
  }

  getInbox(input: {
    missionId: string;
    agentId?: string;
    role?: string;
    unreadOnly?: boolean;
  }): MissionCoordinationMessage[] {
    const messages = Array.from(this.missionMessages(input.missionId).values());
    return messages.filter((message) => {
      if (message.mission_id !== input.missionId.toUpperCase()) return false;
      if (!isAddressedTo(message, { agentId: input.agentId, role: input.role })) return false;
      if (input.unreadOnly && input.agentId && message.acknowledged_by.includes(input.agentId))
        return false;
      return true;
    });
  }

  acknowledge(input: { messageId: string; agentId: string }): void {
    const message = Array.from(this.messagesByMission.values())
      .flatMap((missionMessages) => Array.from(missionMessages.values()))
      .find((entry) => entry.message_id === input.messageId);
    if (!message) return;
    if (!message.acknowledged_by.includes(input.agentId)) {
      message.acknowledged_by.push(input.agentId);
      this.appendEvent(message.mission_id, {
        kind: 'ack',
        message_id: input.messageId,
        agent_id: input.agentId,
        created_at: new Date().toISOString(),
      });
    }
  }

  listMissionMessages(missionId: string): MissionCoordinationMessage[] {
    return Array.from(this.missionMessages(missionId).values()).filter(
      (message) => message.mission_id === missionId.toUpperCase()
    );
  }
}

/** Process-wide bus so repeated calls within one mission reuse the loaded cache. */
export const missionCoordinationBus = new MissionCoordinationBus();
