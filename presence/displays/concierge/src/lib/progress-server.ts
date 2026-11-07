import { withExecutionContext } from '@agent/core/authority';
import { eventScopeFromRecord } from '@agent/core/event-scope';
import { listInboxEntries, type DeliverableInboxEntry } from '@agent/core/deliverable-inbox';
import type { TaskSession } from '@agent/core/task/task-session';
import { listTaskSessions } from '@agent/core/task/task-session';
import { listArtifactRecords, type ArtifactRecord } from '@agent/core/workforce/artifact-record';
import { resolveArtifactRecordTier, resolveInboxEntryTier } from './ops/deliverable-inbox';
import {
  buildProgressDetail,
  buildProgressPayload,
  buildTaskSessionProgressDetail,
  deriveProgressArtifactTitle,
  findMatchingInboxEntry,
  progressRecordInScope,
  progressTaskSessionInput,
  resolveComputerSurfaceMirrorHref,
  type ProgressArtifactInput,
  type ProgressDetail,
  type ProgressPayload,
  type ProgressViewerScope,
} from '@agent/core/surface/front-desk-progress';

/**
 * 仕事 › 依頼 (`/work?tab=requests`): the viewer's requests, moved from
 * presence-studio's 進み具合 page (`GET /api/progress`, `/api/progress/:id`,
 * Kyberion server phase 2). The payload builders are shared with Studio
 * (`@agent/core/surface/front-desk-progress`); this module gathers the same
 * three stores Studio read — presence task sessions, deliverable-inbox
 * entries and artifact records — and keeps only the records inside the
 * server-resolved viewer scope.
 *
 * Execution role: the reads run as `sovereign_concierge`, the role Concierge
 * already assumes to read the deliverable inbox (`/api/outcomes/[id]`,
 * `lib/outcome-files.ts`); it is in the `concierge` entry of
 * role-assumption-policy.json. The route tests run the real reads under
 * SYSTEM_ROLE=concierge against a temporary root. Why not the viewer-bound
 * role (`withConciergeViewerContext`): checked 2026-11-07, its
 * `concierge_operator` read is not refused on these stores either, but the
 * policy grants it no `active/shared/inbox/` read, so relying on it would
 * depend on an unenforced read path; the scope rule above, not the role,
 * decides what the viewer sees.
 *
 * Tiers: an artifact's tier is worked out exactly as the 成果物 list does
 * (`resolveArtifactRecordTier`: mission state, then metadata, then path) and
 * an unknown tier is denied. A task session or an inbox entry that names a
 * tier the viewer may not read is denied too.
 *
 * Decisions are not made here: a delivered item links to 受信箱, where the
 * deliverable inbox is decided. `downloadable` means the matching inbox entry
 * carries files the outcome files route (`/api/outcomes/[id]/files`) may
 * serve; that route re-checks the viewer for every file.
 */
export const PROGRESS_READ_ROLE = 'sovereign_concierge';
/** Same window Studio read the deliverable inbox with. */
const INBOX_LIMIT = 1000;

export interface ConciergeProgressScope extends ProgressViewerScope {
  tierAccess: ReadonlyArray<'personal' | 'confidential' | 'public'>;
}

type Tier = 'personal' | 'confidential' | 'public';
const allowsTier = (scope: ConciergeProgressScope, tier: Tier | undefined) =>
  Boolean(tier && scope.tierAccess.includes(tier));

function normalizeTier(value: unknown): Tier | undefined {
  return value === 'personal' || value === 'confidential' || value === 'public' ? value : undefined;
}

/** A task session's own tier signal (scope envelope or project context), if any. */
function taskSessionTier(session: TaskSession): Tier | undefined {
  return (
    normalizeTier(eventScopeFromRecord(session as unknown as Record<string, unknown>)?.tier) ??
    normalizeTier(session.project_context?.tier)
  );
}

/**
 * Task sessions carry no mission or file path, so most have no tier at all;
 * one is shown unless it names a tier the viewer may not read.
 */
export function taskSessionVisible(scope: ConciergeProgressScope, session: TaskSession): boolean {
  if (!progressRecordInScope(scope, session)) return false;
  const tier = taskSessionTier(session);
  return !tier || allowsTier(scope, tier);
}

/** Same rule as the 成果物 list: the resolved tier must be readable; unknown is denied. */
export function artifactVisible(scope: ConciergeProgressScope, record: ArtifactRecord): boolean {
  return (
    progressRecordInScope(scope, record) && allowsTier(scope, resolveArtifactRecordTier(record))
  );
}

/**
 * An inbox entry is only ever attached to an artifact that already passed
 * `artifactVisible`, through the exact same path; it is dropped when its own
 * mission or paths name a tier the viewer may not read.
 */
