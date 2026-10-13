/**
 * progress.ts — FD-05: pure payload builders for the presence studio
 * "進み具合" (progress) page — `GET /api/progress` and `GET /api/progress/:id`.
 * See `docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md`
 * §2.1 / FD-05.
 *
 * Deliberately narrow input shapes (not the full `TaskSession` /
 * `ArtifactRecord` / `DeliverableInboxEntry` types from `@agent/core`) so
 * this stays a pure, easily-fixtured function — `server.ts` maps the real,
 * already-viewer-scoped runtime records into these shapes and performs all
 * I/O (including the manifest read for `mirror_href`); this module never
 * touches the filesystem or network.
 *
 * Known gap, recorded here rather than invented (see FD-05 task notes):
 * `ArtifactRecord` (`artifact_id`, `active/shared/runtime/artifacts/*.json`)
 * and `DeliverableInboxEntry` (`entry_id`, `active/shared/inbox/entries.jsonl`)
 * are two different stores with two different id spaces — nothing in the
 * system links them except a best-effort `artifact_paths` match on
 * `ArtifactRecord.path` (done in `server.ts`). An artifact with no matching
 * inbox entry can only ever be `can_verdict: false` here — never fake a
 * verdict eligibility that doesn't exist.
 */
import { resolveSurfaceBrowserUrl } from '@agent/core/surface/surface-url';
import { estimateTaskSessionPercent } from './home.js';

export { estimateTaskSessionPercent };

/** Task sessions in these statuses are done, not "in progress" — same set
 * `home.ts` uses for its `in_progress` classification. */
const TASK_SESSION_TERMINAL_STATUSES = new Set(['completed', 'failed', 'released']);

/** Deliverable-inbox statuses that mean a verdict has already been recorded
 * (see `libs/core/deliverable-inbox.ts` `DeliverableInboxStatus`). */
const VERDICTED_INBOX_STATUSES = new Set(['accepted', 'rejected', 'changes_requested']);

export const COMPUTER_SURFACE_MIRROR_FALLBACK_PORT = 3040;

export interface ProgressHistoryEntryInput {
  when?: string;
  text: string;
}

/** A recorded task state is not proof that a worker is currently running. */
export type ProgressTaskState =
  | 'collecting_requirements'
  | 'awaiting_input'
  | 'awaiting_confirmation'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'released'
  | 'unknown';

function recordedTaskState(status: string, awaitingInput?: boolean): ProgressTaskState {
  // Terminal records win over a stale control flag, as on Work Home.
  if (status === 'completed' || status === 'failed' || status === 'released') return status;
  if (awaitingInput === true || status === 'awaiting_instruction') return 'awaiting_input';
  if (
    status === 'collecting_requirements' ||
    status === 'awaiting_confirmation' ||
    status === 'planning' ||
    status === 'executing' ||
    status === 'verifying' ||
    status === 'paused' ||
    status === 'blocked'
  )
    return status;
  return 'unknown';
}

export interface ProgressTaskSessionInput {
  id: string;
  title: string;
  status: string;
  /** Explicit runtime wait signal; never inferred from history text. */
  awaiting_user_input?: boolean;
  /** The real request correlation carried by the task session, when present. */
  correlation_id?: string;
  /** ISO timestamp of the session's last update. */
  when?: string;
  /** Chronological (oldest-first) history entries — same shape the existing
   * "Work Detail" / "Recent Progress" panel reads from `TaskSession.history`. */
  history?: ProgressHistoryEntryInput[];
}

export interface ProgressArtifactInput {
  id: string;
  title: string;
  kind: string;
  /** ISO timestamp; artifact records carry no timestamp field themselves, so
   * callers pass the matching deliverable-inbox entry's `updated_at` /
   * `created_at` when one was found (may be omitted otherwise). */
  when?: string;
  /** Set only when a matching deliverable-inbox entry was found for this
   * artifact record (see the module doc gap above). */
  inbox_status?: 'unread' | 'read' | 'accepted' | 'rejected' | 'changes_requested';
  /** The deliverable-inbox `entry_id` to call `POST /api/outcomes/:id/verdict`
   * with — only present alongside `inbox_status`. */
  entry_id?: string;
  /** Whether `GET /api/artifacts/:artifactId` can serve this artifact (same
   * check the existing outcome-inbox panel uses for its download link). */
  downloadable?: boolean;
}

