import * as path from 'node:path';
import { readJsonLines, parseSafeJsonInput } from './foundation/json.js';
import { clamp } from './foundation/text.js';
import { nowIso } from './foundation/time.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeReadFileTail,
} from './secure-io.js';
import { splitCompleteLines } from './jsonl-tail.js';
import {
  collaborationKindFromEventType,
  createAgentCollaborationEvent,
  redactCollaborationSummary,
  type AgentCollaborationEvent,
  type CollaborationKind,
  type CollaborationSource,
} from './agent-collaboration-events.js';
import { listSupervisorEventFiles } from './agent-runtime-events.js';
import { listPeerConversationTenants, readPeerConversationEdges } from './peer-conversation.js';
import { eventScopeMatches, type EventScopeFilter } from './event-scope.js';
import { resolveScopeForRecord } from './scope-migration.js';
import type { GraphRunArtifact } from './graph-run-artifact.js';

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

/**
 * AC-09: closed enumeration of why an event needs attention. `title` and
 * `next_action` below are developer-facing English; every user-facing surface
 * translates from this code through its own vocabulary instead of rendering
 * core's strings.
 */
export type CollaborationAttentionCode = 'blocked' | 'waiting_human' | 'review_pending' | 'failure';

export interface CollaborationAttentionItem {
  event_id: string;
  mission_id?: string;
  task_id?: string;
  agent_id?: string;
  kind: CollaborationKind;
  code: CollaborationAttentionCode;
  title: string;
  reason: string;
  next_action: string;
}

export type CollaborationStatusFlag =
  'sequence_gap' | 'unknown_event' | 'stale_runtime' | 'bounded_read';

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
  /**
   * Basenames of source files a bounded read truncated to their byte cap
   * (AC-03). Populated by `buildAgentCollaborationProjection`; always `[]`
   * for a direct `composeAgentCollaborationProjection` call, since compose
   * never touches the filesystem.
   */
  truncated_sources: string[];
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
  events: AgentCollaborationEvent[];
  nodes: CollaborationGraphNode[];
  edges: CollaborationGraphEdge[];
  attention: CollaborationAttentionItem[];
}

/** AC-03: byte-capped, recent-window read of the on-disk JSONL sources. */
export interface CollaborationBoundedReadOptions {
  /** Byte cap applied to the tail of each source file. Default 2MiB. */
  maxBytesPerFile?: number;
  /** Worker-event dated files (`worker-events-YYYY-MM-DD.jsonl`) older than
   * this many days (relative to `options.now`) are skipped entirely. Default 2. */
  recentDays?: number;
  /** step_begin/step_end/turn_begin/turn_end are ~95% of worker-event
   * volume and carry no collaboration semantics; excluded by default. */
  includeStepEvents?: boolean;
}

export interface ComposeCollaborationProjectionOptions {
  missionId?: string;
  tenant?: string;
  tenantSlugs?: string[] | 'all';
  /** Additional entity narrowing; never expands the viewer tenant scope. */
  scopeFilter?: Omit<EventScopeFilter, 'tenant_slug' | 'tenant_slugs'>;
  limit?: number;
  now?: string;
  staleAfterMs?: number;
  /** Optional pipeline DAG artifact projected into the operator graph. */
  runGraph?: GraphRunArtifact;
  /**
   * AC-03: bound the on-disk read `buildAgentCollaborationProjection` performs.
   * Omitted = bounded with defaults (2MiB/file, last 2 days of worker-event
   * files, step events excluded). `false` = legacy unbounded full read.
   * Only `buildAgentCollaborationProjection` consults this; it has no effect
   * on `composeAgentCollaborationProjection`, which never does I/O.
   */
  bounded?: false | CollaborationBoundedReadOptions;
  /**
   * Test/diagnostic override for the on-disk roots `buildAgentCollaborationProjection`
   * reads from. Production callers must not pass this — it exists so tests can
   * point at an isolated fixture directory instead of writing into the real,
   * potentially large (29MB+), shared observability files that other suites
   * and processes read concurrently. Each override path is re-validated
   * through `safeOptionalRepositoryPath` and silently falls back to the real
   * root if it would resolve outside the repository. Only
   * `buildAgentCollaborationProjection` consults this.
   */
  roots?: { observabilityDir?: string; workerEventsDir?: string };
  /**
   * Exclude events whose `ts` is older than this ISO instant. Set by
   * `buildAgentCollaborationProjection` from `bounded.recentDays` so the recent
   * window applies to single unrotated files (orchestration-events.jsonl holds
   * months of history) and not only to dated worker-event files.
   */
  since?: string;
}

