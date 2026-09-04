import { isRecord } from '@agent/core/foundation/primitives';

export type ClientCollaborationProjection = {
  revision: number;
  generated_at: string;
  partial: boolean;
  status_flags: Array<'sequence_gap' | 'unknown_event' | 'stale_runtime'>;
  sequence_gaps: Array<{
    source: string;
    previous_seq: number;
    expected_seq: number;
    actual_seq: number;
  }>;
  overview: {
    events: number;
    missions: number;
    tasks: number;
    agents: number;
    active: number;
    blocked: number;
    waiting_human: number;
    review_pending: number;
    failures: number;
    native_subagents: number;
    unavailable_subagents: number;
  };
  events: Array<{
    event_id: string;
    ts: string;
    mission_id?: string;
    task_id?: string;
    agent_id?: string;
    causation_id?: string;
    evidence_refs?: string[];
    kind: string;
    summary: string;
    source: string;
    provider?: string;
    thread_id?: string;
    parent_thread_id?: string;
    turn_id?: string;
    native?: boolean;
    native_fork?: boolean;
    native_mode?: string;
    effort?: 'low' | 'medium' | 'high' | 'ultra';
    native_unavailable?: boolean;
  }>;
  edges: Array<{ from: string; to: string; kind: string; event_id: string }>;
  attention: Array<{
    event_id: string;
    mission_id?: string;
    task_id?: string;
    agent_id?: string;
    kind: string;
    title: string;
    reason: string;
    next_action: string;
  }>;
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STATUS_FLAGS = new Set(['sequence_gap', 'unknown_event', 'stale_runtime']);
const EFFORTS = new Set(['low', 'medium', 'high', 'ultra']);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && Boolean(value.trim());
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function optionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseSequenceGap(
  value: unknown
): ClientCollaborationProjection['sequence_gaps'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.source) ||
    !nonNegativeInteger(value.previous_seq) ||
    !nonNegativeInteger(value.expected_seq) ||
    !nonNegativeInteger(value.actual_seq)
  ) {
    return undefined;
  }
  return {
    source: value.source,
    previous_seq: value.previous_seq,
    expected_seq: value.expected_seq,
    actual_seq: value.actual_seq,
  };
}

function parseEvent(value: unknown): ClientCollaborationProjection['events'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.event_id) ||
    !nonEmptyString(value.ts) ||
    !nonEmptyString(value.kind) ||
    !nonEmptyString(value.summary) ||
    !nonEmptyString(value.source) ||
    !optionalString(value.mission_id) ||
    !optionalString(value.task_id) ||
    !optionalString(value.agent_id) ||
    !optionalString(value.causation_id) ||
    !optionalString(value.provider) ||
    !optionalString(value.thread_id) ||
    !optionalString(value.parent_thread_id) ||
    !optionalString(value.turn_id) ||
    !optionalString(value.native_mode) ||
    !optionalBoolean(value.native) ||
    !optionalBoolean(value.native_fork) ||
    !optionalBoolean(value.native_unavailable) ||
    (value.evidence_refs !== undefined && !stringArray(value.evidence_refs)) ||
    (value.effort !== undefined && !EFFORTS.has(value.effort as string))
  ) {
    return undefined;
  }
  return {
    event_id: value.event_id,
    ts: value.ts,
    ...(value.mission_id !== undefined ? { mission_id: value.mission_id } : {}),
    ...(value.task_id !== undefined ? { task_id: value.task_id } : {}),
    ...(value.agent_id !== undefined ? { agent_id: value.agent_id } : {}),
    ...(value.causation_id !== undefined ? { causation_id: value.causation_id } : {}),
    ...(value.evidence_refs !== undefined ? { evidence_refs: value.evidence_refs } : {}),
    kind: value.kind,
    summary: value.summary,
    source: value.source,
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.thread_id !== undefined ? { thread_id: value.thread_id } : {}),
    ...(value.parent_thread_id !== undefined ? { parent_thread_id: value.parent_thread_id } : {}),
    ...(value.turn_id !== undefined ? { turn_id: value.turn_id } : {}),
    ...(value.native !== undefined ? { native: value.native } : {}),
    ...(value.native_fork !== undefined ? { native_fork: value.native_fork } : {}),
    ...(value.native_mode !== undefined ? { native_mode: value.native_mode } : {}),
    ...(value.effort !== undefined
      ? { effort: value.effort as 'low' | 'medium' | 'high' | 'ultra' }
      : {}),
    ...(value.native_unavailable !== undefined
      ? { native_unavailable: value.native_unavailable }
      : {}),
  };
}

function parseAttention(
  value: unknown
): ClientCollaborationProjection['attention'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.event_id) ||
    !nonEmptyString(value.kind) ||
    !nonEmptyString(value.title) ||
    !nonEmptyString(value.reason) ||
    !nonEmptyString(value.next_action) ||
    !optionalString(value.mission_id) ||
    !optionalString(value.task_id) ||
    !optionalString(value.agent_id)
  ) {
    return undefined;
  }
  return {
    event_id: value.event_id,
    ...(value.mission_id !== undefined ? { mission_id: value.mission_id } : {}),
    ...(value.task_id !== undefined ? { task_id: value.task_id } : {}),
    ...(value.agent_id !== undefined ? { agent_id: value.agent_id } : {}),
    kind: value.kind,
    title: value.title,
    reason: value.reason,
    next_action: value.next_action,
  };
}

export function parseCollaborationResponse(
  value: unknown
): ClientCollaborationProjection | undefined {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    value.ok !== true ||
    !isRecord(value.projection) ||
    !nonNegativeInteger(value.projection.revision) ||
    !nonEmptyString(value.projection.generated_at) ||
    typeof value.projection.partial !== 'boolean' ||
    !Array.isArray(value.projection.status_flags) ||
    value.projection.status_flags.some(
      (flag) => typeof flag !== 'string' || !STATUS_FLAGS.has(flag)
    ) ||
    !Array.isArray(value.projection.sequence_gaps) ||
    !isRecord(value.projection.overview) ||
    !Array.isArray(value.projection.events) ||
    !Array.isArray(value.projection.edges) ||
    !Array.isArray(value.projection.attention)
  ) {
    return undefined;
  }
  const sequenceGaps = value.projection.sequence_gaps.map(parseSequenceGap);
  const events = value.projection.events.map(parseEvent);
  const attention = value.projection.attention.map(parseAttention);
  const edges = value.projection.edges.map((entry) => {
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.from) ||
      !nonEmptyString(entry.to) ||
      !nonEmptyString(entry.kind) ||
      !nonEmptyString(entry.event_id)
    ) {
      return undefined;
    }
    return { from: entry.from, to: entry.to, kind: entry.kind, event_id: entry.event_id };
  });
  const overviewKeys = [
    'events',
    'missions',
    'tasks',
    'agents',
    'active',
    'blocked',
    'waiting_human',
    'review_pending',
    'failures',
    'native_subagents',
    'unavailable_subagents',
  ] as const;
  if (
    overviewKeys.some((key) => !nonNegativeInteger(value.projection.overview[key])) ||
    !sequenceGaps.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !events.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !edges.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !attention.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  ) {
    return undefined;
  }
  return {
    revision: value.projection.revision,
    generated_at: value.projection.generated_at,
    partial: value.projection.partial,
    status_flags: value.projection.status_flags as ClientCollaborationProjection['status_flags'],
    sequence_gaps: sequenceGaps,
    overview: Object.fromEntries(
      overviewKeys.map((key) => [key, value.projection.overview[key]])
    ) as ClientCollaborationProjection['overview'],
    events,
    edges,
    attention,
  };
}