export function inboxEntryVisible(
  scope: ConciergeProgressScope,
  entry: DeliverableInboxEntry
): boolean {
  if (!progressRecordInScope(scope, entry)) return false;
  const tier = resolveInboxEntryTier(entry);
  return !tier || allowsTier(scope, tier);
}

function hasDeliveryFiles(entry: DeliverableInboxEntry | undefined): boolean {
  return Boolean(entry?.mission_id && entry.artifact_paths.length > 0);
}

/**
 * Where a delivery row's title came from and what the delivery is, so the
 * page can make it readable without guessing from the text: the shared
 * builder titles an artifact by its file name when it has a path.
 */
export interface DeliveryRowFacts {
  artifact_kind: string;
  title_from_file: boolean;
}
export type ConciergeProgressPayload = Omit<ProgressPayload, 'delivered' | 'done'> & {
  delivered: Array<ProgressPayload['delivered'][number] & DeliveryRowFacts>;
  done: Array<ProgressPayload['done'][number] & Partial<DeliveryRowFacts>>;
};

function titleFromFile(record: ArtifactRecord): boolean {
  return Boolean(record.path && String(record.path).split('/').filter(Boolean).pop());
}

export function readProgress(
  scope: ConciergeProgressScope,
  now = new Date()
): ConciergeProgressPayload {
  return withExecutionContext(PROGRESS_READ_ROLE, () => {
    const taskSessions = listTaskSessions('presence')
      .filter((session) => taskSessionVisible(scope, session))
      .map(progressTaskSessionInput);
    const inboxEntries = listInboxEntries({ limit: INBOX_LIMIT }).filter((entry) =>
      inboxEntryVisible(scope, entry)
    );
    const records = listArtifactRecords().filter((record) => artifactVisible(scope, record));
    const facts = new Map<string, DeliveryRowFacts>(
      records.map((record) => [
        record.artifact_id,
        { artifact_kind: record.kind, title_from_file: titleFromFile(record) },
      ])
    );
    const artifacts: ProgressArtifactInput[] = records.map((record) => {
      const matchedEntry = findMatchingInboxEntry(inboxEntries, record.path);
      return {
        id: record.artifact_id,
        title: deriveProgressArtifactTitle(record),
        kind: record.kind,
        when: matchedEntry?.updated_at || matchedEntry?.created_at,
        ...(matchedEntry
          ? { inbox_status: matchedEntry.status, entry_id: matchedEntry.entry_id }
          : {}),
        downloadable: hasDeliveryFiles(matchedEntry),
      };
    });
    const payload = buildProgressPayload({
      now,
      taskSessions,
      artifacts,
      mirrorHref: resolveComputerSurfaceMirrorHref(),
    });
    return {
      ...payload,
      delivered: payload.delivered.map((item) => ({
        ...item,
        ...(facts.get(item.id) ?? { artifact_kind: item.kind, title_from_file: false }),
      })),
      done: payload.done.map((item) =>
        item.kind === 'artifact' && facts.has(item.id) ? { ...item, ...facts.get(item.id)! } : item
      ),
    };
  });
}

/**
 * Detail for one item: a task-session id (active / done rows) or an
 * artifact-record id (delivered / done rows). An artifact outside the scope
 * is refused before its task association is followed; `null` means "not
 * found" for every out-of-scope or unknown id alike.
 */
/** Detail plus, for a delivery read on its own, its artifact kind (the page labels it). */
export type ConciergeProgressDetail = ProgressDetail & {
  artifact_kind?: string;
  title_from_file?: boolean;
};

export function readProgressDetail(
  scope: ConciergeProgressScope,
  id: string
): ConciergeProgressDetail | null {
  return withExecutionContext(PROGRESS_READ_ROLE, () => {
    const sessions = listTaskSessions('presence');
    const directSession = sessions.find((session) => session.session_id === id) ?? null;
    const artifact = directSession
      ? undefined
      : listArtifactRecords().find((record) => record.artifact_id === id);
    if (artifact && !artifactVisible(scope, artifact)) return null;
    const session =
      directSession ??
      (artifact?.task_session_id
        ? (sessions.find((item) => item.session_id === artifact.task_session_id) ?? null)
        : null);
    if (session) {
      if (!taskSessionVisible(scope, session)) return null;
      return buildTaskSessionProgressDetail(session, directSession ? 'task_session' : 'artifact');
    }
    if (!artifact) return null;
    const matchedEntry = findMatchingInboxEntry(
      listInboxEntries({ limit: INBOX_LIMIT }).filter((entry) => inboxEntryVisible(scope, entry)),
      artifact.path
    );
    return {
      ...buildProgressDetail(
        {
          kind: 'artifact',
          goal_summary: deriveProgressArtifactTitle(artifact),
          status: matchedEntry?.status || artifact.kind,
        },
        []
      ),
      artifact_kind: artifact.kind,
      title_from_file: titleFromFile(artifact),
    };
  });
}
