import { createHash } from 'node:crypto';
import type { InformationAssetObservation } from './types.js';

/**
 * Commitment Loop — the read-side projection over completed information intake
 * work. It derives "who owes what by when" from the hash-verified artifacts the
 * recipes already wrote; it is not a store. Effects (send, schedule, ask) stay
 * with the governed service actuator path and are never taken from here.
 */

export interface InformationMatter {
  /** Deterministic, provider-derived grouping key. Never produced by the model. */
  key: string;
  title: string;
}

export interface InformationArtifactSource {
  service_id: string;
  asset_type: string;
  event_type: string;
  occurred_at?: string;
  /** When the collector captured it; orders repeated observations of one subject. */
  observed_at?: string;
  source_url?: string;
  /** Meeting window, present for calendar observations only. */
  start?: string;
  end?: string;
}

const REPLY_PREFIX = /^\s*((re|fw|fwd|aw|wg|tr|返信|転送)\s*(\[\d+\])?\s*[:：]\s*)+/i;

export function normalizeMatterTitle(title: string): string {
  return title.replace(REPLY_PREFIX, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function header(data: Record<string, unknown>, name: string): string | undefined {
  const payload = data.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const headers = (payload as { headers?: unknown }).headers;
  if (!Array.isArray(headers)) return undefined;
  for (const entry of headers)
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { name?: unknown }).name === 'string' &&
      (entry as { name: string }).name.toLowerCase() === name &&
      typeof (entry as { value?: unknown }).value === 'string'
    )
      return (entry as { value: string }).value;
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Group by the provider's own conversation identity: Gmail thread, calendar series. */
export function informationMatterOf(observation: InformationAssetObservation): InformationMatter {
  const data = observation.data as Record<string, unknown>;
  if (observation.asset_type === 'calendar.meeting') {
    const calendar = str(data.calendar_id) ?? 'primary';
    const series = str(data.recurring_event_id) ?? str(data.id) ?? observation.subject_id;
    return { key: 'meeting:' + calendar + '/' + series, title: str(data.summary) ?? '' };
  }
  if (observation.service_id === 'google-workspace') {
    const thread = str(data.threadId) ?? str(data.thread_id);
    const title = header(data, 'subject') ?? str(data.snippet)?.slice(0, 200) ?? '';
    return {
      key: thread ? 'mail-thread:' + thread : 'mail-message:' + observation.subject_id,
      title,
    };
  }
  return { key: observation.asset_type + ':' + observation.subject_id, title: '' };
}

/** Gmail history does not set occurred_at; the message's own internalDate is the fact. */
function occurredAt(observation: InformationAssetObservation): string | undefined {
  if (observation.occurred_at) return observation.occurred_at;
  const internal = Number((observation.data as Record<string, unknown>).internalDate);
  return Number.isSafeInteger(internal) && internal > 0
    ? new Date(internal).toISOString()
    : undefined;
}

export function informationArtifactSourceOf(
  observation: InformationAssetObservation
): InformationArtifactSource {
  const data = observation.data as Record<string, unknown>;
  return {
    service_id: observation.service_id,
    asset_type: observation.asset_type,
    event_type: observation.event_type,
    ...(occurredAt(observation) ? { occurred_at: occurredAt(observation) } : {}),
    observed_at: observation.observed_at,
    ...(observation.source_url ? { source_url: observation.source_url } : {}),
    ...(observation.asset_type === 'calendar.meeting' && str(data.start) && str(data.end)
      ? { start: data.start as string, end: data.end as string }
      : {}),
  };
}

/** One completed, hash-verified intake artifact as read back from the artifact store. */
export interface CommitmentProjectionEntry {
  work_item_id: string;
  work_key: string;
  artifact_ref: string;
  /** Parsed artifact JSON written by `executeInformationAssetWork`. */
  artifact: unknown;
  /** Set by the reader when the artifact could not be read back or verified. */
  error?: string;
}

export type CommitmentOwnerSide = 'self' | 'counterpart' | 'unknown';
export type CommitmentState = 'open' | 'overdue' | 'waiting' | 'unassigned';

export interface Commitment {
  commitment_id: string;
  matter_key: string;
  matter_title: string;
  title: string;
  owner: string | null;
  owner_side: CommitmentOwnerSide;
  due_at: string | null;
  state: CommitmentState;
  /** Due time has passed; for `waiting` this means the other side is late. */
  late: boolean;
  source: {
    work_item_id: string;
    work_key: string;
    recipe_id: string;
    subject_id: string;
    artifact_ref: string;
  };
}

export interface ProjectedMeeting {
  matter_key: string;
  title: string;
  start: string;
  end: string;
  phase: 'upcoming' | 'ended';
  summary: string;
  preparation: string[];
  source_url?: string;
  work_item_id: string;
}

export interface ProjectedReplyDraft {
  matter_key: string;
  title: string;
  summary: string;
  reply_draft: string;
  source_url?: string;
  work_item_id: string;
}

export interface ProjectedMatter {
  matter_key: string;
  /** Other keys stitched into this matter by an identical normalized title. */
  linked_keys: string[];
  title: string;
  commitment_ids: string[];
}

export interface CommitmentProjection {
  generated_at: string;
  commitments: Commitment[];
  meetings: ProjectedMeeting[];
  reply_drafts: ProjectedReplyDraft[];
  matters: ProjectedMatter[];
  /** Artifacts that could not be read as intake results; reported, never silently dropped. */
  skipped: Array<{ work_item_id: string; reason: string }>;
}

interface ParsedArtifact {
  recipe_id: string;
  subject_id: string;
  change_id: string;
  matter: InformationMatter;
  source?: InformationArtifactSource;
  summary: string;
  category: string;
  reply_draft: string;
  actions: Array<{ title: string; owner: string | null; due_at: string | null }>;
}

function parseArtifact(value: unknown): ParsedArtifact | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'artifact_not_object';
  const v = value as Record<string, unknown>;
  for (const key of ['recipe_id', 'subject_id', 'change_id', 'summary', 'category'])
    if (typeof v[key] !== 'string') return 'artifact_missing_' + key;
  if (!Array.isArray(v.actions)) return 'artifact_missing_actions';
  const actions: ParsedArtifact['actions'] = [];
  for (const raw of v.actions) {
    if (!raw || typeof raw !== 'object') return 'artifact_action_invalid';
    const a = raw as Record<string, unknown>;
    if (typeof a.title !== 'string' || !a.title.trim()) return 'artifact_action_invalid';
    actions.push({
      title: a.title.trim(),
      owner: typeof a.owner === 'string' && a.owner.trim() ? a.owner.trim() : null,
      due_at:
        typeof a.due_at === 'string' && Number.isFinite(Date.parse(a.due_at)) ? a.due_at : null,
    });
  }
  const matter =
    v.matter &&
    typeof v.matter === 'object' &&
    typeof (v.matter as InformationMatter).key === 'string' &&
    typeof (v.matter as InformationMatter).title === 'string'
      ? (v.matter as InformationMatter)
      : // Artifacts written before matters existed still project, one matter per subject.
        { key: 'subject:' + (v.subject_id as string), title: '' };
  const source =
    v.source && typeof v.source === 'object' && !Array.isArray(v.source)
      ? (v.source as InformationArtifactSource)
      : undefined;
  return {
    recipe_id: v.recipe_id as string,
    subject_id: v.subject_id as string,
    change_id: v.change_id as string,
    matter,
    ...(source ? { source } : {}),
    summary: v.summary as string,
    category: v.category as string,
    reply_draft: typeof v.reply_draft === 'string' ? v.reply_draft : '',
    actions,
  };
}