/**
 * Lifecycle / telemetry records that carry no collaboration semantics and, in
 * a real repository, dominate the newest slice of every source: worker
 * step/turn heartbeats and the 30-second `a2a_inflight_metric` samples of the
 * runtime supervisor. Dropped before composition unless `includeStepEvents`.
 */
const NOISE_EVENT_NAMES = new Set(['step_begin', 'step_end', 'turn_begin', 'turn_end']);
function isCollaborationNoise(record: JsonRecord): boolean {
  const name = stringValue(record, 'type', 'decision', 'event_type', 'event');
  if (!name) return false;
  return NOISE_EVENT_NAMES.has(name) || /_metric$|_heartbeat$/u.test(name);
}

const DEFAULT_BOUNDED_READ: Required<CollaborationBoundedReadOptions> = {
  maxBytesPerFile: 2 * 1024 * 1024,
  recentDays: 2,
  includeStepEvents: false,
};

function resolveBoundedReadOptions(
  bounded: ComposeCollaborationProjectionOptions['bounded']
): Required<CollaborationBoundedReadOptions> | null {
  if (bounded === false) return null;
  return { ...DEFAULT_BOUNDED_READ, ...(bounded || {}) };
}

/**
 * Resolve a `roots` override (test/diagnostic only, see
 * `ComposeCollaborationProjectionOptions.roots`). Routed through
 * `safeOptionalRepositoryPath` so a caller cannot point the reader outside the
 * repository; an override that fails that check is silently ignored in favour
 * of the real default root rather than allowed through unchecked.
 */
function resolveRootDir(overridePath: string | undefined, defaultDir: string): string {
  if (!overridePath) return defaultDir;
  return safeOptionalRepositoryPath(overridePath) ?? defaultDir;
}

const OBSERVABILITY_DIR = pathResolver.shared('observability/mission-control');
const WORKER_EVENTS_DIR = pathResolver.shared('logs/worker-events');
const WORKER_DATED_FILE_PATTERN = /^worker-events-(\d{4}-\d{2}-\d{2})\.jsonl$/u;
/**
 * Single-file mission-control sources. The supervisor stream is *not* here:
 * AC-10 rotates it daily, so its partitions are enumerated through
 * `listSupervisorEventFiles` in `readSourceEvents` instead of a fixed name.
 */
const JSONL_SOURCES: Array<{ file: string; source: CollaborationSource }> = [
  { file: 'task-events.jsonl', source: 'task' },
  { file: 'orchestration-events.jsonl', source: 'orchestration' },
  { file: 'agent-runtime-events.jsonl', source: 'runtime' },
];

function safeOptionalRepositoryPath(filePath: string): string | undefined {
  try {
    return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  } catch {
    return undefined;
  }
}

function toRecordOrNull(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function readJsonl(filePath: string): JsonRecord[] {
  const safePath = safeOptionalRepositoryPath(filePath);
  if (!safePath || !safeExistsSync(safePath)) return [];
  if (!safeLstat(safePath).isFile()) return [];
  try {
    return readJsonLines<JsonRecord | null>(safePath, {
      onMalformed: 'skip',
      map: (value) => toRecordOrNull(value),
    }).filter((value): value is JsonRecord => value !== null);
  } catch {
    return [];
  }
}

/**
 * AC-03/AC-08: read at most `maxBytesPerFile` from the end of `filePath`.
 *
 * `safeReadFileTail` opens the file and seeks to `size - maxBytes`, so a 29MB
 * supervisor log costs one `maxBytes` read instead of loading the whole file
 * to slice its tail in memory. When the read was truncated, the first line in
 * the window is a fragment of whatever preceded the byte cut and is dropped;
 * a trailing fragment (no closing newline) is dropped the same way via
 * `splitCompleteLines`. An untruncated read starts at byte 0, so its first
 * line is whole and is kept.
 */
function readJsonlBounded(
  filePath: string,
  maxBytesPerFile: number
): { records: JsonRecord[]; truncated: boolean } {
  const safePath = safeOptionalRepositoryPath(filePath);
  if (!safePath || !safeExistsSync(safePath)) return { records: [], truncated: false };
  try {
    const { buffer, truncated } = safeReadFileTail(safePath, maxBytesPerFile);
    const text = buffer.toString('utf8');
    const firstNewline = truncated ? text.indexOf('\n') : -1;
    const body = truncated ? (firstNewline >= 0 ? text.slice(firstNewline + 1) : '') : text;
    const { lines } = splitCompleteLines(body);
    const records: JsonRecord[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = toRecordOrNull(parseSafeJsonInput(line, 'bounded jsonl tail entry'));
        if (record) records.push(record);
      } catch {
        /* a torn or malformed tail line must not stop the rest of the batch */
      }
    }
    return { records, truncated };
  } catch {
    return { records: [], truncated: false };
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

function booleanValue(record: JsonRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'boolean') return record[key] as boolean;
  }
  return undefined;
}

