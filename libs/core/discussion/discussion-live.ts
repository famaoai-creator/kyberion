import type { DiscussionRoomState } from './discussion-types.js';

/**
 * Ephemeral state of a reply that is being generated. Partial text is shown to
 * viewers as it streams but is never persisted: only the finished reply becomes
 * an event, so the event log stays an honest record and never fills with deltas.
 * One engine owns a room in one process, so a process-local registry is enough.
 */
interface LiveEntry {
  speaker: string;
  text: string;
  stop: boolean;
}

type LiveRegistry = Map<string, LiveEntry>;
const KEY = '__kyberionDiscussionLive';

function registry(): LiveRegistry {
  const holder = globalThis as unknown as Record<string, LiveRegistry | undefined>;
  return (holder[KEY] ??= new Map());
}

export function beginLiveReply(roomId: string, speaker: string): void {
  registry().set(roomId, { speaker, text: '', stop: false });
}

export function updateLiveReply(roomId: string, text: string): void {
  const entry = registry().get(roomId);
  if (entry) entry.text = text;
}

export function endLiveReply(roomId: string): void {
  registry().delete(roomId);
}

export function getLiveReply(roomId: string): { speaker: string; text: string } | null {
  const entry = registry().get(roomId);
  return entry ? { speaker: entry.speaker, text: entry.text } : null;
}

/** Ask the running engine to abandon the reply it is generating. Returns whether one was live. */
export function requestGenerationStop(roomId: string): boolean {
  const entry = registry().get(roomId);
  if (!entry) return false;
  entry.stop = true;
  return true;
}

export function generationStopRequested(roomId: string): boolean {
  return registry().get(roomId)?.stop === true;
}

/** The room as it should be served: with the reply currently streaming, if any. */
export function withLiveReply(room: DiscussionRoomState): DiscussionRoomState {
  const live = getLiveReply(room.id);
  return live ? { ...room, live } : { ...room, live: null };
}
