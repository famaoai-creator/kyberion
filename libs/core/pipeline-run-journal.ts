/**
 * Durable, append-only journal for pipeline graph runs (GE-04).
 *
 * The journal is deliberately narrower than a trace: it contains only the
 * information needed to resume a graph without replaying completed side
 * effects. Output snapshots are limited to declared channels.
 */
import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir } from './secure-io.js';
import { findMissionPath, rootDir, shared } from './path-resolver.js';
import {
  appendValidatedJournalEvent,
  EventSourcingKernel,
  runInRestoreMode,
} from './worker-state-journal.js';
import { z } from 'zod';

export const PIPELINE_RUN_JOURNAL_VERSION = 3;

export type PipelineRunEventType =
  | 'run_started'
  | 'run_resumed'
  | 'run_suspended'
  | 'node_completed'
  | 'node_failed'
  | 'run_finished';

export interface PipelineRunJournalEvent {
  version: number;
  sequence: number;
  run_id: string;
  event: PipelineRunEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface PipelineRunStartedPayload {
  pipeline_id: string;
  input_path: string;
  mission_id?: string;
  step_ids: string[];
}

export interface PipelineRunNodeCompletedPayload {
  step_id: string;
  output_channels_snapshot: Record<string, unknown>;
  /** Durable control markers required to resume a declarative route safely. */
  control_state_snapshot?: Record<string, unknown>;
  output_hash: string;
  duration_ms?: number;
}

export interface PipelineRunSuspendedPayload {
  step_id: string;
  approval_request_id: string;
  storage_channel: string;
  on_timeout: 'abort' | 'deny' | 'escalate';
  timeout_at?: string;
  reason?: string;
}

export interface PipelineRunJournalState {
  run_id: string;
  path: string;
  events: PipelineRunJournalEvent[];
  started?: PipelineRunStartedPayload;
  completed_nodes: Map<string, PipelineRunNodeCompletedPayload>;
  suspended?: PipelineRunSuspendedPayload;
  finished?: { status: string; error?: string };
}

export interface PipelineRunJournalHandle {
  readonly runId: string;
  readonly path: string;
  append(event: PipelineRunEventType, payload: Record<string, unknown>): PipelineRunJournalEvent;
  state(): PipelineRunJournalState;
}

interface PipelineJournalProjection {
  started?: PipelineRunStartedPayload;
  completed_nodes: Record<string, PipelineRunNodeCompletedPayload>;
  suspended?: PipelineRunSuspendedPayload;
  finished?: { status: string; error?: string };
}

const pipelineJournalKernel = new EventSourcingKernel();
const pipelineJournalModel = pipelineJournalKernel.defineModel<PipelineJournalProjection>(
  'pipeline-run',
  () => ({ completed_nodes: {} })
);
const pipelineStartedSchema = z.object({
  pipeline_id: z.string(),
  input_path: z.string(),
  mission_id: z.string().optional(),
  step_ids: z.array(z.string()),
});
const pipelineNodeCompletedSchema = z.object({
  step_id: z.string(),
  output_channels_snapshot: z.record(z.string(), z.unknown()),
  control_state_snapshot: z.record(z.string(), z.unknown()).optional(),
  output_hash: z.string(),
  duration_ms: z.number().optional(),
});
const pipelineFinishedSchema = z.object({ status: z.string(), error: z.string().optional() });
pipelineJournalKernel.defineOp('pipeline.run_started', {
  model: pipelineJournalModel,
  schema: pipelineStartedSchema,
  apply: (state, payload) => ({ ...state, started: payload }),
});
pipelineJournalKernel.defineOp('pipeline.run_resumed', {
  model: pipelineJournalModel,
  schema: z.record(z.string(), z.unknown()),
  apply: (state) => ({ ...state, suspended: undefined }),
});
pipelineJournalKernel.defineOp('pipeline.run_suspended', {
  model: pipelineJournalModel,
  schema: z.object({
    step_id: z.string(),
    approval_request_id: z.string(),
    storage_channel: z.string(),
    on_timeout: z.enum(['abort', 'deny', 'escalate']),
    timeout_at: z.string().optional(),
    reason: z.string().optional(),
  }),
  apply: (state, payload) => ({ ...state, suspended: payload }),
});
pipelineJournalKernel.defineOp('pipeline.node_completed', {
  model: pipelineJournalModel,
  schema: pipelineNodeCompletedSchema,
  apply: (state, payload) => ({
    ...state,
    completed_nodes: { ...state.completed_nodes, [payload.step_id]: payload },
  }),
});
pipelineJournalKernel.defineOp('pipeline.node_failed', {
  model: pipelineJournalModel,
  schema: z.object({ step_id: z.string(), error: z.string(), duration_ms: z.number().optional() }),
  apply: (state) => state,
});
pipelineJournalKernel.defineOp('pipeline.run_finished', {
  model: pipelineJournalModel,
  schema: pipelineFinishedSchema,
  apply: (state, payload) => ({ ...state, finished: payload }),
});

function normalizedSegment(value: string): string {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!normalized || normalized === '.' || normalized === '..') {
    throw new Error('[PIPELINE_JOURNAL] invalid run id');
  }
  return normalized;
}