function eventFromRecord(
  record: JsonRecord,
  source: CollaborationSource,
  seq: number
): AgentCollaborationEvent | null {
  const payload = toRecordOrNull(record.payload) || {};
  const eventType = stringValue(record, 'event_type', 'type', 'decision', 'event') || 'unknown';
  const sourceEventId =
    stringValue(record, 'event_id', 'source_event_id', 'request_id') || `${source}:${seq}`;
  const missionId = stringValue(record, 'mission_id')?.toUpperCase();
  const taskId = stringValue(record, 'task_id');
  const scopeResult = resolveScopeForRecord({
    ...record,
    ...(missionId ? { mission_id: missionId } : {}),
  });
  if (scopeResult.disposition === 'invalid') return null;
  const migratedScope = scopeResult.scope;
  if (
    migratedScope &&
    ((missionId &&
      migratedScope.mission_id &&
      missionId !== migratedScope.mission_id.toUpperCase()) ||
      (taskId && migratedScope.task_id && taskId !== migratedScope.task_id))
  ) {
    return null;
  }
  const agentId = stringValue(record, 'agent_id', 'requested_by', 'actor_id');
  const provider = stringValue(record, 'provider') || stringValue(payload, 'provider');
  const adopterId = stringValue(record, 'adopter_id') || stringValue(payload, 'adopter_id');
  const threadId = stringValue(record, 'thread_id') || stringValue(payload, 'thread_id');
  const parentThreadId =
    stringValue(record, 'parent_thread_id') || stringValue(payload, 'parent_thread_id');
  const turnId = stringValue(record, 'turn_id') || stringValue(payload, 'turn_id');
  const native = booleanValue(record, 'native') ?? booleanValue(payload, 'native');
  const nativeFork = booleanValue(record, 'native_fork') ?? booleanValue(payload, 'native_fork');
  const nativeMode = stringValue(record, 'native_mode') || stringValue(payload, 'native_mode');
  const effort = stringValue(record, 'effort') || stringValue(payload, 'effort');
  const nativeUnavailable =
    eventType.toLowerCase().includes('subagent_unavailable') ||
    booleanValue(record, 'native_unavailable') === true ||
    booleanValue(payload, 'native_unavailable') === true;
  // AC-02: a2a envelope + delegation correlation fields, carried through from
  // either the flat record (orchestration-events.jsonl) or a nested worker
  // event payload (readWorkerEvents lifts source.* but leaves payload.* to be
  // read here, same as thread_id/native above).
  const parentAgentId =
    stringValue(record, 'parent_agent_id') || stringValue(payload, 'parent_agent_id');
  const sender = stringValue(record, 'sender') || stringValue(payload, 'sender');
  const receiver = stringValue(record, 'receiver') || stringValue(payload, 'receiver');
  const performative = stringValue(record, 'performative') || stringValue(payload, 'performative');
  const delegationId =
    stringValue(record, 'delegation_id') || stringValue(payload, 'delegation_id');
  const teamRole = stringValue(record, 'team_role') || stringValue(payload, 'team_role');
  const instructionSummary =
    stringValue(record, 'instruction_summary') || stringValue(payload, 'instruction_summary');
  // AC-04: approval correlation keys. Worker envelopes keep both inside
  // `payload`, so the flat record read has to fall through to it.
  const requestId = stringValue(record, 'request_id') || stringValue(payload, 'request_id');
  const channel = stringValue(record, 'channel') || stringValue(payload, 'channel');
  const elapsedMsRaw = record.elapsed_ms ?? payload.elapsed_ms;
  const elapsedMs = typeof elapsedMsRaw === 'number' ? elapsedMsRaw : undefined;
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
    ...(parentAgentId ? { parent_agent_id: parentAgentId } : {}),
    ...(sender ? { sender } : {}),
    ...(receiver ? { receiver } : {}),
    ...(performative ? { performative } : {}),
    ...(delegationId ? { delegation_id: delegationId } : {}),
    ...(teamRole ? { team_role: teamRole } : {}),
    ...(instructionSummary ? { instruction_summary: instructionSummary } : {}),
    ...(elapsedMs !== undefined ? { elapsed_ms: elapsedMs } : {}),
    ...(stringValue(record, 'session_id') ? { session_id: stringValue(record, 'session_id') } : {}),
    ...(provider ? { provider } : {}),
    ...(adopterId ? { adopter_id: adopterId } : {}),
    ...(threadId ? { thread_id: threadId } : {}),
    ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
    ...(turnId ? { turn_id: turnId } : {}),
    ...(native !== undefined ? { native } : {}),
    ...(nativeFork !== undefined ? { native_fork: nativeFork } : {}),
    ...(nativeMode ? { native_mode: nativeMode } : {}),
    ...(effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'ultra'
      ? { effort }
      : {}),
    ...(nativeUnavailable ? { native_unavailable: true } : {}),
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
    ...(requestId ? { request_id: requestId } : {}),
    ...(channel ? { channel } : {}),
    related_ids: relatedIds,
    evidence_refs: evidence,
    redaction: evidence.length > 0 ? 'reference_only' : 'summary',
    source,
    ...(migratedScope ? { scope: migratedScope } : {}),
  });
}

