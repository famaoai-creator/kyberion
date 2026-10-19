'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  DiscussionCommand,
  DiscussionRoomState,
  DiscussionRoomSummary,
} from '@agent/core/discussion/discussion-types';
import copy from './discussion-copy.json';
import type { ReadinessProvider } from './discussion-readiness-state';
import type {
  DiscussionCreateHandle,
  DiscussionRequestRouting,
} from './discussion-create-recovery';

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

/** A deadline covers fetch AND body parsing; abort is not backend cancellation. */
async function call<T>(
  url: string,
  init?: RequestInit,
  timeoutMs?: number
): Promise<DiscussionApiResult<T>> {
  const abort = timeoutMs === undefined ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  const unavailable = (): DiscussionApiResult<T> => ({
    ok: false,
    status: 0,
    data: null,
    error: 'Response not confirmed',
  });
  const request = async (): Promise<DiscussionApiResult<T>> => {
    try {
      const response = await fetch(url, {
        ...init,
        signal: abort?.signal ?? init?.signal,
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
      if (abort) return unavailable();
      return { ...unavailable(), error: error instanceof Error ? error.message : String(error) };
    }
  };
  if (!abort) return request();
  const interrupted = new Promise<DiscussionApiResult<T>>((resolve) => {
    cancel = () => {
      abort.abort();
      resolve(unavailable());
    };
    timer = setTimeout(cancel, timeoutMs);
    init?.signal?.addEventListener('abort', cancel, { once: true });
  });
  try {
    if (init?.signal?.aborted) {
      cancel?.();
      return unavailable();
    }
    return await Promise.race([request(), interrupted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (cancel) init?.signal?.removeEventListener('abort', cancel);
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

/** No goal or source text is transmitted by this metadata-only check. */
export function fetchDiscussionReadiness(
  provider: ReadinessProvider,
  missionId: string,
  signal?: AbortSignal
) {
  const params = new URLSearchParams({ provider });
  if (missionId) params.set('mission_id', missionId);
  return call<{ readiness?: unknown }>(`/api/discussions/readiness?${params.toString()}`, {
    signal,
  });
}

export interface DiscussionCreateInput {
  goal: string;
  locale: DiscussionLocale;
  speaker: 'auto' | 'scripted' | 'reasoning';
  provider?: 'claude' | 'codex';
  single_pass?: boolean;
  max_rounds?: number;
  max_provider_calls?: number;
  provider_timeout_ms?: number;
  turn_delay_ms: number;
  tenant?: string;
  scope_digest?: string;
  organization_id?: string;
  project_id?: string;
  mission_id?: string;
  mode?: 'panel' | 'dialogue';
}

export const DISCUSSION_REQUEST_TIMEOUT_MS = 15_000;

export function createDiscussion(
  body: DiscussionCreateInput & { request_id: string },
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
) {
  return call<unknown>(
    '/api/discussions',
    {
      method: 'POST',
      body: JSON.stringify(body),
      signal: options.signal,
    },
    options.timeoutMs ?? DISCUSSION_REQUEST_TIMEOUT_MS
  );
}

/** Resolve canonical routing before persisting a marker or transmitting the goal. */
export function fetchDiscussionRequestContext(
  routing: DiscussionRequestRouting,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
) {
  const params = new URLSearchParams();
  for (const key of ['tenant', 'organization_id', 'project_id', 'mission_id'] as const) {
    if (routing[key]) params.set(key, routing[key]);
  }
  const query = params.toString();
  return call<unknown>(
    `/api/discussions/request-context${query ? `?${query}` : ''}`,
    { signal: options.signal },
    options.timeoutMs ?? DISCUSSION_REQUEST_TIMEOUT_MS
  );
}

/** Read-only lookup: only the ORIGINAL routing context, never goal/source text. */
export function fetchDiscussionRequest(
  handle: DiscussionCreateHandle,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
) {
  const params = new URLSearchParams();
  for (const key of [
    'tenant',
    'organization_id',
    'project_id',
    'mission_id',
    'scope_digest',
  ] as const) {
    if (handle.routing[key]) params.set(key, handle.routing[key]);
  }
  const query = params.toString();
  return call<unknown>(
    `/api/discussions/requests/${encodeURIComponent(handle.request_id)}${query ? `?${query}` : ''}`,
    { signal: options.signal },
    options.timeoutMs ?? DISCUSSION_REQUEST_TIMEOUT_MS
  );
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
