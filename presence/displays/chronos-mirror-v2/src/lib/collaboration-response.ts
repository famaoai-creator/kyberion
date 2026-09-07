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
    code: ClientCollaborationAttentionCode;
    title: string;
    reason: string;
    next_action: string;
  }>;
  tree: ClientCollaborationTree;
};

// AC-09: mirrors `@agent/core/agent-collaboration-projection`'s
// `CollaborationAttentionCode`. The surface translates from `code`, not the
// developer-facing English `title` / `next_action` core sends alongside it.
export type ClientCollaborationAttentionCode =
  'blocked' | 'waiting_human' | 'review_pending' | 'failure';

// AC-06: mirrors `@agent/core/agent-collaboration-tree`'s `CollaborationTree`.
// Re-declared (not imported) so this file keeps validating every field it
// renders, the same convention `events` / `attention` above already follow.
export type ClientCollaborationWaitReason =
  'approval_pending' | 'child_running' | 'claim_pending' | 'blocked' | 'review_pending' | 'stale';

export type ClientCollaborationTreeNode = {
  id: string;
  type: 'mission' | 'task' | 'agent';
  label: string;
  state?: string;
  provider?: string;
  team_role?: string;
  native?: boolean;
  started_at?: string;
  last_event_at?: string;
  elapsed_ms?: number;
  waiting_on: Array<{ reason: ClientCollaborationWaitReason; target_id?: string; since: string }>;
  handoffs: Array<{ to_agent_id: string; performative?: string; at: string }>;
  children: ClientCollaborationTreeNode[];
};

export type ClientCollaborationTree = {
  generated_at: string;
  roots: ClientCollaborationTreeNode[];
  orphans: ClientCollaborationTreeNode[];
  waiting: Array<{
    node_id: string;
    reason: ClientCollaborationWaitReason;
    since: string;
    target_id?: string;
  }>;
  stats: {
    missions: number;
    tasks: number;
    agents_total: number;
    agents_running: number;
    agents_waiting: number;
    agents_done: number;
    humans_waited_on: number;
  };
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const STATUS_FLAGS = new Set(['sequence_gap', 'unknown_event', 'stale_runtime']);
const EFFORTS = new Set(['low', 'medium', 'high', 'ultra']);
const ATTENTION_CODES = new Set(['blocked', 'waiting_human', 'review_pending', 'failure']);
const WAIT_REASONS = new Set([
  'approval_pending',
  'child_running',
  'claim_pending',
  'blocked',
  'review_pending',
  'stale',
]);

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
    typeof value.code !== 'string' ||
    !ATTENTION_CODES.has(value.code) ||
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
    code: value.code as ClientCollaborationAttentionCode,
    title: value.title,
    reason: value.reason,
    next_action: value.next_action,
  };
}

function parseWait(value: unknown): ClientCollaborationTreeNode['waiting_on'][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.reason !== 'string' ||
    !WAIT_REASONS.has(value.reason) ||
    !nonEmptyString(value.since) ||
    !optionalString(value.target_id)
  ) {
    return undefined;
  }
  return {
    reason: value.reason as ClientCollaborationWaitReason,
    since: value.since,
    ...(value.target_id !== undefined ? { target_id: value.target_id } : {}),
  };
}

function parseHandoff(value: unknown): ClientCollaborationTreeNode['handoffs'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.to_agent_id) ||
    !nonEmptyString(value.at) ||
    !optionalString(value.performative)
  ) {
    return undefined;
  }
  return {
    to_agent_id: value.to_agent_id,
    at: value.at,
    ...(value.performative !== undefined ? { performative: value.performative } : {}),
  };
}

function parseTreeNode(value: unknown): ClientCollaborationTreeNode | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.id) ||
    (value.type !== 'mission' && value.type !== 'task' && value.type !== 'agent') ||
    !nonEmptyString(value.label) ||
    !optionalString(value.state) ||
    !optionalString(value.provider) ||
    !optionalString(value.team_role) ||
    !optionalBoolean(value.native) ||
    !optionalString(value.started_at) ||
    !optionalString(value.last_event_at) ||
    (value.elapsed_ms !== undefined && !nonNegativeInteger(value.elapsed_ms)) ||
    !Array.isArray(value.waiting_on) ||
    !Array.isArray(value.handoffs) ||
    !Array.isArray(value.children)
  ) {
    return undefined;
  }
  const waitingOn = value.waiting_on.map(parseWait);
  const handoffs = value.handoffs.map(parseHandoff);
  const children = value.children.map(parseTreeNode);
  if (
    !waitingOn.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !handoffs.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !children.every((entry): entry is NonNullable<typeof entry> => entry !== undefined)
  ) {
    return undefined;
  }
  return {
    id: value.id,
    type: value.type,
    label: value.label,
    ...(value.state !== undefined ? { state: value.state } : {}),
    ...(value.provider !== undefined ? { provider: value.provider } : {}),
    ...(value.team_role !== undefined ? { team_role: value.team_role } : {}),
    ...(value.native !== undefined ? { native: value.native } : {}),
    ...(value.started_at !== undefined ? { started_at: value.started_at } : {}),
    ...(value.last_event_at !== undefined ? { last_event_at: value.last_event_at } : {}),
    ...(value.elapsed_ms !== undefined ? { elapsed_ms: value.elapsed_ms as number } : {}),
    waiting_on: waitingOn,
    handoffs,
    children,
  };
}

function parseTreeWaitingEntry(
  value: unknown
): ClientCollaborationTree['waiting'][number] | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.node_id) ||
    typeof value.reason !== 'string' ||
    !WAIT_REASONS.has(value.reason) ||
    !nonEmptyString(value.since) ||
    !optionalString(value.target_id)
  ) {
    return undefined;
  }
  return {
    node_id: value.node_id,
    reason: value.reason as ClientCollaborationWaitReason,
    since: value.since,
    ...(value.target_id !== undefined ? { target_id: value.target_id } : {}),
  };
}

function parseTree(value: unknown): ClientCollaborationTree | undefined {
  if (
    !isRecord(value) ||
    !nonEmptyString(value.generated_at) ||
    !Array.isArray(value.roots) ||
    !Array.isArray(value.orphans) ||
    !Array.isArray(value.waiting) ||
    !isRecord(value.stats)
  ) {
    return undefined;
  }
  const roots = value.roots.map(parseTreeNode);
  const orphans = value.orphans.map(parseTreeNode);
  const waiting = value.waiting.map(parseTreeWaitingEntry);
  const statsKeys = [
    'missions',
    'tasks',
    'agents_total',
    'agents_running',
    'agents_waiting',
    'agents_done',
    'humans_waited_on',
  ] as const;
  if (
    !roots.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !orphans.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    !waiting.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    statsKeys.some((key) => !nonNegativeInteger(value.stats[key]))
  ) {
    return undefined;
  }
  return {
    generated_at: value.generated_at,
    roots,
    orphans,
    waiting,
    stats: Object.fromEntries(
      statsKeys.map((key) => [key, value.stats[key]])
    ) as ClientCollaborationTree['stats'],
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
    !Array.isArray(value.projection.attention) ||
    !isRecord(value.projection.tree)
  ) {
    return undefined;
  }
  const sequenceGaps = value.projection.sequence_gaps.map(parseSequenceGap);
  const events = value.projection.events.map(parseEvent);
  const attention = value.projection.attention.map(parseAttention);
  const tree = parseTree(value.projection.tree);
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
    !attention.every((entry): entry is NonNullable<typeof entry> => entry !== undefined) ||
    tree === undefined
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
    tree,
  };
}
