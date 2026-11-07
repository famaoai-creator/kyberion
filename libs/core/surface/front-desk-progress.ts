/**
 * front-desk-progress.ts — the shared read model behind "依頼" / "進み具合"
 * (a person's requests: what is in progress, what was delivered, what is
 * done). Concierge serves it at `GET /api/progress` + `GET /api/progress/[id]`
 * (仕事 › 依頼, Kyberion server phase 2); presence-studio keeps `GET
 * /api/progress` for its 頼む page's recent-requests list. Moved here from
 * `presence/displays/presence-studio/progress.ts` (FD-05) so both surfaces
 * build the payload with one implementation.
 *
 * Deliberately narrow input shapes (not the full `TaskSession` /
 * `ArtifactRecord` / `DeliverableInboxEntry` types) so the builders stay pure,
 * easily-fixtured functions — each route maps the real, already-viewer-scoped
 * runtime records into these shapes and performs all I/O (including the
 * manifest read for `mirror_href`); the builders never touch the filesystem
 * or network.
 *
 * Known gap, recorded here rather than invented (see FD-05 task notes):
 * `ArtifactRecord` (`artifact_id`, `active/shared/runtime/artifacts/*.json`)
 * and `DeliverableInboxEntry` (`entry_id`, `active/shared/inbox/entries.jsonl`)
 * are two different stores with two different id spaces — nothing in the
 * system links them except a best-effort `artifact_paths` match on
 * `ArtifactRecord.path` (`findMatchingInboxEntry`). `can_verdict` only says
 * that the matched inbox entry still waits for a decision; no surface records
 * that decision from this read model any more (Concierge links to 受信箱).
 * An artifact with no matching entry is never `can_verdict: true`.
 *
 * Scope and tier: `progressRecordInScope` is the tenant / org / project rule
 * both surfaces apply before mapping. Data-tier rules (personal, unknown) are
 * each caller's own (Concierge: `lib/progress-server.ts`).
 */
import { eventScopeFromRecord } from '../event-scope.js';
import { admitsTenant } from './surface-authorization.js';
import { resolveSurfaceBrowserUrl } from './surface-url.js';

/**
 * Coarse, documented estimate only — task sessions carry no numeric progress
 * field anywhere in the system. Statuses not listed here (e.g. `blocked`,
 * `paused`) render without a progress bar rather than guess a number. Also
 * used by presence-studio's home read model (`home.ts`).
 */
const TASK_SESSION_STATUS_PERCENT: Record<string, number> = {
  awaiting_instruction: 5,
  collecting_requirements: 15,
  planning: 30,
  awaiting_confirmation: 45,
  executing: 65,
  verifying: 85,
};

export function estimateTaskSessionPercent(status: string): number | undefined {
  return TASK_SESSION_STATUS_PERCENT[status];
}

/** Task sessions in these statuses are done, not "in progress" — same set
 * presence-studio's `home.ts` uses for its `in_progress` classification. */
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
  /** The matching deliverable-inbox `entry_id` — only present alongside
   * `inbox_status`. Decisions on it happen in the inbox, never here. */
  entry_id?: string;
  /** Whether the surface can serve this artifact's file(s) — each route
   * decides with its own download endpoint's rule. */
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

/** "Never dump raw markdown as a title": the record's file name, else a short
 * first line of its preview, else its kind. Same rule as the outcome panels. */
