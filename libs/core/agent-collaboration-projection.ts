import * as path from 'node:path';
import { pathResolver, findMissionPath } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir } from './secure-io.js';
import {
  collaborationKindFromEventType,
  createAgentCollaborationEvent,
  redactCollaborationSummary,
  type AgentCollaborationEvent,
  type CollaborationKind,
  type CollaborationSource,
} from './agent-collaboration-events.js';

type JsonRecord = Record<string, unknown>;

export interface CollaborationGraphNode {
  id: string;
  type: 'mission' | 'task' | 'agent' | 'artifact' | 'human' | 'system';
  label: string;
  state?: string;
}

export interface CollaborationGraphEdge {
  from: string;
  to: string;
  kind: CollaborationKind;
  event_id: string;
}

export interface CollaborationAttentionItem {
  event_id: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  kind: CollaborationKind;
  title: string;
  reason: string;
  next_action: string;
}

export type CollaborationStatusFlag = 'sequence_gap' | 'unknown_event' | 'stale_runtime';

export interface CollaborationSequenceGap {
  source: CollaborationSource;
  previous_seq: number;
  expected_seq: number;
  actual_seq: number;
}

export interface AgentCollaborationProjection {
  generated_at: string;
  cursor: string | null;
  partial: boolean;
  status_flags: CollaborationStatusFlag[];
  sequence_gaps: CollaborationSequenceGap[];
  sources: string[];
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
  };
  events: AgentCollaborationEvent[];
  nodes: CollaborationGraphNode[];
  edges: CollaborationGraphEdge[];
  attention: CollaborationAttentionItem[];
}

export interface ComposeCollaborationProjectionOptions {
  missionId?: string;
  tenant?: string;
  limit?: number;
  now?: string;
  staleAfterMs?: number;
}

const OBSERVABILITY_DIR = pathResolver.shared('observability/mission-control');
const WORKER_EVENTS_DIR = pathResolver.shared('logs/worker-events');
const JSONL_SOURCES: Array<{ file: string; source: CollaborationSource }> = [
  { file: 'task-events.jsonl', source: 'task' },
  { file: 'orchestration-events.jsonl', source: 'orchestration' },
  { file: 'agent-runtime-supervisor-events.jsonl', source: 'runtime' },
];

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readJsonl(filePath: string): JsonRecord[] {
  if (!safeExistsSync(filePath)) return [];
  try {
    return String(safeReadFile(filePath, { encoding: 'utf8' }) || '')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = asRecord(JSON.parse(line));
          return value ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function readJsonRecord(filePath: string): JsonRecord | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return asRecord(JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))));
  } catch {
    return null;
  }
}

