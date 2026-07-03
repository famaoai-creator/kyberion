import * as crypto from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
} from './secure-io.js';
import {
  loadMissionOrchestrationEvent,
  type MissionOrchestrationEvent,
  type MissionOrchestrationEventType,
} from './mission-orchestration-events.js';

export type MissionOrchestrationJournalStatus = 'enqueued' | 'completed' | 'failed';

export interface MissionOrchestrationJournalEntry {
  ts: string;
  event_id: string;
  event_type: MissionOrchestrationEventType;
  mission_id: string;
  status: MissionOrchestrationJournalStatus;
  payload_hash: string;
  requested_by?: string;
  causation_id?: string;
  correlation_id?: string;
}

export interface MissionOrchestrationReplayPlan {
  last_completed_event_id?: string;
  next_event?: MissionOrchestrationEvent | null;
  pending_event_ids: string[];
  replay_count: number;
}

function journalDir(missionId: string): string {
  return `${pathResolver.missionDir(missionId, 'public')}/coordination`;
}

function journalPath(missionId: string): string {
  return `${journalDir(missionId)}/orchestration-journal.jsonl`;
}

function eventDir(missionId: string): string {
  return pathResolver.shared(`coordination/orchestration/events`);
}

function ensureJournalDir(missionId: string): void {
  safeMkdir(journalDir(missionId));
}

function payloadHash(payload: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex');
}

export function appendMissionOrchestrationJournalEntry(input: {
  missionId: string;
  eventId: string;
  eventType: MissionOrchestrationEventType;
  status: MissionOrchestrationJournalStatus;
  payload: unknown;
  requestedBy?: string;
  causationId?: string;
  correlationId?: string;
}): MissionOrchestrationJournalEntry {
  ensureJournalDir(input.missionId);
  const entry: MissionOrchestrationJournalEntry = {
    ts: new Date().toISOString(),
    event_id: input.eventId,
    event_type: input.eventType,
    mission_id: input.missionId.toUpperCase(),
    status: input.status,
    payload_hash: payloadHash(input.payload),
    ...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
    ...(input.causationId ? { causation_id: input.causationId } : {}),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
  };
  safeAppendFileSync(journalPath(input.missionId), `${JSON.stringify(entry)}\n`);
  return entry;
}

export function appendMissionOrchestrationJournalStatus(input: {
  missionId: string;
  eventId: string;
  eventType: MissionOrchestrationEventType;
  status: MissionOrchestrationJournalStatus;
  payload: unknown;
  requestedBy?: string;
  causationId?: string;
  correlationId?: string;
}): MissionOrchestrationJournalEntry {
  return appendMissionOrchestrationJournalEntry(input);
}

export function loadMissionOrchestrationJournal(
  missionId: string
): MissionOrchestrationJournalEntry[] {
  const filePath = journalPath(missionId);
  if (!safeExistsSync(filePath)) return [];
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MissionOrchestrationJournalEntry);
}

export function loadMissionOrchestrationReplayPlan(
  missionId: string
): MissionOrchestrationReplayPlan {
  const eventsDirectory = eventDir(missionId);
  const eventFiles = safeExistsSync(eventsDirectory)
    ? safeReaddir(eventsDirectory)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  const events: MissionOrchestrationEvent[] = [];
  for (const fileName of eventFiles) {
    const eventPath = `${eventsDirectory}/${fileName}`;
    try {
      const event = loadMissionOrchestrationEvent(eventPath);
      if (event.mission_id === missionId.toUpperCase()) events.push(event);
    } catch {
      // Ignore unreadable legacy artifacts.
    }
  }
  events.sort((left, right) => left.created_at.localeCompare(right.created_at));

  const journalEntries = loadMissionOrchestrationJournal(missionId);
  const latestStatusByEvent = new Map<string, MissionOrchestrationJournalEntry>();
  for (const entry of journalEntries) {
    latestStatusByEvent.set(entry.event_id, entry);
  }

  let lastCompletedIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const status = latestStatusByEvent.get(events[index].event_id)?.status;
    if (status === 'completed') {
      lastCompletedIndex = index;
    }
  }

  const pendingEvents = events.slice(lastCompletedIndex + 1).filter((event) => {
    const status = latestStatusByEvent.get(event.event_id)?.status;
    return status !== 'completed';
  });

  return {
    last_completed_event_id:
      lastCompletedIndex >= 0 ? events[lastCompletedIndex].event_id : undefined,
    next_event: pendingEvents[0] || null,
    pending_event_ids: pendingEvents.map((event) => event.event_id),
    replay_count: pendingEvents.length,
  };
}