const SELF_WORDS = new Set(['me', 'myself', 'i', 'self', '自分', '私']);

export function commitmentOwnerSide(
  owner: string | null,
  selfIdentities: readonly string[]
): CommitmentOwnerSide {
  if (!owner) return 'unknown';
  const normalized = owner.trim().toLowerCase();
  if (SELF_WORDS.has(normalized)) return 'self';
  for (const identity of selfIdentities) {
    const id = identity.trim().toLowerCase();
    if (id && (normalized === id || normalized.includes('<' + id + '>'))) return 'self';
  }
  return 'counterpart';
}

/** A date-only due ("2026-12-01") means the end of that day, not its first instant. */
export function commitmentDueMs(dueAt: string | null): number | undefined {
  if (dueAt === null) return undefined;
  const at = Date.parse(dueAt);
  if (!Number.isFinite(at)) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(dueAt) ? at + 86399999 : at;
}

function isLate(dueAt: string | null, nowMs: number): boolean {
  const due = commitmentDueMs(dueAt);
  return due !== undefined && due < nowMs;
}

function stateOf(side: CommitmentOwnerSide, dueAt: string | null, nowMs: number): CommitmentState {
  if (side === 'unknown') return 'unassigned';
  if (side === 'counterpart') return 'waiting';
  return isLate(dueAt, nowMs) ? 'overdue' : 'open';
}

function hashId(...parts: string[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);
}