export function deriveProgressArtifactTitle(record: {
  path?: string;
  preview_text?: string;
  kind: string;
}): string {
  const fromPath = record.path ? String(record.path).split('/').filter(Boolean).pop() : '';
  if (fromPath) return fromPath;
  const firstLine = String(record.preview_text || '')
    .split('\n')[0]
    .replace(/^#+\s*/, '')
    .trim();
  return firstLine.length > 3 && firstLine.length <= 60 ? firstLine : record.kind || 'outcome';
}

export function progressHistoryFromTaskSession(session: {
  history?: Array<{ ts?: string; text?: string }>;
}): ProgressHistoryEntryInput[] {
  return Array.isArray(session.history)
    ? session.history
        .filter((entry): entry is { ts?: string; text: string } => Boolean(entry?.text))
        .map((entry) => ({ when: entry.ts, text: entry.text }))
    : [];
}

/** The fields of a `TaskSession` the progress read model uses. */
export interface ProgressTaskSessionRecord {
  session_id: string;
  correlation_id?: string;
  status: string;
  updated_at?: string;
  goal?: { summary?: string; success_condition?: string };
  control?: { awaiting_user_input?: boolean };
  completion_next_action?: { next_step?: string; gaps?: string[] };
  history?: Array<{ ts?: string; text?: string }>;
}

/** One task session as a list row input. */
export function progressTaskSessionInput(
  session: ProgressTaskSessionRecord
): ProgressTaskSessionInput {
  return {
    id: session.session_id,
    correlation_id: session.correlation_id,
    title: session.goal?.summary || session.session_id,
    status: session.status,
    awaiting_user_input: session.control?.awaiting_user_input === true,
    when: session.updated_at,
    history: progressHistoryFromTaskSession(session),
  };
}

/** Detail of a task session — reached directly (`task_session`) or through
 * an artifact that records it (`artifact`). */
export function buildTaskSessionProgressDetail(
  session: ProgressTaskSessionRecord,
  kind: 'task_session' | 'artifact'
): ProgressDetail {
  return buildProgressDetail(
    {
      kind,
      awaiting_user_input: session.control?.awaiting_user_input === true,
      goal_summary: session.goal?.summary || session.session_id,
      success_condition: session.goal?.success_condition,
      status: session.status,
      next_step: session.completion_next_action?.next_step,
      gaps: session.completion_next_action?.gaps,
    },
    progressHistoryFromTaskSession(session)
  );
}

/** Best-effort link from an artifact record to the deliverable-inbox entry
 * that (maybe) carries it — see the module doc: these are two different
 * stores with two different id spaces, and the only thing that can connect a
 * given record to an entry is a shared `path` on both sides. No match means
 * this artifact can never be verdict-eligible. */
export function findMatchingInboxEntry<T extends { artifact_paths: readonly string[] }>(
  inboxEntries: readonly T[],
  artifactPath: string | undefined
): T | undefined {
  if (!artifactPath) return undefined;
  return inboxEntries.find((entry) => entry.artifact_paths.includes(artifactPath));
}

/** The tenant a runtime record names, directly or in a nested scope envelope. */
export function progressRecordTenant(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const direct = record.tenant_slug;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  for (const key of ['scope', 'project', 'project_context', 'requestedByContext', 'context']) {
    const nested = progressRecordTenant(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

/** The server-resolved viewer scope a record is checked against. */
export interface ProgressViewerScope {
  tenantSlugs: string[] | 'all';
  organizationIds: string[] | 'all';
  projectIds: string[] | 'all';
  /** The system selection only: also admit records that carry no tenant. */
  includeUntenanted?: boolean;
}

/**
 * Whether a runtime record is inside the viewer's scope. Unknown-tenant
 * records are denied for a tenant-scoped viewer (unless the scope is the
 * system selection, `includeUntenanted`). An explicit organization / project
 * narrowing requires canonical scope metadata: unknown or conflicting legacy
 * metadata is omitted rather than widening the result.
 */
export function progressRecordInScope(scope: ProgressViewerScope, value: unknown): boolean {
  if (!admitsTenant(scope, progressRecordTenant(value))) return false;
  if (scope.organizationIds === 'all' && scope.projectIds === 'all') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const recordScope = eventScopeFromRecord(value as Record<string, unknown>);
  if (!recordScope) return false;
  return (
    (scope.organizationIds === 'all' ||
      Boolean(
        recordScope.organization_id && scope.organizationIds.includes(recordScope.organization_id)
      )) &&
    (scope.projectIds === 'all' ||
      Boolean(recordScope.project_id && scope.projectIds.includes(recordScope.project_id)))
  );
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
