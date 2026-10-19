import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import {
  safeCreateExclusiveFileSync,
  safePublishExclusiveFileSync,
  safeReadFileSnapshot,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeStat,
} from '../secure-io.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { nowIso } from '../foundation/time.js';
import type {
  DiscussionCommand,
  DiscussionConfig,
  DiscussionEvent,
  DiscussionEventBody,
  DiscussionRoomState,
  DiscussionRequestBinding,
  DiscussionRoomSummary,
  DiscussionScope,
} from './discussion-types.js';
import { DEFAULT_DISCUSSION_CONFIG } from './discussion-types.js';
import { reduceDiscussionRoom, summarizeDiscussionRoom } from './discussion-reducer.js';

/**
 * An expected, user-correctable failure (nothing to review yet, a comment is
 * missing, the approval is still pending). Its message is safe to show to the
 * person who triggered it, unlike an unexpected error, which surfaces masked.
 */
export class DiscussionUserError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DiscussionUserError';
  }
}

const ROOM_ID_PATTERN = /^[A-Za-z0-9._-]{1,96}$/;
const MAX_EVENTS_PER_ROOM = 5000;
const ROOM_SNAPSHOT_CACHE_LIMIT = 64;
const roomSnapshotCache = new Map<string, { stamp: string; room: DiscussionRoomState | null }>();

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

/**
 * Permanent, create-only provider ownership. Never reclaimed automatically:
 * a missing/torn event receipt cannot authorize repeating a charged call.
 * The exclusive primitive fsyncs the file; this is not a claim about full
 * machine/filesystem crash durability of the separate append-only event log.
 */
export function claimDiscussionProviderExecution(roomId: string): void {
  const claimPath = path.join(path.dirname(eventsPath(roomId)), 'provider-execution.claim');
  safeCreateExclusiveFileSync(
    claimPath,
    'Discussion provider execution reserved; create a new room to run again.\n'
  );
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
  const id = sanitizeDiscussionId(roomId);
  const filePath = eventsPath(id);
  if (safeExistsSync(filePath)) {
    const lstat = safeLstat(filePath);
    if (lstat.isSymbolicLink() || !lstat.isFile()) {
      roomSnapshotCache.delete(filePath);
      throw new Error('Discussion event log must be a regular, non-symlink file');
    }
    const stat = safeStat(filePath);
    const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const cached = roomSnapshotCache.get(filePath);
    if (cached?.stamp === stamp) {
      roomSnapshotCache.delete(filePath);
      roomSnapshotCache.set(filePath, cached);
      return cached.room;
    }
    const events = readDiscussionEvents(id);
    const room = events.length === 0 ? null : reduceDiscussionRoom(id, events);
    roomSnapshotCache.set(filePath, { stamp, room });
    while (roomSnapshotCache.size > ROOM_SNAPSHOT_CACHE_LIMIT) {
      const oldest = roomSnapshotCache.keys().next().value;
      if (!oldest) break;
      roomSnapshotCache.delete(oldest);
    }
    return room;
  }
  roomSnapshotCache.delete(filePath);
  const events = readDiscussionEvents(id);
  if (events.length === 0) return null;
  return reduceDiscussionRoom(id, events);
}

export interface ListDiscussionRoomsOptions {
  /** Case-insensitive text search over the title, goal and message text. */
  query?: string;
  archived?: boolean;
  mode?: 'panel' | 'dialogue';
}