function time(value: string | undefined): number {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? at : 0;
}

/** Newest capture first, then newest source event, then a stable identity tie-break. */
function newestFirst(
  a: { entry: CommitmentProjectionEntry; artifact: ParsedArtifact },
  b: { entry: CommitmentProjectionEntry; artifact: ParsedArtifact }
): number {
  return (
    time(b.artifact.source?.observed_at) - time(a.artifact.source?.observed_at) ||
    time(b.artifact.source?.occurred_at) - time(a.artifact.source?.occurred_at) ||
    a.entry.work_item_id.localeCompare(b.entry.work_item_id)
  );
}

/** Pure: same entries, identities and clock always yield the same projection. */
export function projectCommitments(
  entries: readonly CommitmentProjectionEntry[],
  options: { selfIdentities?: readonly string[]; now?: Date } = {}
): CommitmentProjection {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const self = options.selfIdentities ?? [];
  const skipped: CommitmentProjection['skipped'] = [];
  const parsed: Array<{ entry: CommitmentProjectionEntry; artifact: ParsedArtifact }> = [];
  for (const entry of entries) {
    const artifact = entry.error ?? parseArtifact(entry.artifact);
    if (typeof artifact === 'string')
      skipped.push({ work_item_id: entry.work_item_id, reason: artifact });
    else parsed.push({ entry, artifact });
  }
  // Newest observation of a matter wins when the same commitment is extracted again.
  parsed.sort(newestFirst);

  const byKey = new Map<string, Commitment>();
  const meetings = new Map<string, ProjectedMeeting>();
  const replies = new Map<string, ProjectedReplyDraft>();
  for (const { entry, artifact } of parsed) {
    const source = artifact.source;
    const isMeeting = source?.asset_type === 'calendar.meeting';
    if (isMeeting && source?.start && source.end) {
      const phase = source.event_type === 'meeting.upcoming' ? 'upcoming' : 'ended';
      // A prepared meeting whose start has passed is no longer upcoming; its follow-up
      // arrives as its own `meeting.ended` observation.
      if (phase === 'upcoming' && time(source.start) <= nowMs) continue;
      const meetingKey = artifact.subject_id + ':' + phase;
      if (!meetings.has(meetingKey))
        meetings.set(meetingKey, {
          matter_key: artifact.matter.key,
          title: artifact.matter.title,
          start: source.start,
          end: source.end,
          phase,
          summary: artifact.summary,
          preparation: phase === 'upcoming' ? artifact.actions.map((a) => a.title) : [],
          ...(source.source_url ? { source_url: source.source_url } : {}),
          work_item_id: entry.work_item_id,
        });
      // Preparation steps are listed with the meeting; only follow-up actions become commitments.
      if (phase === 'upcoming') continue;
    }
    if (
      !isMeeting &&
      artifact.category === 'action_required' &&
      artifact.reply_draft.trim() &&
      !replies.has(artifact.matter.key)
    )
      replies.set(artifact.matter.key, {
        matter_key: artifact.matter.key,
        title: artifact.matter.title,
        summary: artifact.summary,
        reply_draft: artifact.reply_draft,
        ...(source?.source_url ? { source_url: source.source_url } : {}),
        work_item_id: entry.work_item_id,
      });
    for (const action of artifact.actions) {
      const dedupe = artifact.matter.key + '\u0000' + normalizeMatterTitle(action.title);
      if (byKey.has(dedupe)) continue;
      const side = commitmentOwnerSide(action.owner, self);
      byKey.set(dedupe, {
        commitment_id: hashId(artifact.matter.key, normalizeMatterTitle(action.title)),
        matter_key: artifact.matter.key,
        matter_title: artifact.matter.title,
        title: action.title,
        owner: action.owner,
        owner_side: side,
        due_at: action.due_at,
        state: stateOf(side, action.due_at, nowMs),
        late: isLate(action.due_at, nowMs),
        source: {
          work_item_id: entry.work_item_id,
          work_key: entry.work_key,
          recipe_id: artifact.recipe_id,
          subject_id: artifact.subject_id,
          artifact_ref: entry.artifact_ref,
        },
      });
    }
  }

  const commitments = [...byKey.values()].sort(compareCommitments);
  return {
    generated_at: now.toISOString(),
    commitments,
    meetings: [...meetings.values()].sort(
      (a, b) => a.start.localeCompare(b.start) || a.phase.localeCompare(b.phase)
    ),
    reply_drafts: [...replies.values()].sort((a, b) => a.matter_key.localeCompare(b.matter_key)),
    matters: stitchMatters(
      parsed.map((p) => p.artifact.matter),
      commitments
    ),
    skipped,
  };
}