/** AC-03: is a `worker-events-YYYY-MM-DD.jsonl` date within `recentDays` of `now` (inclusive)? */
function isWorkerFileWithinRecentDays(
  dateStr: string,
  nowIsoValue: string,
  recentDays: number
): boolean {
  const fileDayMs = Date.parse(`${dateStr}T00:00:00.000Z`);
  const nowMs = Date.parse(nowIsoValue);
  if (!Number.isFinite(fileDayMs) || !Number.isFinite(nowMs)) return true;
  const nowDayMs = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const diffDays = Math.round((nowDayMs - fileDayMs) / 86_400_000);
  return diffDays >= 0 && diffDays <= recentDays;
}

interface ReadResult {
  events: AgentCollaborationEvent[];
  truncatedSources: string[];
}

function readWorkerEvents(
  bound: Required<CollaborationBoundedReadOptions> | null,
  nowIsoValue: string,
  workerEventsDir: string,
  missionScopeId?: string
): ReadResult {
  const safeWorkerEventsDir = safeOptionalRepositoryPath(workerEventsDir);
  if (!safeWorkerEventsDir || !safeExistsSync(safeWorkerEventsDir)) {
    return { events: [], truncatedSources: [] };
  }
  const scopedMissionUpper = missionScopeId?.trim().toUpperCase();
  const files: string[] = [];
  for (const entry of safeReaddir(safeWorkerEventsDir)) {
    const entryPath = safeOptionalRepositoryPath(path.join(safeWorkerEventsDir, entry));
    if (!entryPath) continue;
    if (entry.endsWith('.jsonl')) {
      // Only dated `worker-events-YYYY-MM-DD.jsonl` files are subject to the
      // recent-window filter; other worker-event files (legacy or
      // mission-scoped, handled below) have no date in their name to filter on.
      const dated = WORKER_DATED_FILE_PATTERN.exec(entry);
      if (
        bound &&
        dated &&
        !isWorkerFileWithinRecentDays(dated[1], nowIsoValue, bound.recentDays)
      ) {
        continue;
      }
      files.push(entryPath);
    }
    if (entry === 'missions' && safeExistsSync(entryPath)) {
      for (const mission of safeReaddir(entryPath)) {
        const missionPath = safeOptionalRepositoryPath(path.join(entryPath, mission));
        if (!missionPath || !safeExistsSync(missionPath)) continue;
        // AC-03 follow-up: a mission-scoped lookup (options.missionId) must
        // always see that mission's own history — the recent-days window
        // would otherwise silently hide an older mission's worker events even
        // though the caller asked for it by id. Only the byte cap still
        // applies to it. Every *other* mission's partition stays windowed
        // exactly like the top-level daily files, so an unscoped or
        // differently-scoped read doesn't pay for every mission's full
        // history.
        const isScopedMission = Boolean(
          scopedMissionUpper && mission.toUpperCase() === scopedMissionUpper
        );
        for (const file of safeReaddir(missionPath)) {
          if (!file.endsWith('.jsonl')) continue;
          if (!isScopedMission) {
            const dated = WORKER_DATED_FILE_PATTERN.exec(file);
            if (
              bound &&
              dated &&
              !isWorkerFileWithinRecentDays(dated[1], nowIsoValue, bound.recentDays)
            ) {
              continue;
            }
          }
          const filePath = safeOptionalRepositoryPath(path.join(missionPath, file));
          if (filePath) files.push(filePath);
        }
      }
    }
  }
  const truncatedSources = new Set<string>();
  const events = files.flatMap((file, fileIndex) => {
    const { records, truncated } = bound
      ? readJsonlBounded(file, bound.maxBytesPerFile)
      : { records: readJsonl(file), truncated: false };
    if (truncated) truncatedSources.add(path.basename(file));
    return records.flatMap((record, index) => {
      if (bound && !bound.includeStepEvents && isCollaborationNoise(record)) return [];
      const source = toRecordOrNull(record.source) || {};
      const payload = toRecordOrNull(record.payload) || {};
      const event = eventFromRecord(
        {
          ...record,
          mission_id: record.mission_id || source.mission_id,
          task_id: record.task_id || source.task_id,
          // AC-01 envelopes name the *child* in `payload.agent_id` and the
          // emitting parent in `source.agent_id`; the child is the subject.
          agent_id: record.agent_id || stringValue(payload, 'agent_id') || source.agent_id,
          event_type: record.type,
          // Worker envelopes keep `status` inside `payload`; lift it so
          // `state_after` (and therefore the spawn child state) reflects
          // `subagent_end` outcomes such as `fallback` / `failure`.
          ...(stringValue(payload, 'status') ? { status: stringValue(payload, 'status') } : {}),
          summary: stringValue(payload, 'summary', 'op', 'status', 'reason') || record.type,
          seq: record.seq,
        },
        'worker',
        fileIndex * 100000 + index
      );
      return event ? [event] : [];
    });
  });
  return { events, truncatedSources: [...truncatedSources] };
}