function appendPipelineJournalEvent(
  filePath: string,
  runId: string,
  sequence: number,
  event: PipelineRunEventType,
  payload: Record<string, unknown>
): PipelineRunJournalEvent {
  return appendValidatedJournalEvent({
    kernel: pipelineJournalKernel,
    opName: `pipeline.${event}`,
    payload,
    journalPath: filePath,
    seq: sequence,
    buildEnvelope: ({ seq, ts, payload: validated }) => ({
      version: PIPELINE_RUN_JOURNAL_VERSION,
      sequence: seq,
      run_id: runId,
      event,
      timestamp: ts,
      payload: validated as Record<string, unknown>,
    }),
  });
}

function journalDir(missionId?: string): string {
  const mission = missionId ? findMissionPath(missionId) : null;
  return mission
    ? path.join(mission, 'coordination', 'pipeline-runs')
    : shared('runtime/pipeline-runs');
}

export function pipelineRunJournalPath(runId: string, missionId?: string): string {
  return path.join(journalDir(missionId), `${normalizedSegment(runId)}.jsonl`);
}

function candidateJournalPaths(runId: string): string[] {
  const id = normalizedSegment(runId);
  const candidates = [pipelineRunJournalPath(id)];
  for (const tier of ['confidential', 'public'] as const) {
    const base = path.join(rootDir(), 'active', 'missions', tier);
    if (!safeExistsSync(base)) continue;
    for (const missionId of safeReaddir(base)) {
      const candidate = path.join(base, missionId, 'coordination', 'pipeline-runs', `${id}.jsonl`);
      if (safeExistsSync(candidate)) candidates.push(candidate);
    }
  }
  const missionId = process.env.MISSION_ID?.trim();
  if (missionId) candidates.push(pipelineRunJournalPath(id, missionId));
  return [...new Set(candidates)];
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableValue(record[key])}`)
    .join(',')}}`;
}

export function hashPipelineOutput(value: unknown): string {
  return createHash('sha256').update(stableValue(value)).digest('hex');
}

function migrateEvent(raw: unknown): PipelineRunJournalEvent {
  if (!raw || typeof raw !== 'object') throw new Error('[PIPELINE_JOURNAL] invalid event envelope');
  const record = raw as Record<string, unknown>;
  const version = Number(record.version ?? record.v);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error('[PIPELINE_JOURNAL] event has no valid version');
  }
  if (version > PIPELINE_RUN_JOURNAL_VERSION) {
    throw new Error(`[PIPELINE_JOURNAL] unsupported future journal version ${version}`);
  }
  const migrated: Record<string, unknown> = {
    ...record,
    version: PIPELINE_RUN_JOURNAL_VERSION,
    sequence: record.sequence ?? record.seq,
    timestamp: record.timestamp ?? record.ts,
  };
  if (version === 1 && migrated.event === 'node_completed') {
    const payload = (migrated.payload || {}) as Record<string, unknown>;
    migrated.payload = {
      ...payload,
      output_channels_snapshot: payload.output_channels_snapshot ?? payload.channels ?? {},
    };
  }
  if (
    typeof migrated.run_id !== 'string' ||
    typeof migrated.event !== 'string' ||
    typeof migrated.sequence !== 'number' ||
    !Number.isInteger(migrated.sequence) ||
    typeof migrated.timestamp !== 'string' ||
    !migrated.payload ||
    typeof migrated.payload !== 'object'
  ) {
    throw new Error('[PIPELINE_JOURNAL] malformed event envelope');
  }
  const validEvents: PipelineRunEventType[] = [
    'run_started',
    'run_resumed',
    'run_suspended',
    'node_completed',
    'node_failed',
    'run_finished',
  ];
  if (!validEvents.includes(migrated.event as PipelineRunEventType)) {
    throw new Error(`[PIPELINE_JOURNAL] unknown event ${String(migrated.event)}`);
  }
  return {
    version: PIPELINE_RUN_JOURNAL_VERSION,
    sequence: migrated.sequence as number,
    run_id: migrated.run_id as string,
    event: migrated.event as PipelineRunEventType,
    timestamp: migrated.timestamp as string,
    payload: migrated.payload as Record<string, unknown>,
  };
}