const STATE_ORDER: Record<CommitmentState, number> = {
  overdue: 0,
  open: 1,
  unassigned: 2,
  waiting: 3,
};

function compareCommitments(a: Commitment, b: Commitment): number {
  return (
    STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
    (commitmentDueMs(a.due_at) ?? Infinity) - (commitmentDueMs(b.due_at) ?? Infinity) ||
    a.commitment_id.localeCompare(b.commitment_id)
  );
}

/**
 * A mail thread and a meeting about the same thing share a matter when their
 * normalized titles are identical. This is the only cross-source rule: exact,
 * explainable, and never inferred by the model.
 */
function stitchMatters(
  matters: readonly InformationMatter[],
  commitments: readonly Commitment[]
): ProjectedMatter[] {
  const titles = new Map<string, string>();
  for (const matter of matters) if (!titles.has(matter.key)) titles.set(matter.key, matter.title);
  const groups = new Map<string, string[]>();
  for (const [key, title] of titles) {
    const normalized = normalizeMatterTitle(title);
    const group = normalized.length >= 4 ? 'title:' + normalized : 'key:' + key;
    groups.set(group, [...(groups.get(group) ?? []), key]);
  }
  return [...groups.values()]
    .map((keys) => {
      const sorted = [...keys].sort();
      const primary = sorted[0]!;
      return {
        matter_key: primary,
        linked_keys: sorted.slice(1),
        title: titles.get(primary) ?? '',
        commitment_ids: commitments
          .filter((c) => sorted.includes(c.matter_key))
          .map((c) => c.commitment_id),
      };
    })
    .sort((a, b) => a.matter_key.localeCompare(b.matter_key));
}

function line(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Morning digest: decisions first, then what you owe, then what you are waiting on. */
export function renderCommitmentDigest(projection: CommitmentProjection): string {
  const out: string[] = ['# Commitment digest', '', '_Generated ' + projection.generated_at + '_'];
  const upcoming = projection.meetings.filter((m) => m.phase === 'upcoming');
  const self = projection.commitments.filter((c) => c.state === 'overdue' || c.state === 'open');
  const unassigned = projection.commitments.filter((c) => c.state === 'unassigned');
  const waiting = projection.commitments.filter((c) => c.state === 'waiting');
  const due = (c: Commitment) => (c.due_at ? ' — due ' + c.due_at : '');
  const where = (c: Commitment) => (c.matter_title ? ' _(' + line(c.matter_title) + ')_' : '');

  out.push('', '## Reply drafts to review (' + projection.reply_drafts.length + ')');
  if (!projection.reply_drafts.length) out.push('', 'None.');
  for (const reply of projection.reply_drafts)
    out.push(
      '',
      '### ' + (line(reply.title) || reply.matter_key),
      '',
      line(reply.summary),
      '',
      ...reply.reply_draft.split('\n').map((l) => '> ' + l),
      '',
      'Not sent. Sending goes through the approved reply path.'
    );

  out.push('', '## Upcoming meetings (' + upcoming.length + ')');
  if (!upcoming.length) out.push('', 'None.');
  for (const meeting of upcoming) {
    out.push('', '- **' + meeting.start + '** ' + (line(meeting.title) || '(untitled)'));
    if (meeting.summary) out.push('  - ' + line(meeting.summary));
    for (const step of meeting.preparation) out.push('  - [ ] ' + line(step));
  }

  out.push('', '## You owe (' + self.length + ')');
  if (!self.length) out.push('', 'None.');
  for (const c of self)
    out.push(
      '- ' + (c.state === 'overdue' ? '**OVERDUE** ' : '') + line(c.title) + due(c) + where(c)
    );

  if (unassigned.length) {
    out.push('', '## No owner yet (' + unassigned.length + ')');
    for (const c of unassigned) out.push('- ' + line(c.title) + due(c) + where(c));
  }

  out.push('', '## Waiting on others (' + waiting.length + ')');
  if (!waiting.length) out.push('', 'None.');
  for (const c of waiting)
    out.push(
      '- ' +
        (c.late ? '**LATE** ' : '') +
        line(c.owner ?? '') +
        ': ' +
        line(c.title) +
        due(c) +
        where(c)
    );

  if (projection.skipped.length)
    out.push(
      '',
      '## Not shown (' + projection.skipped.length + ')',
      '',
      ...projection.skipped.map((s) => '- ' + s.work_item_id + ': ' + s.reason)
    );
  return out.join('\n') + '\n';
}
