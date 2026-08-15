import { randomUUID } from 'node:crypto';
import { resolveCollaborationKind } from './event-vocabulary.js';
import {
  normalizeEventScope,
  redactEventScopeForShared,
  type EventScope,
  type EventScopeInput,
  type EventScopeKind,
} from './event-scope.js';

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
  organization_id?: string;
  project_id?: string;
  scope_kind?: EventScopeKind;
  /** Canonical scope envelope; flat fields remain for v1 readers. */
  scope?: EventScope;
  redaction: CollaborationRedaction;
  source: CollaborationSource;
}

export interface CollaborationEventInput extends Omit<
  AgentCollaborationEvent,
  'schema_version' | 'event_id' | 'related_ids' | 'evidence_refs' | 'scope'
> {
  event_id?: string;
  related_ids?: string[];
  evidence_refs?: string[];
  scope?: EventScopeInput;
}

const SENSITIVE_VALUE =
  /(?:api[_-]?key|token|password|secret|authorization|bearer)\s*[:=]\s*\S+/giu;

const SHARED_METADATA_KEYS = new Set([
  'action_id',
  'agent_id',
  'artifact_path',
  'causation_id',
  'channel',
  'correlation_id',
  'decision',
  'event_id',
  'event_type',
  'expires_at',
  'kind',
  'mission_id',
  'mission_type',
  'model_id',
  'native',
  'native_fork',
  'native_mode',
  'operation',
  'orchestration_status',
  'outcome',
  'phase',
  'pipeline_id',
  'planned_task_count',
  'policy_used',
  'project_id',
  'provider',
  'reason_code',
  'reason_category',
  'requested_by',
  'request_id',
  'resource_id',
  'runtime_status',
  'scope_kind',
  'session_id',
  'source',
  'scope',
  'state',
  'state_after',
  'state_before',
  'status',
  'summary',
  'surface',
  'surface_channel',
  'task_id',
  'team_role',
  'thread_ts',
  'tier',
  'trace_id',
  'turn_id',
  'title',
  'why',
  'work_item_id',
]);

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

/**
 * Shared event records are metadata projections, never arbitrary payload
 * mirrors. Keep only explicitly approved scalar fields and bound free text.
 */
export function redactCollaborationMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, candidate] of Object.entries(source)) {
    if (!SHARED_METADATA_KEYS.has(key)) continue;
    if (
      key === 'scope' &&
      candidate &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate)
    ) {
      try {
        output.scope = redactEventScopeForShared(candidate as EventScope);
      } catch {
        /* malformed scope metadata must not enter shared observability */
      }
    } else if (typeof candidate === 'string') {
      output[key] = ['decision', 'why', 'summary'].includes(key)
        ? redactCollaborationSummary(candidate, 'event received')
        : redactCollaborationSummary(candidate, '');
    } else if (typeof candidate === 'number' || typeof candidate === 'boolean') {
      output[key] = candidate;
    }
  }
  return output;
}

export function createAgentCollaborationEvent(
  input: CollaborationEventInput
): AgentCollaborationEvent {
  const hasScopeFields = Boolean(
    input.scope ||
    input.tier ||
    input.tenant_slug ||
    input.organization_id ||
    input.project_id ||
    input.scope_kind
  );
  const scope = hasScopeFields
    ? normalizeEventScope({
        ...(input.scope || {}),
        ...(input.tier ? { tier: input.tier } : {}),
        ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
        ...(input.organization_id ? { organization_id: input.organization_id } : {}),
        ...(input.project_id ? { project_id: input.project_id } : {}),
        ...(input.mission_id ? { mission_id: input.mission_id } : {}),
        ...(input.task_id ? { task_id: input.task_id } : {}),
        ...(input.session_id ? { session_id: input.session_id } : {}),
        ...(input.scope_kind ? { scope_kind: input.scope_kind } : {}),
      })
    : undefined;
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
    ...(scope?.tier ? { tier: scope.tier } : {}),
    ...(scope?.tenant_slug ? { tenant_slug: scope.tenant_slug } : {}),
    ...(scope?.organization_id ? { organization_id: scope.organization_id } : {}),
    ...(scope?.project_id ? { project_id: scope.project_id } : {}),
    ...(scope?.scope_kind ? { scope_kind: scope.scope_kind } : {}),
    ...(scope ? { scope } : {}),
    redaction: input.redaction,
    source: input.source,
  };
}

/**
 * EV-07: resolve an event name to a collaboration kind.
 *
 * The mapping lives in `event-vocabulary.ts`, which holds an exhaustive
 * per-vocabulary table (so adding a worker/orchestration/task event type fails
 * the build until its meaning is declared) plus anchored inference for the
 * open-ended `decision` strings. This function stays as the projection's entry
 * point; it is a re-export in behaviour, kept for call-site stability.
 */
export function collaborationKindFromEventType(eventType: unknown): CollaborationKind {
  return resolveCollaborationKind(eventType);
}
