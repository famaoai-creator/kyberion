import { nowIso } from '../foundation/time.js';
import { loadState } from '../mission/mission-state.js';
import { t } from '../t.js';
import type { SupportedLocale } from '../locale-normalize.js';
import {
  readGovernedArtifactJson,
  writeGovernedArtifactJson,
} from '../workforce/artifact-store.js';

/**
 * Team Channel P2: the durable work a chat thread started.
 *
 * Each thread that issued a mission gets one small index file under the
 * surface's coordination area, so the thread can later ask "how is it going?"
 * and get an answer from governed state (the mission's own state file) rather
 * than from the model's memory. The index stores identifiers and attribution
 * only; status is always read live.
 */

export type ThreadWorkKind = 'mission';

export interface ThreadWorkEntry {
  kind: ThreadWorkKind;
  id: string;
  /** Principal that asked for the work (`user:<member_id>` or a chat actor id). */
  requested_by?: string;
  /** Principal that confirmed it (approval-class decision). */
  confirmed_by?: string;
  created_at: string;
}

export interface ThreadWorkIndex {
  schema_version: '2.0.0';
  surface: string;
  channel: string;
  thread_ts: string;
  tenant_slug?: string;
  entries: ThreadWorkEntry[];
}

export interface ThreadRef {
  surface: string;
  channel: string;
  threadTs: string;
}

/** Writes as the surface's coordination role; surfaces without one cannot record. */
function writeAsSurface(surface: string, logicalPath: string, value: unknown): void {
  switch (surface) {
    case 'slack':
      writeGovernedArtifactJson('slack_bridge', logicalPath, value);
      return;
    case 'chronos':
      writeGovernedArtifactJson('chronos_gateway', logicalPath, value);
      return;
    default:
      throw new Error(`[THREAD_WORK] surface '${surface}' has no thread-work writer`);
  }
}

const MAX_ENTRIES = 50;

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function threadWorkLogicalPath(ref: ThreadRef): string {
  return `active/shared/coordination/channels/${safeSegment(ref.surface)}/thread-work/${safeSegment(ref.channel)}-${safeSegment(ref.threadTs)}.json`;
}

export function readThreadWork(ref: ThreadRef): ThreadWorkIndex | null {
  const index = readGovernedArtifactJson<ThreadWorkIndex>(threadWorkLogicalPath(ref));
  if (
    !index ||
    index.schema_version !== '2.0.0' ||
    index.channel !== ref.channel ||
    index.thread_ts !== ref.threadTs
  ) {
    return null;
  }
  return index;
}

/** Record that a thread started a piece of work. Idempotent per (kind, id). */
export function recordThreadWork(
  ref: ThreadRef,
  entry: Omit<ThreadWorkEntry, 'created_at'> & { created_at?: string },
  options: { tenantSlug?: string } = {}
): ThreadWorkIndex {
  if (ref.surface !== 'slack' && ref.surface !== 'chronos') {
    throw new Error(`[THREAD_WORK] surface '${ref.surface}' has no thread-work writer`);
  }
  const existing = readThreadWork(ref);
  // Scope changes in either direction reset history. In particular, an
  // unscoped write must not leave the previous tenant attached to its entries.
  const tenantChanged =
    existing !== null && (existing.tenant_slug ?? null) !== (options.tenantSlug ?? null);
  const priorEntries = tenantChanged ? [] : (existing?.entries ?? []);
  const entries = priorEntries.filter(
    (item) => !(item.kind === entry.kind && item.id === entry.id)
  );
  entries.push({ ...entry, created_at: entry.created_at ?? nowIso() });
  const index: ThreadWorkIndex = {
    schema_version: '2.0.0',
    surface: ref.surface,
    channel: ref.channel,
    thread_ts: ref.threadTs,
    ...(options.tenantSlug ? { tenant_slug: options.tenantSlug } : {}),
    entries: entries.slice(-MAX_ENTRIES),
  };
  writeAsSurface(ref.surface, threadWorkLogicalPath(ref), index);
  return index;
}

export interface ThreadWorkStatus extends ThreadWorkEntry {
  status: string;
}

/** Entries with their live status (`unknown` when the state is unreadable). */
export function resolveThreadWorkStatus(
  index: ThreadWorkIndex | null,
  loadMissionStatus: (missionId: string) => string | undefined = defaultMissionStatus
): ThreadWorkStatus[] {
  return (index?.entries ?? []).map((entry) => ({
    ...entry,
    status: loadMissionStatus(entry.id) || 'unknown',
  }));
}

function defaultMissionStatus(missionId: string): string | undefined {
  try {
    const status = loadState(missionId)?.status;
    return typeof status === 'string' ? status : undefined;
  } catch {
    return undefined;
  }
}

export function formatThreadWorkStatus(
  statuses: readonly ThreadWorkStatus[],
  locale: SupportedLocale
): string {
  if (statuses.length === 0) return t('bridge:thread_work_none', undefined, locale);
  return [
    t('bridge:thread_work_header', { count: statuses.length }, locale),
    ...statuses.map((item) =>
      t(
        'bridge:thread_work_line',
        {
          id: item.id,
          status: item.status,
          confirmed: item.confirmed_by ?? '-',
        },
        locale
      )
    ),
  ].join('\n');
}

const STATUS_QUERY =
  /^(?:status|progress|how(?:'s| is) it going|状況|進捗|進み具合|ステータス)(?:は|を教えて|どう|どうなってる|どうですか)?[?？。.!！\s]*$/iu;

/** Deterministic "what's the status of this thread's work?" detector. */
export function isThreadStatusQuery(text: string): boolean {
  return STATUS_QUERY.test(text.trim());
}