export interface ProgressActiveItem {
  task_state: ProgressTaskState;
  latest_update?: ProgressHistoryEntryInput;
  id: string;
  title: string;
  now: string;
  status: string;
  correlation_id?: string;
  percent?: number;
  progress_basis?: 'phase_estimate';
  when?: string;
  selected_default?: boolean;
}

export interface ProgressDeliveredItem {
  id: string;
  title: string;
  kind: string;
  when?: string;
  status: ProgressArtifactInput['inbox_status'] | 'delivered';
  can_verdict: boolean;
  entry_id?: string;
  downloadable?: boolean;
}

export interface ProgressDoneItem {
  id: string;
  title: string;
  kind: 'task_session' | 'artifact';
  task_state?: ProgressTaskState;
  /** Preserve the concrete terminal/verdict outcome; history is not success. */
  status: string;
  correlation_id?: string;
  entry_id?: string;
  when?: string;
  downloadable?: boolean;
}

export interface ProgressPayload {
  ok: true;
  counts: { active: number; delivered: number; done: number };
  active: ProgressActiveItem[];
  delivered: ProgressDeliveredItem[];
  done: ProgressDoneItem[];
  mirror_href: string;
}

export interface BuildProgressPayloadInput {
  now: Date;
  taskSessions: ProgressTaskSessionInput[];
  artifacts: ProgressArtifactInput[];
  /** Resolved server-side via `resolveComputerSurfaceMirrorHref()` — never a
   * literal port here, this stays a pure function. */
  mirrorHref: string;
}

function toTimeMs(when: string | undefined, fallbackMs: number): number {
  if (!when) return fallbackMs;
  const parsed = Date.parse(when);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

/** Latest recorded update only; history is not evidence of current execution. */
function latestUpdate(
  history: ProgressHistoryEntryInput[] | undefined
): ProgressHistoryEntryInput | undefined {
  if (!history?.length) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const text = history[index]?.text?.trim();
    if (text) return { ...history[index], text };
  }
  return undefined;
}

/** Legacy wire field retained for other readers; the UI uses explicit provenance. */
function deriveNowText(status: string, history: ProgressHistoryEntryInput[] | undefined): string {
  return latestUpdate(history)?.text || status;
}

export function buildProgressPayload(input: BuildProgressPayloadInput): ProgressPayload {
  const nowMs = input.now.getTime();

  const activeSessions = input.taskSessions.filter(
    (session) => !TASK_SESSION_TERMINAL_STATUSES.has(session.status)
  );
  const doneSessions = input.taskSessions.filter((session) =>
    TASK_SESSION_TERMINAL_STATUSES.has(session.status)
  );

  const active: ProgressActiveItem[] = activeSessions
    .map((session) => ({
      id: session.id,
      title: session.title,
      now: deriveNowText(session.status, session.history),
      task_state: recordedTaskState(session.status, session.awaiting_user_input),
      ...(latestUpdate(session.history) ? { latest_update: latestUpdate(session.history) } : {}),
      status: session.status,
      ...(session.correlation_id ? { correlation_id: session.correlation_id } : {}),
      percent: estimateTaskSessionPercent(session.status),
      ...(estimateTaskSessionPercent(session.status) !== undefined
        ? { progress_basis: 'phase_estimate' as const }
        : {}),
      when: session.when,
    }))
    .sort((a, b) => toTimeMs(b.when, nowMs) - toTimeMs(a.when, nowMs));
  if (active.length > 0) {
    active[0] = { ...active[0], selected_default: true };
  }

  const deliveredArtifacts = input.artifacts.filter(
    (artifact) => !artifact.inbox_status || !VERDICTED_INBOX_STATUSES.has(artifact.inbox_status)
  );
  const doneArtifacts = input.artifacts.filter(
    (artifact) => artifact.inbox_status && VERDICTED_INBOX_STATUSES.has(artifact.inbox_status)
  );

  const delivered: ProgressDeliveredItem[] = deliveredArtifacts
    .map((artifact): ProgressDeliveredItem => ({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      when: artifact.when,
      status: artifact.inbox_status || 'delivered',
      can_verdict:
        Boolean(artifact.entry_id) &&
        (artifact.inbox_status === 'unread' || artifact.inbox_status === 'read'),
      ...(artifact.entry_id ? { entry_id: artifact.entry_id } : {}),
      downloadable: Boolean(artifact.downloadable),
    }))
    .sort((a, b) => toTimeMs(b.when, nowMs) - toTimeMs(a.when, nowMs));

  const done: ProgressDoneItem[] = [
    ...doneSessions.map((session) => ({
      id: session.id,
      title: session.title,
      kind: 'task_session' as const,
      task_state: recordedTaskState(session.status, session.awaiting_user_input),
      status: session.status,
      ...(session.correlation_id ? { correlation_id: session.correlation_id } : {}),
      when: session.when,
    })),
    ...doneArtifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      kind: 'artifact' as const,
      status: artifact.inbox_status!,
      ...(artifact.entry_id ? { entry_id: artifact.entry_id } : {}),
      when: artifact.when,
      downloadable: Boolean(artifact.downloadable),
    })),
  ].sort((a, b) => toTimeMs(b.when, nowMs) - toTimeMs(a.when, nowMs));

  return {
    ok: true,
    counts: { active: active.length, delivered: delivered.length, done: done.length },
    active,
    delivered,
    done,
    mirror_href: input.mirrorHref,
  };
}

