import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeReaddir } from '../secure-io.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import type {
  DiscussionCommand,
  DiscussionConfig,
  DiscussionEvent,
  DiscussionEventBody,
  DiscussionRoomState,
  DiscussionRoomSummary,
  DiscussionScope,
} from './discussion-types.js';
import { DEFAULT_DISCUSSION_CONFIG } from './discussion-types.js';
import { reduceDiscussionRoom, summarizeDiscussionRoom } from './discussion-reducer.js';

const ROOM_ID_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;
const MAX_EVENTS_PER_ROOM = 5000;

export function sanitizeDiscussionId(id: string): string {
  const value = id.trim();
  if (!ROOM_ID_PATTERN.test(value)) throw new Error('Invalid discussion room id');
  return value;
}

function roomsDir(): string {
  return pathResolver.shared('runtime/discussions');
}

function eventsPath(roomId: string): string {
  const dir = path.resolve(roomsDir());
  const filePath = path.resolve(dir, sanitizeDiscussionId(roomId), 'events.jsonl');
  if (!filePath.startsWith(`${dir}${path.sep}`)) throw new Error('Invalid discussion room path');
  return filePath;
}

export function readDiscussionEvents(roomId: string, afterSeq = 0): DiscussionEvent[] {
  const filePath = eventsPath(roomId);
  const events = readJsonLines<DiscussionEvent>(filePath, {
    // A torn trailing line from a crashed writer is skipped, never fatal.
    onMalformed: 'skip',
    map: (value) => {
      const event = value as Partial<DiscussionEvent> | null;
      if (!event || typeof event.seq !== 'number' || typeof event.type !== 'string') {
        throw new Error('not a discussion event');
      }
      return event as DiscussionEvent;
    },
  });
  return events.filter((event) => event.seq > afterSeq);
}

/**
 * Append one event. Synchronous read-modify-append keeps `seq` monotonic for
 * every writer in the process (engine + API commands), which is the only
 * concurrency the room has: one owner engine, many command writers.
 */
export function appendDiscussionEvent(roomId: string, body: DiscussionEventBody): DiscussionEvent {
  const filePath = eventsPath(roomId);
  safeMkdir(path.dirname(filePath), { recursive: true });
  const existing = readDiscussionEvents(roomId);
  if (existing.length >= MAX_EVENTS_PER_ROOM) throw new Error('Discussion room event log is full');
  const seq = (existing[existing.length - 1]?.seq ?? 0) + 1;
  const event = { ...body, seq, ts: nowIso() } as DiscussionEvent;
  appendJsonLine(filePath, event);
  return event;
}

export function readDiscussionRoom(roomId: string): DiscussionRoomState | null {
  const events = readDiscussionEvents(roomId);
  if (events.length === 0) return null;
  return reduceDiscussionRoom(sanitizeDiscussionId(roomId), events);
}

export function listDiscussionRooms(): DiscussionRoomSummary[] {
  const dir = roomsDir();
  if (!safeExistsSync(dir)) return [];
  const summaries: DiscussionRoomSummary[] = [];
  for (const name of safeReaddir(dir)) {
    if (!ROOM_ID_PATTERN.test(name)) continue;
    const room = readDiscussionRoom(name);
    if (room) summaries.push(summarizeDiscussionRoom(room));
  }
  return summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

export interface CreateDiscussionRoomInput {
  goal: string;
  title?: string;
  scope?: DiscussionScope;
  config?: Partial<DiscussionConfig>;
  created_by?: string;
  id?: string;
}

export function createDiscussionRoom(input: CreateDiscussionRoomInput): DiscussionRoomState {
  const goal = input.goal.trim();
  if (!goal) throw new Error('A discussion goal is required');
  if (goal.length > 2000) throw new Error('Discussion goal is too long');
  const id = sanitizeDiscussionId(input.id ?? `disc-${randomUUID().slice(0, 12)}`);
  if (readDiscussionEvents(id).length > 0) throw new Error(`Discussion room already exists: ${id}`);
  const config: DiscussionConfig = { ...DEFAULT_DISCUSSION_CONFIG, ...input.config };
  appendDiscussionEvent(id, {
    type: 'room_created',
    goal,
    title: (input.title?.trim() || goal).slice(0, 120),
    scope: input.scope ?? {},
    config,
    created_by: input.created_by ?? 'operator',
  });
  return readDiscussionRoom(id) as DiscussionRoomState;
}

export function submitDiscussionCommand(
  roomId: string,
  actor: string,
  command: DiscussionCommand
): DiscussionEvent {
  return appendDiscussionEvent(roomId, {
    type: 'command',
    id: `cmd-${randomUUID().slice(0, 10)}`,
    actor,
    command,
  });
}