function stringValue(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function stringArray(record: JsonRecord, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function eventFromRecord(
  record: JsonRecord,
  source: CollaborationSource,
  seq: number
): AgentCollaborationEvent {
  const payload = asRecord(record.payload) || {};
  const eventType = stringValue(record, 'event_type', 'type', 'decision') || 'unknown';
  const sourceEventId =
    stringValue(record, 'event_id', 'source_event_id', 'request_id') || `${source}:${seq}`;
  const missionId = stringValue(record, 'mission_id')?.toUpperCase();
  const taskId = stringValue(record, 'task_id');
  const agentId = stringValue(record, 'agent_id', 'requested_by', 'actor_id');
  const evidence = stringArray(record, 'evidence');
  const relatedIds = [
    ...stringArray(record, 'related_ids'),
    ...[stringValue(record, 'correlation_id'), stringValue(record, 'causation_id')].filter(
      (value): value is string => Boolean(value)
    ),
  ];
  const kind = collaborationKindFromEventType(eventType);
  const summary =
    stringValue(record, 'summary', 'why', 'decision', 'event_type', 'type') ||
    stringValue(payload, 'summary', 'op', 'status') ||
    `${source} event`;
  const actorType =
    source === 'task' || source === 'runtime' || source === 'a2a' ? 'agent' : 'system';
  return createAgentCollaborationEvent({
    event_id: `${sourceEventId}:${source}`,
    source_event_id: sourceEventId,
    ts: stringValue(record, 'ts', 'created_at') || new Date(0).toISOString(),
    seq: Number(stringValue(record, 'seq')) || seq,
    ...(missionId ? { mission_id: missionId } : {}),
    ...(taskId ? { task_id: taskId } : {}),
    ...(agentId ? { agent_id: agentId } : {}),
    ...(stringValue(record, 'parent_agent_id')
      ? { parent_agent_id: stringValue(record, 'parent_agent_id') }
      : {}),
    ...(stringValue(record, 'session_id') ? { session_id: stringValue(record, 'session_id') } : {}),
    actor_type: actorType,
    kind,
    ...(stringValue(record, 'state_before')
      ? { state_before: stringValue(record, 'state_before') }
      : {}),
    ...(stringValue(record, 'state_after', 'status')
      ? { state_after: stringValue(record, 'state_after', 'status') }
      : {}),
    ...(stringValue(record, 'reason_code')
      ? { reason_code: stringValue(record, 'reason_code') }
      : {}),
    summary: redactCollaborationSummary(summary, `${source} event`),
    ...(stringValue(record, 'correlation_id')
      ? { correlation_id: stringValue(record, 'correlation_id') }
      : {}),
    ...(stringValue(record, 'causation_id')
      ? { causation_id: stringValue(record, 'causation_id') }
      : {}),
    related_ids: relatedIds,
    evidence_refs: evidence,
    redaction: evidence.length > 0 ? 'reference_only' : 'summary',
    source,
  });
}

function readWorkerEvents(): AgentCollaborationEvent[] {
  if (!safeExistsSync(WORKER_EVENTS_DIR)) return [];
  const files: string[] = [];
  for (const entry of safeReaddir(WORKER_EVENTS_DIR)) {
    const entryPath = path.join(WORKER_EVENTS_DIR, entry);
    if (entry.endsWith('.jsonl')) files.push(entryPath);
    if (entry === 'missions' && safeExistsSync(entryPath)) {
      for (const mission of safeReaddir(entryPath)) {
        const missionPath = path.join(entryPath, mission);
        for (const file of safeReaddir(missionPath)) {
          if (file.endsWith('.jsonl')) files.push(path.join(missionPath, file));
        }
      }
    }
  }
  return files.flatMap((file, fileIndex) =>
    readJsonl(file).map((record, index) => {
      const source = asRecord(record.source) || {};
      const payload = asRecord(record.payload) || {};
      return eventFromRecord(
        {
          ...record,
          mission_id: record.mission_id || source.mission_id,
          task_id: record.task_id || source.task_id,
          agent_id: record.agent_id || source.agent_id,
          event_type: record.type,
          summary: stringValue(payload, 'summary', 'op', 'status', 'reason') || record.type,
          seq: record.seq,
        },
        'worker',
        fileIndex * 100000 + index
      );
    })
  );
}

function readSourceEvents(): AgentCollaborationEvent[] {
  const events = JSONL_SOURCES.flatMap(({ file, source }) =>
    readJsonl(path.join(OBSERVABILITY_DIR, file)).map((record, index) =>
      eventFromRecord(record, source, index)
    )
  );
  return [...events, ...readWorkerEvents()];
}

function readMissionTenant(missionId: string): string | undefined {
  const missionPath = findMissionPath(missionId);
  if (!missionPath) return undefined;
  const statePath = path.join(missionPath, 'mission-state.json');
  return stringValue(readJsonRecord(statePath) || {}, 'tenant_slug', 'tenant_id');
}

function eventMatches(
  event: AgentCollaborationEvent,
  options: ComposeCollaborationProjectionOptions
): boolean {
  if (options.missionId && event.mission_id !== options.missionId.toUpperCase()) return false;
  if (options.tenant && event.mission_id && readMissionTenant(event.mission_id) !== options.tenant)
    return false;
  return true;
}

function addNode(
  nodes: Map<string, CollaborationGraphNode>,
  id: string | undefined,
  type: CollaborationGraphNode['type'],
  label: string,
  state?: string
): void {
  if (!id) return;
  const existing = nodes.get(id);
  nodes.set(id, { id, type, label: existing?.label || label, state: state || existing?.state });
}

function attentionForEvent(event: AgentCollaborationEvent): CollaborationAttentionItem | null {
  if (event.kind === 'blocked') {
    return {
      event_id: event.event_id,
      mission_id: event.mission_id,
      task_id: event.task_id,
      agent_id: event.agent_id,
      kind: event.kind,
      title: 'ブロック中',
      reason: event.summary,
      next_action: '原因を確認して入力・依存タスク・担当を解消',
    };
  }
  if (event.kind === 'approval') {
    return {
      event_id: event.event_id,
      mission_id: event.mission_id,
      task_id: event.task_id,
      agent_id: event.agent_id,
      kind: event.kind,
      title: '人間の承認待ち',
      reason: event.summary,
      next_action: '承認キューで対象と影響範囲を確認',
    };
  }
  if (event.kind === 'review') {
    return {
      event_id: event.event_id,
      mission_id: event.mission_id,
      task_id: event.task_id,
      agent_id: event.agent_id,
      kind: event.kind,
      title: 'レビュー待ち',
      reason: event.summary,
      next_action: '成果物と evidence ref をレビュー',
    };
  }
  if (event.kind === 'failure') {
    return {
      event_id: event.event_id,
      mission_id: event.mission_id,
      task_id: event.task_id,
      agent_id: event.agent_id,
      kind: event.kind,
      title: '失敗',
      reason: event.summary,
      next_action: '失敗分類と再実行条件を確認',
    };
  }
  return null;
}

function statusFromEvents(
  events: AgentCollaborationEvent[],
  options: ComposeCollaborationProjectionOptions
): { flags: CollaborationStatusFlag[]; gaps: CollaborationSequenceGap[] } {
  const gaps: CollaborationSequenceGap[] = [];
  for (const source of new Set(events.map((event) => event.source))) {
    // Worker events are partitioned across mission/agent JSONL files. Their
    // numeric sequence is only meaningful inside each file, so comparing all
    // worker files as one stream would manufacture false gaps at file bounds.
    if (source === 'worker') continue;
    const sourceEvents = events
      .filter((event) => event.source === source)
      .slice()
      .sort((left, right) => left.seq - right.seq);
    for (let index = 1; index < sourceEvents.length; index += 1) {
      const previous = sourceEvents[index - 1];
      const current = sourceEvents[index];
      if (current.seq > previous.seq + 1) {
        gaps.push({
          source,
          previous_seq: previous.seq,
          expected_seq: previous.seq + 1,
          actual_seq: current.seq,
        });
      }
    }
  }

  const flags = new Set<CollaborationStatusFlag>();
  if (events.some((event) => event.kind === 'unknown')) flags.add('unknown_event');
  if (gaps.length > 0) flags.add('sequence_gap');

  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  const now = Date.parse(options.now || new Date().toISOString());
  const latestRuntime = events
    .filter((event) => event.source === 'runtime')
    .slice()
    .sort((left, right) => left.ts.localeCompare(right.ts))
    .at(-1);
  const runtimeState = latestRuntime?.state_after?.toLowerCase();
  const runtimeIsActive =
    runtimeState && ['active', 'busy', 'started', 'running', 'progress'].includes(runtimeState);
  if (latestRuntime && runtimeIsActive && Number.isFinite(now)) {
    const runtimeAt = Date.parse(latestRuntime.ts);
    if (Number.isFinite(runtimeAt) && now - runtimeAt > staleAfterMs) flags.add('stale_runtime');
  }
  return { flags: [...flags].sort(), gaps };
}

export function composeAgentCollaborationProjection(
  input: AgentCollaborationEvent[],
  options: ComposeCollaborationProjectionOptions = {}
): AgentCollaborationProjection {
  const limit = Math.max(1, Math.min(options.limit || 100, 500));
  const deduped = new Map<string, AgentCollaborationEvent>();
  for (const event of input.filter((event) => eventMatches(event, options))) {
    deduped.set(`${event.source}:${event.source_event_id}`, event);
  }
  const events = [...deduped.values()]
    .sort(
      (left, right) =>
        left.ts.localeCompare(right.ts) || left.event_id.localeCompare(right.event_id)
    )
    .slice(-limit);
  const status = statusFromEvents(events, options);
  const nodes = new Map<string, CollaborationGraphNode>();
  const edges: CollaborationGraphEdge[] = [];
  const attention: CollaborationAttentionItem[] = [];
  const missions = new Set<string>();
  const tasks = new Set<string>();
  const agents = new Set<string>();
  let active = 0;
  let blocked = 0;
  let waitingHuman = 0;
  let reviewPending = 0;
  let failures = 0;
  for (const event of events) {
    if (event.mission_id) {
      missions.add(event.mission_id);
      addNode(nodes, `mission:${event.mission_id}`, 'mission', event.mission_id, event.state_after);
    }
    if (event.task_id) {
      tasks.add(event.task_id);
      addNode(nodes, `task:${event.task_id}`, 'task', event.task_id, event.state_after);
    }
    if (event.agent_id && event.actor_type !== 'human') {
      agents.add(event.agent_id);
      addNode(nodes, `agent:${event.agent_id}`, 'agent', event.agent_id, event.state_after);
    }
    if (event.actor_type === 'human')
      addNode(
        nodes,
        `human:${event.agent_id || 'operator'}`,
        'human',
        event.agent_id || 'operator'
      );
    if (event.mission_id && event.task_id)
      edges.push({
        from: `mission:${event.mission_id}`,
        to: `task:${event.task_id}`,
        kind: event.kind,
        event_id: event.event_id,
      });
    if (event.task_id && event.agent_id)
      edges.push({
        from: `task:${event.task_id}`,
        to: `agent:${event.agent_id}`,
        kind: event.kind,
        event_id: event.event_id,
      });
    if (
      event.kind === 'progress' ||
      event.kind === 'dispatch' ||
      event.kind === 'claim' ||
      event.kind === 'spawn'
    )
      active += 1;
    if (event.kind === 'blocked') blocked += 1;
    if (event.kind === 'approval' || event.kind === 'waiting') waitingHuman += 1;
    if (event.kind === 'review') reviewPending += 1;
    if (event.kind === 'failure') failures += 1;
    const attentionItem = attentionForEvent(event);
    if (attentionItem) attention.push(attentionItem);
  }
  return {
    generated_at: options.now || new Date().toISOString(),
    cursor: events.at(-1)?.event_id || null,
    partial: status.flags.length > 0,
    status_flags: status.flags,
    sequence_gaps: status.gaps,
    sources: [...new Set(events.map((event) => event.source))].sort(),
    overview: {
      events: events.length,
      missions: missions.size,
      tasks: tasks.size,
      agents: agents.size,
      active,
      blocked,
      waiting_human: waitingHuman,
      review_pending: reviewPending,
      failures,
    },
    events: events.slice().reverse(),
    nodes: [...nodes.values()],
    edges,
    attention: attention.slice(-50).reverse(),
  };
}

export function buildAgentCollaborationProjection(
  options: ComposeCollaborationProjectionOptions = {}
): AgentCollaborationProjection {
  return composeAgentCollaborationProjection(readSourceEvents(), options);
}