/**
 * AC-10: the runtime supervisor stream, now written as one
 * `agent-runtime-supervisor-events-YYYY-MM-DD.jsonl` per UTC day. Partitions
 * are enumerated through the writer's own helper (oldest first, legacy
 * unrotated file included) and each is read under the same per-file byte cap.
 *
 * The legacy file stays in the list even in bounded mode: it is history, and
 * the `since` window applied in `eventMatches` already hides its old events,
 * so including it costs one capped tail read and never resurrects stale rows.
 *
 * `seq` continues across partitions instead of restarting per file, because
 * `statusFromEvents` derives `sequence_gap` for the `runtime` source from it —
 * a per-file offset would manufacture a gap at every partition boundary.
 */
function readSupervisorSourceEvents(
  bound: Required<CollaborationBoundedReadOptions> | null,
  nowIsoValue: string,
  observabilityDir: string
): ReadResult {
  const truncatedSources = new Set<string>();
  const events: AgentCollaborationEvent[] = [];
  let seq = 0;
  const files = listSupervisorEventFiles({
    ...(bound ? { recentDays: bound.recentDays } : {}),
    now: nowIsoValue,
    includeLegacy: true,
    dir: observabilityDir,
  });
  for (const file of files) {
    const { records, truncated } = bound
      ? readJsonlBounded(file.path, bound.maxBytesPerFile)
      : { records: readJsonl(file.path), truncated: false };
    if (truncated) truncatedSources.add(path.basename(file.path));
    for (const record of records) {
      if (bound && !bound.includeStepEvents && isCollaborationNoise(record)) continue;
      const event = eventFromRecord(record, 'runtime', seq);
      seq += 1;
      if (event) events.push(event);
    }
  }
  return { events, truncatedSources: [...truncatedSources] };
}

/**
 * AC-11: peer conversations as a fifth source (`a2a`).
 *
 * Each observability edge becomes one `peer_conversation_message` event whose
 * sender/receiver are already oriented by `readPeerConversationEdges`
 * (inbound rows are flipped), so the generic sender/receiver edge builder in
 * `composeAgentCollaborationProjection` emits `agent:<sender> →
 * agent:<receiver>` handoffs without a peer-specific branch.
 *
 * Tenant selection mirrors the viewer scope: an explicit `tenant`, else an
 * explicit `tenantSlugs` list, else — for an unscoped or `'all'` view — every
 * tenant with a peer-conversation runtime directory. That last fallback is
 * suppressed under a `roots` override: peer-conversation storage has no root
 * of its own to redirect, and a read the caller explicitly isolated to fixture
 * directories must not silently mix in the real shared peer logs (which other
 * suites write to concurrently). An explicitly named tenant is still read, so
 * an isolated test can pin a throwaway tenant and still exercise this source.
 *
 * The session id travels as `correlation_id` rather than `session_id`: a scope
 * carrying a session without a mission/task is not a valid event scope, and the
 * tenant is the only containment a peer conversation actually has.
 */
