import { appendJsonLine } from './foundation/json.js';
/**
 * Durable graph-run journal for mission follow-up dispatch (GE-05).
 *
 * The orchestration journal records event lifecycle and payload hashes. This
 * journal records the smaller state needed to resume a graph after a worker
 * process stops between node completion and NEXT_TASKS persistence.
 */
import { pathResolver } from './path-resolver.js';
import { safeAppendFileSync, safeExistsSync, safeMkdir, safeReadFile } from './secure-io.js';

export const MISSION_GRAPH_RUN_JOURNAL_VERSION = 1;

export type MissionGraphRunEventType = 'graph_started' | 'node_state' | 'graph_finished';
export type MissionGraphNodeState = 'completed' | 'rework' | 'blocked' | 'failed';

export interface MissionGraphRunNodeState {
  task_id: string;
  state: MissionGraphNodeState;
  outcome?: Record<string, unknown>;
  task_snapshot?: Record<string, unknown>;
}

export interface MissionGraphRunJournalEvent {
  version: number;
  sequence: number;
  run_id: string;
  mission_id: string;
  event: MissionGraphRunEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface MissionGraphRunJournalState {
  run_id: string;
  mission_id: string;
  path: string;
  events: MissionGraphRunJournalEvent[];
  task_ids: string[];
  node_states: Map<string, MissionGraphRunNodeState>;
  finished?: { status: string; error?: string };
}

export interface MissionGraphRunJournalHandle {
  readonly runId: string;
  readonly path: string;
  append(
    event: MissionGraphRunEventType,
    payload: Record<string, unknown>
  ): MissionGraphRunJournalEvent;
  state(): MissionGraphRunJournalState;
}

function safeSegment(value: string): string {
  const normalized = String(value || '').trim();
  const segment = normalized.replace(/[^a-zA-Z0-9._-]/gu, '_');
  if (!segment) throw new Error('[MISSION_GRAPH_JOURNAL] run id is required');
  return segment;
}

function journalPath(missionId: string, runId: string): string {
  return `${pathResolver.missionDir(missionId, 'public')}/coordination/graph-run-${safeSegment(runId)}.jsonl`;
}

function appendEvent(
  filePath: string,
  missionId: string,
  runId: string,
  sequence: number,
  event: MissionGraphRunEventType,
  payload: Record<string, unknown>
): MissionGraphRunJournalEvent {
  const envelope: MissionGraphRunJournalEvent = {
    version: MISSION_GRAPH_RUN_JOURNAL_VERSION,
    sequence,
    run_id: runId,
    mission_id: missionId.toUpperCase(),
    event,
    timestamp: new Date().toISOString(),
    payload,
  };
  appendJsonLine(filePath, envelope);
  return envelope;
}

function parseEvent(
  line: string,
  expectedMissionId: string,
  expectedRunId: string
): MissionGraphRunJournalEvent {
  const parsed = JSON.parse(line) as Partial<MissionGraphRunJournalEvent>;
  if (
    parsed.version !== MISSION_GRAPH_RUN_JOURNAL_VERSION ||
    parsed.mission_id !== expectedMissionId.toUpperCase() ||
    parsed.run_id !== expectedRunId ||
    typeof parsed.sequence !== 'number' ||
    !Number.isInteger(parsed.sequence) ||
    parsed.sequence < 1 ||
    !['graph_started', 'node_state', 'graph_finished'].includes(String(parsed.event)) ||
    !parsed.payload ||
    typeof parsed.payload !== 'object'
  ) {
    throw new Error('[MISSION_GRAPH_JOURNAL] invalid journal event');
  }
  return parsed as MissionGraphRunJournalEvent;
}

function validateNodeState(payload: Record<string, unknown>): MissionGraphRunNodeState {
  const taskId = typeof payload.task_id === 'string' ? payload.task_id.trim() : '';
  const state = payload.state;
  if (
    !taskId ||
    (state !== 'completed' && state !== 'rework' && state !== 'blocked' && state !== 'failed')
  ) {
    throw new Error('[MISSION_GRAPH_JOURNAL] invalid node state payload');
  }
  const outcome = payload.outcome;
  const taskSnapshot = payload.task_snapshot;
  if (
    (outcome !== undefined &&
      (!outcome || typeof outcome !== 'object' || Array.isArray(outcome))) ||
    (taskSnapshot !== undefined &&
      (!taskSnapshot || typeof taskSnapshot !== 'object' || Array.isArray(taskSnapshot)))
  ) {
    throw new Error('[MISSION_GRAPH_JOURNAL] invalid node snapshot payload');
  }
  return {
    task_id: taskId,
    state,
    ...(outcome ? { outcome: outcome as Record<string, unknown> } : {}),
    ...(taskSnapshot ? { task_snapshot: taskSnapshot as Record<string, unknown> } : {}),
  };
}

export function loadMissionGraphRunJournal(
  missionId: string,
  runId: string
): MissionGraphRunJournalState {
  const normalizedMissionId = String(missionId || '')
    .trim()
    .toUpperCase();
  const normalizedRunId = safeSegment(runId);
  const filePath = journalPath(normalizedMissionId, normalizedRunId);
  if (!safeExistsSync(filePath)) {
    throw new Error(`[MISSION_GRAPH_JOURNAL] run not found: ${normalizedRunId}`);
  }
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  const events = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseEvent(line, normalizedMissionId, normalizedRunId));
  let expectedSequence = 1;
  let taskIds: string[] = [];
  const nodeStates = new Map<string, MissionGraphRunNodeState>();
  let finished: MissionGraphRunJournalState['finished'];

