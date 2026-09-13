/**
 * home.ts — FD-02: pure payload builder for `GET /api/home` (the presence
 * studio home page — the human "ホーム" surface). See
 * `docs/developer/improvement-plans-2026-08/FRONT_DESK_REDESIGN_PLAN_2026-09-13.ja.md`
 * §2.1 / FD-02.
 *
 * Deliberately narrow input shapes (not the full `ApprovalRequestRecord` /
 * `HeldActionSummary` / `TaskSession` / `ArtifactRecord` types from
 * `@agent/core`) so this stays a pure, easily-fixtured function — `server.ts`
 * maps the real, already-viewer-scoped runtime records into these shapes and
 * performs all I/O; this module never touches the filesystem or network.
 *
 * Known gaps (recorded here rather than invented):
 * - `exception` and `stalled` decide items have no data source on this
 *   surface — they live on the concierge "決める" queue (FD-04). This
 *   surface only ever produces `approval` decide items, from the pending
 *   approval inbox and pending OS control-plane held actions.
 * - Task sessions carry no numeric progress field, so `percent` is a coarse,
 *   documented status→percent estimate — not a metric measured anywhere
 *   else in the system.
 */

export type HomeDecideKind = 'approval' | 'exception' | 'stalled' | 'memory';
export type HomeProgressKind = 'in_progress' | 'delivered';

/** A pending item that can become a `decide` row (approval inbox entry or
 * pending OS control-plane held action) — callers map both sources into
 * this one shape before calling `buildHomePayload`. */
export interface HomeDecideCandidateInput {
  id: string;
  title: string;
  tenant_slug?: string;
  /** ISO timestamp the item started waiting (requestedAt / submittedAt). */
  when?: string;
}

export interface HomeTaskSessionInput {
  id: string;
  title: string;
  status: string;
  /** ISO timestamp of the session's last update. */
  when?: string;
}

export interface HomeArtifactInput {
  id: string;
  title: string;
  /** ISO timestamp; artifact records carry no timestamp field today, so
   * callers pass whatever ordering proxy they have (may be omitted). */
  when?: string;
}

export interface HomeDecideItem {
  id: string;
  kind: HomeDecideKind;
  title: string;
  tenant_slug?: string;
  urgency: number;
  when?: string;
  href_hint: 'decide';
}

export interface HomeProgressItem {
  id: string;
  kind: HomeProgressKind;
  title: string;
  detail?: string;
  percent?: number;
  when?: string;
  href_hint: 'work' | 'outcome';
}

export interface HomePayload {
  ok: true;
  date: string;
  counts: { decide: number; progress: number; delivered: number };
  decide: HomeDecideItem[];
  progress: HomeProgressItem[];
}

export interface BuildHomePayloadInput {
  now: Date;
  /** Pending approval-inbox requests (`listApprovalRequests({status:'pending'})`). */
  approvals: HomeDecideCandidateInput[];
  /** Pending OS control-plane held actions (`cloudflareOsSurface.snapshot(...).heldActions`, status === 'pending'). */
  heldActions: HomeDecideCandidateInput[];
  /** Non-terminal + terminal task sessions; classification happens here. */
  taskSessions: HomeTaskSessionInput[];
  /** Outcome/artifact records (`listArtifactRecords()`); this surface has no
   * "not yet accepted" tracking, so every artifact record is a `delivered`
   * row (same set the existing "Latest Outcomes" panel shows). */
  artifacts: HomeArtifactInput[];
}

const DECIDE_KIND_WEIGHT: Record<HomeDecideKind, number> = {
  approval: 3,
  exception: 2,
  stalled: 1,
  memory: 0,
};

/** Task sessions in these statuses are done, not "in progress". */
const TASK_SESSION_TERMINAL_STATUSES = new Set(['completed', 'failed', 'released']);

/**
 * Coarse, documented estimate only — task sessions carry no numeric progress
 * field anywhere in the system. Statuses not listed here (e.g. `blocked`,
 * `paused`) render without a progress bar rather than guess a number.
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

function toTimeMs(when: string | undefined, fallbackMs: number): number {
  if (!when) return fallbackMs;
  const parsed = Date.parse(when);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}

/** Higher urgency sorts first: kind dominates, then older items (longer wait) win. */
function decideUrgency(kind: HomeDecideKind, when: string | undefined, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - toTimeMs(when, nowMs));
  return DECIDE_KIND_WEIGHT[kind] * 1e13 + ageMs;
}

export function buildHomePayload(input: BuildHomePayloadInput): HomePayload {
  const nowMs = input.now.getTime();
  const date = input.now.toISOString().slice(0, 10);

  const decideAll: HomeDecideItem[] = [...input.approvals, ...input.heldActions]
    .map((item) => ({
      id: item.id,
      kind: 'approval' as const,
      title: item.title,
      tenant_slug: item.tenant_slug,
      when: item.when,
      urgency: decideUrgency('approval', item.when, nowMs),
      href_hint: 'decide' as const,
    }))
    .sort((a, b) => b.urgency - a.urgency);

  const inProgress: HomeProgressItem[] = input.taskSessions
    .filter((session) => !TASK_SESSION_TERMINAL_STATUSES.has(session.status))
    .map((session) => ({
      id: session.id,
      kind: 'in_progress' as const,
      title: session.title,
      percent: estimateTaskSessionPercent(session.status),
      when: session.when,
      href_hint: 'work' as const,
    }))
    .sort((a, b) => toTimeMs(b.when, nowMs) - toTimeMs(a.when, nowMs));

  const delivered: HomeProgressItem[] = input.artifacts
    .map((artifact) => ({
      id: artifact.id,
      kind: 'delivered' as const,
      title: artifact.title,
      when: artifact.when,
      href_hint: 'outcome' as const,
    }))
    .sort((a, b) => toTimeMs(b.when, nowMs) - toTimeMs(a.when, nowMs));

  const progress = [...inProgress, ...delivered].slice(0, 4);

  return {
    ok: true,
    date,
    counts: {
      decide: decideAll.length,
      progress: inProgress.length,
      delivered: delivered.length,
    },
    decide: decideAll.slice(0, 3),
    progress,
  };
}