function readPeerEvents(
  options: ComposeCollaborationProjectionOptions,
  since?: string
): AgentCollaborationEvent[] {
  const tenants = options.tenant
    ? [options.tenant]
    : Array.isArray(options.tenantSlugs)
      ? options.tenantSlugs
      : options.roots
        ? []
        : listPeerConversationTenants();
  const events: AgentCollaborationEvent[] = [];
  let seq = 0;
  for (const tenant of tenants) {
    let edges: ReturnType<typeof readPeerConversationEdges>;
    try {
      edges = readPeerConversationEdges(tenant, since ? { since } : {});
    } catch {
      // An unreadable or invalid tenant must not empty the whole projection.
      continue;
    }
    for (const edge of edges) {
      const event = eventFromRecord(
        {
          event_id: edge.message_id,
          ts: edge.ts,
          event_type: 'peer_conversation_message',
          agent_id: edge.receiver_peer_id,
          sender: edge.sender_peer_id,
          receiver: edge.receiver_peer_id,
          correlation_id: edge.session_id,
          summary: edge.kind,
          scope: { tenant_slug: edge.tenant_id },
        },
        'a2a',
        seq
      );
      seq += 1;
      if (event) events.push(event);
    }
  }
  return events;
}

function readSourceEvents(
  bound: Required<CollaborationBoundedReadOptions> | null,
  nowIsoValue: string,
  observabilityDir: string,
  workerEventsDir: string,
  options: ComposeCollaborationProjectionOptions,
  since?: string
): ReadResult {
  const truncatedSources = new Set<string>();
  const events = JSONL_SOURCES.flatMap(({ file, source }) => {
    const filePath = path.join(observabilityDir, file);
    const { records, truncated } = bound
      ? readJsonlBounded(filePath, bound.maxBytesPerFile)
      : { records: readJsonl(filePath), truncated: false };
    if (truncated) truncatedSources.add(file);
    return records.flatMap((record, index) => {
      if (bound && !bound.includeStepEvents && isCollaborationNoise(record)) return [];
      const event = eventFromRecord(record, source, index);
      return event ? [event] : [];
    });
  });
  const supervisorResult = readSupervisorSourceEvents(bound, nowIsoValue, observabilityDir);
  for (const name of supervisorResult.truncatedSources) truncatedSources.add(name);
  const workerResult = readWorkerEvents(bound, nowIsoValue, workerEventsDir, options.missionId);
  for (const name of workerResult.truncatedSources) truncatedSources.add(name);
  return {
    events: [
      ...events,
      ...supervisorResult.events,
      ...workerResult.events,
      ...readPeerEvents(options, since),
    ],
    truncatedSources: [...truncatedSources],
  };
}