  for (const event of events) {
    if (event.sequence !== expectedSequence) {
      throw new Error('[MISSION_GRAPH_JOURNAL] non-contiguous journal sequence');
    }
    expectedSequence += 1;
    if (event.event === 'graph_started') {
      const rawTaskIds = event.payload.task_ids;
      if (!Array.isArray(rawTaskIds) || rawTaskIds.some((taskId) => typeof taskId !== 'string')) {
        throw new Error('[MISSION_GRAPH_JOURNAL] graph_started is missing task ids');
      }
      taskIds = Array.from(new Set(rawTaskIds.map((taskId) => taskId.trim()).filter(Boolean)));
    } else if (event.event === 'node_state') {
      const node = validateNodeState(event.payload);
      nodeStates.set(node.task_id, node);
    } else {
      const status = typeof event.payload.status === 'string' ? event.payload.status.trim() : '';
      if (!status) throw new Error('[MISSION_GRAPH_JOURNAL] graph_finished is missing status');
      finished = {
        status,
        ...(typeof event.payload.error === 'string' ? { error: event.payload.error } : {}),
      };
    }
  }
  if (events[0]?.event !== 'graph_started') {
    throw new Error('[MISSION_GRAPH_JOURNAL] missing graph_started');
  }
  return {
    run_id: normalizedRunId,
    mission_id: normalizedMissionId,
    path: filePath,
    events,
    task_ids: taskIds,
    node_states: nodeStates,
    finished,
  };
}

export function openOrCreateMissionGraphRunJournal(input: {
  missionId: string;
  runId: string;
  taskIds: string[];
}): MissionGraphRunJournalHandle {
  const missionId = String(input.missionId || '')
    .trim()
    .toUpperCase();
  const runId = safeSegment(input.runId);
  const filePath = journalPath(missionId, runId);
  if (!safeExistsSync(filePath)) {
    safeMkdir(`${pathResolver.missionDir(missionId, 'public')}/coordination`);
    appendEvent(filePath, missionId, runId, 1, 'graph_started', {
      task_ids: Array.from(
        new Set(input.taskIds.map((taskId) => String(taskId).trim()).filter(Boolean))
      ),
    });
  }
  const initialState = loadMissionGraphRunJournal(missionId, runId);
  let sequence = initialState.events.reduce((max, event) => Math.max(max, event.sequence), 0);
  return {
    runId,
    path: filePath,
    append: (event, payload) => {
      const envelope = appendEvent(filePath, missionId, runId, sequence + 1, event, payload);
      sequence = envelope.sequence;
      return envelope;
    },
    state: () => loadMissionGraphRunJournal(missionId, runId),
  };
}