export function listDiscussionRooms(
  options: ListDiscussionRoomsOptions = {}
): DiscussionRoomSummary[] {
  const dir = roomsDir();
  if (!safeExistsSync(dir)) return [];
  const summaries: DiscussionRoomSummary[] = [];
  for (const name of safeReaddir(dir)) {
    if (!ROOM_ID_PATTERN.test(name)) continue;
    const room = readDiscussionRoom(name);
    if (!room) continue;
    if (options.archived !== undefined && room.archived !== options.archived) continue;
    if (options.mode && room.config.mode !== options.mode) continue;
    const needle = options.query?.trim().toLowerCase();
    if (needle) {
      const haystack = [room.title, room.goal, ...room.messages.map((m) => m.text)]
        .join('\n')
        .toLowerCase();
      if (!haystack.includes(needle)) continue;
    }
    summaries.push(summarizeDiscussionRoom(room));
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

/** Normalize at the core boundary, so callers cannot widen provider budgets through another surface. */
export function normalizeDiscussionConfig(input: Partial<DiscussionConfig> = {}): DiscussionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new DiscussionUserError('Invalid discussion config');
  // Only effective known fields participate; undefined means the default.
  const config: DiscussionConfig = {
    max_rounds: input.max_rounds ?? DEFAULT_DISCUSSION_CONFIG.max_rounds,
    max_messages: input.max_messages ?? DEFAULT_DISCUSSION_CONFIG.max_messages,
    consensus_threshold: input.consensus_threshold ?? DEFAULT_DISCUSSION_CONFIG.consensus_threshold,
    turn_delay_ms: input.turn_delay_ms ?? DEFAULT_DISCUSSION_CONFIG.turn_delay_ms,
    locale: input.locale ?? DEFAULT_DISCUSSION_CONFIG.locale,
    speaker: input.speaker ?? DEFAULT_DISCUSSION_CONFIG.speaker,
    mode: input.mode ?? DEFAULT_DISCUSSION_CONFIG.mode,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    max_provider_calls: input.max_provider_calls,
    provider_timeout_ms: input.provider_timeout_ms,
    single_pass: input.single_pass ?? false,
  };
  if (!['ja', 'en'].includes(config.locale))
    throw new DiscussionUserError('Invalid discussion locale');
  if (
    typeof config.consensus_threshold !== 'number' ||
    !Number.isFinite(config.consensus_threshold) ||
    config.consensus_threshold < 0 ||
    config.consensus_threshold > 1
  )
    throw new DiscussionUserError('Invalid discussion consensus_threshold');
  const integer = (value: unknown, fallback: number, min: number, max: number, name: string) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
      throw new DiscussionUserError('Invalid discussion ' + name);
    }
    return Math.min(value, max);
  };
  if (!['scripted', 'reasoning', 'auto'].includes(config.speaker))
    throw new DiscussionUserError('Invalid discussion speaker');
  if (!['panel', 'dialogue'].includes(config.mode))
    throw new DiscussionUserError('Invalid discussion mode');
  if (config.provider !== undefined && config.provider !== 'claude' && config.provider !== 'codex')
    throw new DiscussionUserError('Invalid discussion provider');
  if (config.single_pass !== undefined && typeof config.single_pass !== 'boolean')
    throw new DiscussionUserError('Invalid discussion single_pass');
  if (config.single_pass && config.mode !== 'panel')
    throw new DiscussionUserError('Single-pass briefs require panel mode');
  config.max_rounds = integer(config.max_rounds, 4, 1, 8, 'max_rounds');
  config.max_messages = integer(config.max_messages, 40, 1, 100, 'max_messages');
  config.turn_delay_ms = integer(config.turn_delay_ms, 1800, 0, 10000, 'turn_delay_ms');
  const defaultCalls =
    config.speaker === 'scripted'
      ? 0
      : config.mode === 'dialogue'
        ? 32
        : Math.min(32, 3 + 6 * config.max_rounds);
  config.max_provider_calls = integer(
    config.max_provider_calls,
    defaultCalls,
    config.speaker === 'scripted' ? 0 : 1,
    32,
    'max_provider_calls'
  );
  config.provider_timeout_ms = integer(
    config.provider_timeout_ms,
    60000,
    1000,
    60000,
    'provider_timeout_ms'
  );
  if (config.single_pass) {
    config.max_rounds = 1;
    config.max_provider_calls = config.speaker === 'scripted' ? 0 : 1;
  }
  return config;
}

export function createDiscussionRoom(input: CreateDiscussionRoomInput): DiscussionRoomState {
  const goal = input.goal.trim();
  if (!goal) throw new DiscussionUserError('A discussion goal is required');
  if (goal.length > 2000) throw new DiscussionUserError('Discussion goal is too long');
  const id = sanitizeDiscussionId(input.id ?? `disc-${randomUUID().slice(0, 12)}`);
  if (readDiscussionEvents(id).length > 0)
    throw new DiscussionUserError(`Discussion room already exists: ${id}`);
  const config = normalizeDiscussionConfig(input.config);
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

/**
 * Request-only creation: publish the complete initial event exclusively. Unlike
 * the legacy append path, this cannot replace an existing/torn room event log.
 * The request store owns reservation and launch decisions.
 */
export function createReservedDiscussionRoom(
  input: CreateDiscussionRoomInput & { id: string },
  request_binding: DiscussionRequestBinding
): void {
  const goal = input.goal.trim();
  if (!goal || goal.length > 2000) throw new DiscussionUserError('Invalid discussion goal');
  const event: DiscussionEvent = {
    type: 'room_created',
    seq: 1,
    ts: nowIso(),
    goal,
    title: (input.title?.trim() || goal).slice(0, 120),
    scope: input.scope ?? {},
    config: normalizeDiscussionConfig(input.config),
    created_by: input.created_by ?? 'operator',
    request_binding,
  };
  safePublishExclusiveFileSync(eventsPath(input.id), JSON.stringify(event) + '\n');
}

/**
 * Fail-closed creation evidence, independent of the mutable room projection.
 * Missing is distinct from empty/torn/malformed logs. The snapshot reader pins
 * a regular non-symlink inode; an event log is bounded before JSON parsing.
 */
export function readDiscussionRequestRoom(roomId: string): {
  created: Extract<DiscussionEvent, { type: 'room_created' }>;
  room: DiscussionRoomState;
} | null {
  let bytes: Buffer;
  try {
    const file = eventsPath(roomId);
    const stat = safeLstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024)
      throw new Error('Invalid discussion request event log file');
    bytes = safeReadFileSnapshot(file, 8 * 1024 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // A surviving directory may contain a prior provider claim or interrupted
    // publication. Absence of events alone cannot prove this is a new room.
    try {
      safeLstat(path.dirname(eventsPath(roomId)));
    } catch (directoryError) {
      if ((directoryError as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw directoryError;
    }
    throw new Error('Discussion room directory exists without creation evidence');
  }
  const lines = bytes.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  if (!lines.length || lines.length > MAX_EVENTS_PER_ROOM)
    throw new Error('Invalid discussion request event log');
  const events = lines.map((line, index) => {
    const event = JSON.parse(line) as DiscussionEvent;
    if (
      !event ||
      typeof event !== 'object' ||
      event.seq !== index + 1 ||
      typeof event.type !== 'string' ||
      typeof event.ts !== 'string' ||
      !Number.isFinite(Date.parse(event.ts))
    )
      throw new Error('Invalid discussion request event');
    return event;
  });
  const created = events[0];
  if (
    created?.type !== 'room_created' ||
    events.filter((event) => event.type === 'room_created').length !== 1
  )
    throw new Error('Discussion request requires one original creation event');
  return { created, room: reduceDiscussionRoom(sanitizeDiscussionId(roomId), events) };
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