function eventMatches(
  event: AgentCollaborationEvent,
  options: ComposeCollaborationProjectionOptions
): boolean {
  if (options.missionId && event.mission_id !== options.missionId.toUpperCase()) return false;
  if (options.since) {
    // Only a parseable timestamp can be judged old; undated records stay.
    const at = Date.parse(event.ts);
    if (Number.isFinite(at) && at < Date.parse(options.since)) return false;
  }
  if (options.tenant || (options.tenantSlugs && options.tenantSlugs !== 'all')) {
    const eventTenant = event.scope?.tenant_slug || event.tenant_slug;
    // Tenant-scoped views must fail closed: an event without an explicit or
    // mission-derived tenant cannot be safely shown in a tenant projection.
    const allowed =
      options.tenantSlugs && options.tenantSlugs !== 'all'
        ? options.tenantSlugs
        : options.tenant
          ? [options.tenant]
          : [];
    if (!eventTenant || !allowed.includes(eventTenant)) return false;
    // The resolved envelope is authoritative for both canonical and migrated
    // records, so the exact same tenant filter must match it as well.
    if (
      event.scope &&
      !eventScopeMatches(event.scope, {
        ...(options.tenant ? { tenant_slug: options.tenant } : {}),
        ...(options.tenantSlugs && options.tenantSlugs !== 'all'
          ? { tenant_slugs: options.tenantSlugs }
          : {}),
        ...(options.scopeFilter || {}),
      })
    ) {
      return false;
    }
  }
  if (
    options.scopeFilter &&
    !eventScopeMatches(event.scope, {
      ...(options.tenant ? { tenant_slug: options.tenant } : {}),
      ...(options.tenantSlugs && options.tenantSlugs !== 'all'
        ? { tenant_slugs: options.tenantSlugs }
        : {}),
      ...options.scopeFilter,
    })
  ) {
    return false;
  }
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

/**
 * AC-09: which collaboration kinds raise attention, and the developer-facing
 * text that goes with each. A table, not a chain of `if`s, so adding a kind is
 * one line and the closed `code` set stays visible in one place.
 */
const ATTENTION_BY_KIND: Partial<
  Record<
    CollaborationKind,
    { code: CollaborationAttentionCode; title: string; next_action: string }
  >
> = {
  blocked: {
    code: 'blocked',
    title: 'Blocked',
    next_action: 'Resolve the blocking input, dependency or assignment',
  },
  approval: {
    code: 'waiting_human',
    title: 'Waiting for human approval',
    next_action: 'Review the request in the approval queue',
  },
  review: {
    code: 'review_pending',
    title: 'Review pending',
    next_action: 'Review the deliverable and evidence refs',
  },
  failure: {
    code: 'failure',
    title: 'Failed',
    next_action: 'Classify the failure and decide on re-run conditions',
  },
};

function attentionForEvent(event: AgentCollaborationEvent): CollaborationAttentionItem | null {
  const template = ATTENTION_BY_KIND[event.kind];
  if (!template) return null;
  return {
    event_id: event.event_id,
    mission_id: event.mission_id,
    task_id: event.task_id,
    agent_id: event.agent_id,
    kind: event.kind,
    code: template.code,
    title: template.title,
    reason: event.summary,
    next_action: template.next_action,
  };
}

function statusFromEvents(
  events: AgentCollaborationEvent[],
  options: ComposeCollaborationProjectionOptions,
  generatedAt: string
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
  const now = Date.parse(generatedAt);
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
  const limit = clamp(options.limit || 100, 1, 500);
  const deduped = new Map<string, AgentCollaborationEvent>();
  for (const event of input.filter((event) => eventMatches(event, options))) {
    deduped.set(`${event.source}:${event.source_event_id}`, event);
  }
  // `limit` caps only the returned `events` feed (newest-last). The graph,
  // attention list and overview are composed over every event that survived
  // filtering: in a real repository the newest N events are routinely
  // unattributed worker heartbeats, and slicing before composition made the
  // graph empty while older mission-control events were silently dropped.
  const ordered = [...deduped.values()].sort(
    (left, right) => left.ts.localeCompare(right.ts) || left.event_id.localeCompare(right.event_id)
  );
  const events = ordered.slice(-limit);
  const generatedAt = options.now ?? nowIso();
  const status = statusFromEvents(ordered, options, generatedAt);
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
  let nativeSubagents = 0;
  let unavailableSubagents = 0;
  // AC-02: index delegation lifecycle terminals (subagent_end / _unavailable,
  // kind 'completion' / 'failure') by delegation_id so a spawn edge's child
  // node can show the outcome instead of staying 'running' forever.
  const delegationEndState = new Map<string, string>();
  for (const event of ordered) {
    if (!event.delegation_id || event.kind === 'spawn') continue;
    delegationEndState.set(
      event.delegation_id,
      event.state_after || (event.kind === 'failure' ? 'failed' : 'success')
    );
  }
  for (const event of ordered) {
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
    // AC-02(a): a2a_message_routed → agent:sender → agent:receiver, kind
    // handoff. The sender node becomes a human node if this specific event
    // was attributed to a human actor (same check the mission/task/agent
    // block above uses for event.actor_type === 'human').
    if (event.sender && event.receiver) {
      const senderIsHuman = event.actor_type === 'human';
      const senderId = senderIsHuman ? `human:${event.sender}` : `agent:${event.sender}`;
      addNode(nodes, senderId, senderIsHuman ? 'human' : 'agent', event.sender);
      addNode(nodes, `agent:${event.receiver}`, 'agent', event.receiver);
      edges.push({
        from: senderId,
        to: `agent:${event.receiver}`,
        kind: 'handoff',
        event_id: event.event_id,
      });
    }
    // AC-02(b): subagent_begin → agent:parent_agent_id → agent:agent_id, kind
    // spawn. The child node's state reflects the matching subagent_end /
    // _unavailable (same delegation_id) when one has already been observed,
    // otherwise the child is still running.
    if (event.kind === 'spawn' && event.parent_agent_id && event.agent_id) {
      const childId = `agent:${event.agent_id}`;
      addNode(nodes, `agent:${event.parent_agent_id}`, 'agent', event.parent_agent_id);
      addNode(nodes, childId, 'agent', event.agent_id);
      const childNode = nodes.get(childId);
      if (childNode) {
        childNode.state = event.delegation_id
          ? (delegationEndState.get(event.delegation_id) ?? 'running')
          : (event.state_after ?? 'running');
      }
      edges.push({
        from: `agent:${event.parent_agent_id}`,
        to: childId,
        kind: 'spawn',
        event_id: event.event_id,
      });
    }
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
    if (event.native === true) nativeSubagents += 1;
    if (event.native_unavailable === true) unavailableSubagents += 1;
    const attentionItem = attentionForEvent(event);
    if (attentionItem) attention.push(attentionItem);
  }
  if (options.runGraph) {
    const graphId = `run-graph:${options.runGraph.run_id || 'run'}`;
    addNode(nodes, graphId, 'artifact', graphId, 'completed');
    if (options.runGraph.trace_id) {
      const traceId = `trace:${options.runGraph.trace_id}`;
      addNode(nodes, traceId, 'artifact', traceId, 'completed');
      edges.push({
        from: graphId,
        to: traceId,
        kind: 'progress',
        event_id: `${graphId}:trace:${options.runGraph.trace_id}`,
      });
    }
    for (const node of options.runGraph.nodes) {
      const nodeId = `${graphId}:node:${node.id}`;
      addNode(nodes, nodeId, 'system', node.id, node.status);
      edges.push({
        from: graphId,
        to: nodeId,
        kind:
          node.status === 'failed'
            ? 'failure'
            : node.status === 'success'
              ? 'completion'
              : 'progress',
        event_id: `${graphId}:node:${node.id}`,
      });
    }
    for (const edge of options.runGraph.edges) {
      edges.push({
        from: `${graphId}:node:${edge.from}`,
        to: `${graphId}:node:${edge.to}`,
        kind: edge.kind === 'control' ? 'dispatch' : 'progress',
        event_id: `${graphId}:edge:${edge.from}:${edge.to}:${edge.kind}`,
      });
    }
  }
  return {
    generated_at: generatedAt,
    cursor: events.at(-1)?.event_id || null,
    partial: status.flags.length > 0,
    status_flags: status.flags,
    sequence_gaps: status.gaps,
    sources: [...new Set(ordered.map((event) => event.source))].sort(),
    // Never set by compose itself — it never touches the filesystem. Populated
    // additively by buildAgentCollaborationProjection when a bounded read (AC-03)
    // truncated a source file.
    truncated_sources: [],
    overview: {
      events: ordered.length,
      missions: missions.size,
      tasks: tasks.size,
      agents: agents.size,
      active,
      blocked,
      waiting_human: waitingHuman,
      review_pending: reviewPending,
      failures,
      native_subagents: nativeSubagents,
      unavailable_subagents: unavailableSubagents,
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
  const nowValue = options.now ?? nowIso();
  const bound = resolveBoundedReadOptions(options.bounded);
  const observabilityDir = resolveRootDir(options.roots?.observabilityDir, OBSERVABILITY_DIR);
  const workerEventsDir = resolveRootDir(options.roots?.workerEventsDir, WORKER_EVENTS_DIR);
  // A mission-scoped lookup keeps that mission's full history (its worker
  // partition is already exempt from the file date window above). Resolved
  // before the read so the peer-conversation source (AC-11), whose single
  // per-peer log is never rotated, can bound its own scan by the same window
  // instead of loading every message ever exchanged.
  const sinceValue =
    bound && !options.missionId && Number.isFinite(Date.parse(nowValue))
      ? new Date(Date.parse(nowValue) - bound.recentDays * 24 * 60 * 60 * 1000).toISOString()
      : undefined;
  const { events, truncatedSources } = readSourceEvents(
    bound,
    nowValue,
    observabilityDir,
    workerEventsDir,
    options,
    options.since ?? sinceValue
  );
  const projection = composeAgentCollaborationProjection(events, {
    ...options,
    now: nowValue,
    ...(options.since ? {} : sinceValue ? { since: sinceValue } : {}),
  });
  if (truncatedSources.length === 0) return projection;
  return {
    ...projection,
    partial: true,
    status_flags: [...new Set([...projection.status_flags, 'bounded_read' as const])].sort(),
    truncated_sources: truncatedSources,
  };
}
