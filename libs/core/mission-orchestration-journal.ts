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
import { eventScopeMatches, type EventScope } from './event-scope.js';

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
  scope?: EventScope;
}

export interface MissionOrchestrationReplayPlan {
  last_completed_event_id?: string;
  next_event?: MissionOrchestrationEvent | null;
  pending_event_ids: string[];
  replay_count: number;
}

function missionPathForScope(missionId: string, scope?: EventScope): string {
  if (scope?.tenant_slug) {
    return pathResolver.tenantMissionDir(missionId, scope.tenant_slug, scope.tier);
  }
  return (
    pathResolver.findMissionPath(missionId) ||
    pathResolver.missionDir(missionId, scope?.tier || 'public')
  );
}

function journalDir(missionId: string, scope?: EventScope): string {
  return `${missionPathForScope(missionId, scope)}/coordination`;
}

function journalPath(missionId: string, scope?: EventScope): string {
  return `${journalDir(missionId, scope)}/orchestration-journal.jsonl`;
}

function eventDir(): string {
  return pathResolver.shared(`coordination/orchestration/events`);
}

function ensureJournalDir(missionId: string, scope?: EventScope): void {
  safeMkdir(journalDir(missionId, scope));
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
  scope?: EventScope;
  missionPathHint?: string;
}): MissionOrchestrationJournalEntry {
  const scope = input.scope;
  const journalMissionPath = input.missionPathHint || missionPathForScope(input.missionId, scope);
  ensureJournalDir(input.missionId, scope);
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
    ...(scope ? { scope } : {}),
  };
  safeAppendFileSync(
    `${journalMissionPath}/coordination/orchestration-journal.jsonl`,
    `${JSON.stringify(entry)}\n`
  );
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
  scope?: EventScope;
  missionPathHint?: string;
}): MissionOrchestrationJournalEntry {
  return appendMissionOrchestrationJournalEntry(input);
}

export function loadMissionOrchestrationJournal(
  missionId: string,
  scope?: EventScope
): MissionOrchestrationJournalEntry[] {
  const filePath = journalPath(missionId, scope);
  if (!safeExistsSync(filePath)) return [];
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MissionOrchestrationJournalEntry);
}

export function loadMissionOrchestrationReplayPlan(
  missionId: string,
  scope?: EventScope
): MissionOrchestrationReplayPlan {
  const eventsDirectory = eventDir();
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
      if (
        event.mission_id === missionId.toUpperCase() &&
        (!scope || (event.scope && eventScopeMatches(event.scope, scope)))
      ) {
        events.push(event);
      }
    } catch {
      // Ignore unreadable legacy artifacts.
    }
  }
  events.sort((left, right) => left.created_at.localeCompare(right.created_at));

  const journalEntries = loadMissionOrchestrationJournal(missionId, scope);
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