export interface ProgressDetailSessionInput {
  /** Explicit source provenance; artifacts must not inherit task semantics. */
  kind?: 'task_session' | 'artifact';
  awaiting_user_input?: boolean;
  goal_summary: string;
  success_condition?: string;
  status: string;
  /** Only ever populated post-completion (`TaskSession.completion_next_action`)
   * — omitted for every other status, which is why `next` is optional on the
   * returned detail. */
  next_step?: string;
  gaps?: string[];
}

export interface ProgressDetailLogEntry {
  when?: string;
  text: string;
}

export interface ProgressDetail {
  kind?: 'task_session' | 'artifact';
  task_state?: ProgressTaskState;
  latest_update?: ProgressHistoryEntryInput;
  status: string;
  requested: string;
  now: string;
  next?: string[];
  log: ProgressDetailLogEntry[];
}

/**
 * `events` is the same chronological (oldest-first) history array the list
 * builder above reads `now` from — kept as a separate parameter (rather than
 * a field on `session`) because it also drives `log` (max 8, newest last).
 */
export function buildProgressDetail(
  session: ProgressDetailSessionInput,
  events: ProgressHistoryEntryInput[]
): ProgressDetail {
  const requested = session.success_condition?.trim()
    ? `${session.goal_summary} — ${session.success_condition.trim()}`
    : session.goal_summary;
  const now = deriveNowText(session.status, events);
  const next = [session.next_step, ...(session.gaps || [])].filter((value): value is string =>
    Boolean(value && value.trim())
  );
  const log = events.slice(-8).map((event) => ({ when: event.when, text: event.text }));

  return {
    ...(session.kind ? { kind: session.kind } : {}),
    ...(session.kind === 'task_session'
      ? {
          task_state: recordedTaskState(session.status, session.awaiting_user_input),
          ...(latestUpdate(events) ? { latest_update: latestUpdate(events) } : {}),
        }
      : {}),
    status: session.status,
    requested,
    now,
    ...(next.length > 0 ? { next } : {}),
    log,
  };
}

/**
 * Resolve the "手元の画面を見る" mirror link server-side from the surface
 * manifest (`computer-surface` id) — never a literal port in static files.
 * Best-effort like `readFrontDeskSurfacePorts` (`libs/core/front-desk-nav.ts`):
 * the manifest may be missing or unreadable in this execution context, so
 * this never throws and falls back to `COMPUTER_SURFACE_MIRROR_FALLBACK_PORT`.
 */
export function resolveComputerSurfaceMirrorHref(): string {
  try {
    return resolveSurfaceBrowserUrl('computer-surface') + '/';
  } catch {
    // Manifest absent/invalid — keep the documented fallback.
    return `http://127.0.0.1:${COMPUTER_SURFACE_MIRROR_FALLBACK_PORT}/`;
  }
}
