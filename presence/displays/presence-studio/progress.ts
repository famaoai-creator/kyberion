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
import { loadSurfaceManifest } from '@agent/core/surface-runtime';
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

export interface ProgressTaskSessionInput {
  id: string;
  title: string;
  status: string;
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
  id: string;
  title: string;
  now: string;
  percent?: number;
  when?: string;
  selected_default?: boolean;
}

export interface ProgressDeliveredItem {
  id: string;
  title: string;
  kind: string;
  when?: string;
  can_verdict: boolean;
  entry_id?: string;
  downloadable?: boolean;
}

export interface ProgressDoneItem {
  id: string;
  title: string;
  kind: 'task_session' | 'artifact';
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

/** The one-line "いまやっていること" — the latest non-empty history entry's
 * text, falling back to the raw status when there is no history yet. */
function latestNonEmptyText(history: ProgressHistoryEntryInput[] | undefined): string | undefined {
  if (!history?.length) return undefined;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const text = history[index]?.text?.trim();
    if (text) return text;
  }
  return undefined;
}

function deriveNowText(status: string, history: ProgressHistoryEntryInput[] | undefined): string {
  return latestNonEmptyText(history) || status;
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
      percent: estimateTaskSessionPercent(session.status),
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
    .map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      kind: artifact.kind,
      when: artifact.when,
      can_verdict: artifact.inbox_status === 'unread' || artifact.inbox_status === 'read',
      ...(artifact.entry_id ? { entry_id: artifact.entry_id } : {}),
      downloadable: Boolean(artifact.downloadable),
    }))
    .sort((a, b) => toTimeMs(b.when, nowMs) - toTimeMs(a.when, nowMs));

  const done: ProgressDoneItem[] = [
    ...doneSessions.map((session) => ({
      id: session.id,
      title: session.title,
      kind: 'task_session' as const,
      when: session.when,
    })),
    ...doneArtifacts.map((artifact) => ({
      id: artifact.id,
      title: artifact.title,
      kind: 'artifact' as const,
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
  let port = COMPUTER_SURFACE_MIRROR_FALLBACK_PORT;
  try {
    const manifest = loadSurfaceManifest();
    const definition = manifest.surfaces.find((surface) => surface.id === 'computer-surface');
    if (
      definition &&
      typeof definition.port === 'number' &&
      Number.isFinite(definition.port) &&
      definition.port > 0
    ) {
      port = definition.port;
    }
  } catch {
    // Manifest absent/invalid — keep the documented fallback.
  }
  return `http://127.0.0.1:${port}/`;
}
