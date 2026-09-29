import {
  appendDiscussionEvent,
  DiscussionUserError,
  readDiscussionRoom,
} from './discussion-store.js';
import { requestGenerationStop } from './discussion-live.js';

/** Thumbs up / down on a facilitator or teammate message; `null` clears it. */
export function recordMessageFeedback(
  roomId: string,
  actor: string,
  messageId: string,
  value: 'up' | 'down' | null
): void {
  const room = readDiscussionRoom(roomId);
  if (!room) throw new DiscussionUserError('discussion not found');
  const message = room.messages.find((m) => m.id === messageId);
  if (!message || message.kind !== 'agent') {
    throw new DiscussionUserError('Feedback can only be given on an assistant message');
  }
  appendDiscussionEvent(roomId, { type: 'message_feedback', id: messageId, value, actor });
}

export function renameDiscussionRoom(roomId: string, actor: string, title: string): void {
  const clean = title.trim().slice(0, 120);
  if (!clean) throw new DiscussionUserError('A title is required');
  if (!readDiscussionRoom(roomId)) throw new DiscussionUserError('discussion not found');
  appendDiscussionEvent(roomId, { type: 'room_renamed', title: clean, actor });
}

export function archiveDiscussionRoom(roomId: string, actor: string, archived: boolean): void {
  if (!readDiscussionRoom(roomId)) throw new DiscussionUserError('discussion not found');
  appendDiscussionEvent(roomId, { type: 'room_archived', archived, actor });
}

/** Stop the reply being generated right now (the person pressed Stop). */
export function stopDiscussionGeneration(roomId: string): boolean {
  return requestGenerationStop(roomId);
}
