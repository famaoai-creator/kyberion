'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  DiscussionCommand,
  DiscussionRoomState,
  DiscussionRoomSummary,
} from '@agent/core/discussion/discussion-types';
import copy from './discussion-copy.json';

export type { DiscussionCommand, DiscussionRoomState, DiscussionRoomSummary };

export type DiscussionLocale = 'ja' | 'en';
type Localized = { ja: string; en: string };

export const ROLE_LABELS: Record<string, Localized> = copy.role_labels;

export function roleLabel(role: string, locale: DiscussionLocale): string {
  return ROLE_LABELS[role]?.[locale] ?? role;
}

const STRINGS = copy.strings;

export type DiscussionStringKey = keyof typeof copy.strings;

export function dt(key: DiscussionStringKey, locale: DiscussionLocale): string {
  return STRINGS[key][locale];
}

export const STATUS_LABELS: Record<string, Localized> = copy.status_labels;

export const PHASE_STEPS: Array<{ id: string } & Localized> = copy.phase_steps;

export const DISCUSSION_EXAMPLES: Record<DiscussionLocale, string[]> = copy.examples;

export interface DiscussionApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
}

async function call<T>(url: string, init?: RequestInit): Promise<DiscussionApiResult<T>> {
  try {
    const response = await fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
    const body = (await response.json().catch(() => null)) as
      (T & { ok?: boolean; error?: string }) | null;
    if (!response.ok || body?.ok === false) {
      return {
        ok: false,
        status: response.status,
        data: null,
        error: body?.error ?? response.statusText,
      };
    }
    return { ok: true, status: response.status, data: body as T };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function fetchDiscussionRooms(
  options: { q?: string; archived?: boolean; mode?: 'panel' | 'dialogue' } = {}
) {
  const params = new URLSearchParams();
  if (options.q) params.set('q', options.q);
  if (options.archived) params.set('archived', '1');
  if (options.mode) params.set('mode', options.mode);
  const query = params.toString();
  return call<{ rooms: DiscussionRoomSummary[]; accessRole?: string }>(
    `/api/discussions${query ? `?${query}` : ''}`
  );
}

export function createDiscussion(body: {
  goal: string;
  locale: DiscussionLocale;
  speaker: 'auto' | 'scripted' | 'reasoning';
  turn_delay_ms: number;
  tenant?: string;
  mission_id?: string;
  mode?: 'panel' | 'dialogue';
}) {
  return call<{ room: DiscussionRoomState }>('/api/discussions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export interface MissionOption {
  missionId: string;
  title: string;
  status: string;
}

/** Missions the viewer can already see — a room may only link to one of these. */
export async function fetchMissionOptions(): Promise<MissionOption[]> {
  const result = await call<{
    missions: Array<{
      missionId: string;
      goalSummary?: string;
      intentText?: string;
      status: string;
    }>;
  }>('/api/missions/search?limit=30');
  if (!result.ok || !result.data) return [];
  return result.data.missions.map((m) => ({
    missionId: m.missionId,
    title: m.goalSummary || m.intentText || m.missionId,
    status: m.status,
  }));
}

export interface ReviewPayload {
  verdict: 'accept' | 'request-changes' | 'reject';
  note?: string;
  edits?: Array<{
    id: string;
    title?: string;
    priority?: string;
    owner_role?: string | null;
    included?: boolean;
  }>;
  request_mission?: boolean;
}

export function reviewDiscussionDecision(roomId: string, payload: ReviewPayload) {
  return call<{
    room: DiscussionRoomState;
    result: { mission_error?: string; mission_approval_id?: string };
  }>(`/api/discussions/${encodeURIComponent(roomId)}/review`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function issueDiscussionMission(roomId: string) {
  return call<{ result: { mission_id: string }; room: DiscussionRoomState }>(
    `/api/discussions/${encodeURIComponent(roomId)}/mission`,
    { method: 'POST', body: JSON.stringify({ action: 'issue' }) }
  );
}

export function createDiscussionWorkItems(roomId: string, proposalIds: string[]) {
  return call<{
    created: Array<{ proposal_id: string; item_id: string }>;
    skipped: string[];
    room: DiscussionRoomState;
  }>(`/api/discussions/${encodeURIComponent(roomId)}/outcomes`, {
    method: 'POST',
    body: JSON.stringify({ action: 'create_workitems', proposal_ids: proposalIds }),
  });
}

export function sendDiscussionCommand(roomId: string, command: DiscussionCommand) {
  return call<{ room: DiscussionRoomState }>(
    `/api/discussions/${encodeURIComponent(roomId)}/command`,
    {
      method: 'POST',
      body: JSON.stringify(command),
    }
  );
}

const TERMINAL = new Set(['concluded', 'stopped', 'failed']);

export type StreamConnection = 'connecting' | 'live' | 'ended' | 'error';

/** Live room state over SSE, with a polling fallback if the stream drops. */
export function useDiscussionStream(roomId: string | null) {
  const [room, setRoom] = useState<DiscussionRoomState | null>(null);
  const [connection, setConnection] = useState<StreamConnection>('connecting');
  const [error, setError] = useState<string | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    setRoom(null);
    setError(null);
    failures.current = 0;
    if (!roomId) return;
    setConnection('connecting');
    let closed = false;
    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;

    const apply = (next: DiscussionRoomState) => {
      setRoom(next);
      setConnection(TERMINAL.has(next.status) ? 'ended' : 'live');
    };

    const startPolling = () => {
      if (closed || pollTimer) return;
      pollTimer = setInterval(async () => {
        const result = await fetchRoom(roomId);
        if (closed) return;
        if (result.ok && result.data) {
          apply(result.data.room);
          if (TERMINAL.has(result.data.room.status) && pollTimer) clearInterval(pollTimer);
        } else if (result.status === 403 || result.status === 404) {
          setError(result.error ?? 'not available');
          if (pollTimer) clearInterval(pollTimer);
        }
      }, 1500);
    };

    if (typeof EventSource === 'undefined') {
      startPolling();
    } else {
      source = new EventSource(`/api/discussions/${encodeURIComponent(roomId)}/stream`);
      source.addEventListener('state', (event) => {
        try {
          failures.current = 0;
          apply(JSON.parse((event as MessageEvent<string>).data) as DiscussionRoomState);
        } catch {
          /* ignore a torn frame; the next one carries the full state */
        }
      });
      source.addEventListener('end', () => {
        setConnection('ended');
        source?.close();
      });
      source.onerror = () => {
        failures.current += 1;
        if (failures.current >= 3) {
          source?.close();
          setConnection('error');
          startPolling();
        }
      };
    }
    return () => {
      closed = true;
      source?.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [roomId]);

  return { room, connection, error, setRoom };
}

function fetchRoom(roomId: string) {
  return call<{ room: DiscussionRoomState }>(`/api/discussions/${encodeURIComponent(roomId)}`);
}

export async function stopDiscussionReply(roomId: string) {
  return call<{ stopped: boolean }>(`/api/discussions/${encodeURIComponent(roomId)}/stop`, {
    method: 'POST',
    body: '{}',
  });
}

export function sendMessageFeedback(
  roomId: string,
  messageId: string,
  value: 'up' | 'down' | null
) {
  return call<Record<string, never>>(`/api/discussions/${encodeURIComponent(roomId)}/feedback`, {
    method: 'POST',
    body: JSON.stringify({ message_id: messageId, value }),
  });
}

export function patchDiscussionRoom(roomId: string, patch: { title?: string; archived?: boolean }) {
  return call<{ room: DiscussionRoomState }>(`/api/discussions/${encodeURIComponent(roomId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export interface UploadedAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  status: 'read' | 'stored';
}

/** Upload files; multipart, so the JSON content-type `call` sets must not be used. */
export async function uploadDiscussionAttachments(roomId: string, files: File[]) {
  try {
    const form = new FormData();
    for (const file of files) form.append('file', file);
    const response = await fetch(`/api/discussions/${encodeURIComponent(roomId)}/attachments`, {
      method: 'POST',
      body: form,
    });
    const body = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
      attachments?: UploadedAttachment[];
    } | null;
    if (!response.ok || body?.ok === false) {
      return { ok: false as const, error: body?.error ?? response.statusText };
    }
    return { ok: true as const, attachments: body?.attachments ?? [] };
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
}

export function attachmentUrl(roomId: string, attachmentId: string): string {
  return `/api/discussions/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/** The whole conversation as Markdown, for the Export button. */
export function conversationToMarkdown(
  room: DiscussionRoomState,
  locale: DiscussionLocale
): string {
  const lines = [
    `# ${room.title}`,
    '',
    `${dt('objective', locale)}: ${room.dialogue.objective || room.goal}`,
    '',
  ];
  for (const message of room.messages) {
    if (message.superseded) continue;
    const who =
      message.kind === 'human'
        ? dt('you', locale)
        : roleLabel(
            room.participants.find((p) => p.id === message.speaker)?.role ?? message.speaker,
            locale
          );
    lines.push(`**${who}** (${message.ts})`, '', message.text, '');
  }
  return lines.join('\n');
}
