import { randomUUID } from 'node:crypto';

export const AGENT_COLLABORATION_SCHEMA_VERSION = 'agent-collaboration-event.v1' as const;

export type CollaborationActorType = 'human' | 'agent' | 'surface' | 'system';
export type CollaborationKind =
  | 'dispatch'
  | 'claim'
  | 'spawn'
  | 'progress'
  | 'waiting'
  | 'blocked'
  | 'handoff'
  | 'approval'
  | 'review'
  | 'artifact'
  | 'retry'
  | 'failure'
  | 'completion'
  | 'unknown';
export type CollaborationSource =
  'mission' | 'task' | 'worker' | 'orchestration' | 'a2a' | 'trace' | 'surface' | 'runtime';
export type CollaborationRedaction = 'summary' | 'reference_only' | 'redacted';

export interface AgentCollaborationEvent {
  schema_version: typeof AGENT_COLLABORATION_SCHEMA_VERSION;
  event_id: string;
  source_event_id: string;
  ts: string;
  seq: number;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  parent_agent_id?: string;
  session_id?: string;
  provider?: string;
  adopter_id?: string;
  thread_id?: string;
  parent_thread_id?: string;
  turn_id?: string;
  native?: boolean;
  native_fork?: boolean;
  native_mode?: string;
  effort?: 'low' | 'medium' | 'high' | 'ultra';
  native_unavailable?: boolean;
  actor_type: CollaborationActorType;
  kind: CollaborationKind;
  state_before?: string;
  state_after?: string;
  reason_code?: string;
  summary: string;
  correlation_id?: string;
  causation_id?: string;
  related_ids: string[];
  evidence_refs: string[];
  tier?: 'personal' | 'confidential' | 'public';
  tenant_slug?: string;
  redaction: CollaborationRedaction;
  source: CollaborationSource;
}

export interface CollaborationEventInput extends Omit<
  AgentCollaborationEvent,
  'schema_version' | 'event_id' | 'related_ids' | 'evidence_refs'
> {
  event_id?: string;
  related_ids?: string[];
  evidence_refs?: string[];
}

const SENSITIVE_VALUE =
  /(?:api[_-]?key|token|password|secret|authorization|bearer)\s*[:=]\s*\S+/giu;

/** Keep the shared collaboration projection human-readable without copying raw payloads. */
export function redactCollaborationSummary(
  value: unknown,
  fallback = 'イベントを受信しました'
): string {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim();
  if (!text) return fallback;
  const redacted = text.replace(SENSITIVE_VALUE, '[redacted]');
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
}

export function createAgentCollaborationEvent(
  input: CollaborationEventInput
): AgentCollaborationEvent {
  return {
    schema_version: AGENT_COLLABORATION_SCHEMA_VERSION,
    event_id: input.event_id || `ACE-${randomUUID()}`,
    source_event_id: input.source_event_id,
    ts: input.ts,
    seq: input.seq,
    ...(input.mission_id ? { mission_id: input.mission_id } : {}),
    ...(input.task_id ? { task_id: input.task_id } : {}),
    ...(input.agent_id ? { agent_id: input.agent_id } : {}),
    ...(input.parent_agent_id ? { parent_agent_id: input.parent_agent_id } : {}),
    ...(input.session_id ? { session_id: input.session_id } : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.adopter_id ? { adopter_id: input.adopter_id } : {}),
    ...(input.thread_id ? { thread_id: input.thread_id } : {}),
    ...(input.parent_thread_id ? { parent_thread_id: input.parent_thread_id } : {}),
    ...(input.turn_id ? { turn_id: input.turn_id } : {}),
    ...(input.native !== undefined ? { native: input.native } : {}),
    ...(input.native_fork !== undefined ? { native_fork: input.native_fork } : {}),
    ...(input.native_mode ? { native_mode: input.native_mode } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.native_unavailable !== undefined
      ? { native_unavailable: input.native_unavailable }
      : {}),
    actor_type: input.actor_type,
    kind: input.kind,
    ...(input.state_before ? { state_before: input.state_before } : {}),
    ...(input.state_after ? { state_after: input.state_after } : {}),
    ...(input.reason_code ? { reason_code: input.reason_code } : {}),
    summary: redactCollaborationSummary(input.summary),
    ...(input.correlation_id ? { correlation_id: input.correlation_id } : {}),
    ...(input.causation_id ? { causation_id: input.causation_id } : {}),
    related_ids: [...new Set(input.related_ids || [])],
    evidence_refs: [...new Set(input.evidence_refs || [])],
    ...(input.tier ? { tier: input.tier } : {}),
    ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
    redaction: input.redaction,
    source: input.source,
  };
}

export function collaborationKindFromEventType(eventType: unknown): CollaborationKind {
  const type = String(eventType || '').toLowerCase();
  if (type.includes('subagent_unavailable')) return 'failure';
  if (type.includes('subagent')) return 'spawn';
  if (type.includes('dispatch') || type.includes('issue')) return 'dispatch';
  if (type.includes('claim') || type.includes('lease')) return 'claim';
  if (type.includes('spawn') || type.includes('prewarm') || type.includes('runtime'))
    return 'spawn';
  if (type.includes('submit') || type.includes('artifact')) return 'artifact';
  if (type.includes('review') || type.includes('accept')) return 'review';
  if (type.includes('approval')) return 'approval';
  if (type.includes('handoff')) return 'handoff';
  if (type.includes('retry') || type.includes('reconcile')) return 'retry';
  if (type.includes('fail') || type.includes('error')) return 'failure';
  if (type.includes('complete') || type.includes('finish') || type.includes('success'))
    return 'completion';
  if (type.includes('wait') || type.includes('pending')) return 'waiting';
  if (type.includes('block')) return 'blocked';
  if (type.includes('step') || type.includes('progress') || type.includes('turn'))
    return 'progress';
  return 'unknown';
}