export function readPipelineRunJournal(filePath: string): PipelineRunJournalState {
  if (!safeExistsSync(filePath)) throw new Error(`[PIPELINE_JOURNAL] not found: ${filePath}`);
  const lines = String(safeReadFile(filePath, { encoding: 'utf8' }))
    .split('\n')
    .filter((line) => line.trim().length > 0);
  const events: PipelineRunJournalEvent[] = [];
  let previousSequence = 0;
  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error('[PIPELINE_JOURNAL] corrupt JSONL journal; refusing to resume');
    }
    const event = migrateEvent(parsed);
    if (events.length > 0 && event.sequence <= previousSequence) {
      throw new Error('[PIPELINE_JOURNAL] non-monotonic event sequence; refusing to resume');
    }
    previousSequence = event.sequence;
    events.push(event);
  }
  if (events.length === 0) throw new Error('[PIPELINE_JOURNAL] empty journal; refusing to resume');
  const runId = events[0].run_id;
  if (events.some((event) => event.run_id !== runId)) {
    throw new Error('[PIPELINE_JOURNAL] mixed run ids; refusing to resume');
  }
  for (const event of events) {
    // The kernel projector is intentionally tolerant for forward/unknown
    // worker events. Pipeline resume is stricter: a known lifecycle event with
    // a malformed payload must fail closed rather than silently dropping a
    // completed side effect.
    pipelineJournalKernel.validatePayload(`pipeline.${event.event}`, event.payload);
  }
  const projected = runInRestoreMode(() =>
    pipelineJournalKernel.project(
      events.map((event) => ({
        v: event.version,
        seq: event.sequence,
        ts: event.timestamp,
        op: `pipeline.${event.event}`,
        payload: event.payload,
      }))
    )
  );
  const projection = (projected.get('pipeline-run') || {
    completed_nodes: {},
  }) as PipelineJournalProjection;
  const state: PipelineRunJournalState = {
    run_id: runId,
    path: filePath,
    events,
    completed_nodes: new Map(Object.entries(projection.completed_nodes)),
  };
  state.started = projection.started;
  state.suspended = projection.suspended;
  state.finished = projection.finished;
  if (!state.started) throw new Error('[PIPELINE_JOURNAL] missing run_started; refusing to resume');
  return state;
}

export function loadPipelineRunJournal(runId: string, missionId?: string): PipelineRunJournalState {
  const candidates = missionId
    ? [pipelineRunJournalPath(runId, missionId)]
    : candidateJournalPaths(runId);
  const found = candidates.find((candidate) => safeExistsSync(candidate));
  if (!found) throw new Error(`[PIPELINE_JOURNAL] run not found: ${runId}`);
  return readPipelineRunJournal(found);
}

export function createPipelineRunJournal(
  runId: string,
  started: PipelineRunStartedPayload,
  missionId?: string
): PipelineRunJournalHandle {
  const id = normalizedSegment(runId);
  const filePath = pipelineRunJournalPath(id, missionId);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  if (safeExistsSync(filePath)) {
    throw new Error(`[PIPELINE_JOURNAL] run already exists: ${id}`);
  }
  let sequence = 0;
  const append = (event: PipelineRunEventType, payload: Record<string, unknown>) => {
    const envelope = appendPipelineJournalEvent(filePath, id, sequence + 1, event, payload);
    sequence = envelope.sequence;
    return envelope;
  };
  append('run_started', {
    ...started,
    input_path: path.relative(rootDir(), started.input_path) || started.input_path,
  });
  return {
    runId: id,
    path: filePath,
    append,
    state: () => readPipelineRunJournal(filePath),
  };
}

/** Open an existing journal for lifecycle appends after a process restart. */
export function openPipelineRunJournal(state: PipelineRunJournalState): PipelineRunJournalHandle {
  let sequence = state.events.reduce((max, event) => Math.max(max, event.sequence), 0);
  const append = (event: PipelineRunEventType, payload: Record<string, unknown>) => {
    const envelope = appendPipelineJournalEvent(
      state.path,
      state.run_id,
      sequence + 1,
      event,
      payload
    );
    sequence = envelope.sequence;
    return envelope;
  };
  return {
    runId: state.run_id,
    path: state.path,
    append,
    state: () => readPipelineRunJournal(state.path),
  };
}

export function newPipelineRunId(): string {
  return randomUUID();
}
