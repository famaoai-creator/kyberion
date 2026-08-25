import { appendJsonLine, readJson } from './foundation/json.js';
import * as crypto from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  safeReaddir,
} from './secure-io.js';
import {
  loadMissionOrchestrationEvent,
  type MissionOrchestrationEvent,
  type MissionOrchestrationEventType,
} from './mission-orchestration-events.js';
import { eventScopeMatches, type EventScope } from './event-scope.js';
import { withFencedWriterLeaseSync, writerLeaseResourceId } from './writer-lease.js';

export type MissionOrchestrationJournalStatus = 'enqueued' | 'completed' | 'failed';

export type MissionOperationKind = 'run' | 'compaction' | 'handoff' | 'checkpoint';
export type MissionOperationOutcomeStatus =
  'pending' | 'completed' | 'declined' | 'aborted' | 'failed' | 'suspended';

export interface MissionOperation {
  id: string;
  kind: MissionOperationKind;
  attempt: number;
}

export interface MissionOperationOutcome {
  status: MissionOperationOutcomeStatus;
  reason?: string;
}

/** A content-addressed artifact provisioned before its durable write. */
export interface ProvisionedEntry<TContent = unknown> {
  id: string;
  content: TContent;
  content_hash: string;
}

export interface PersistedProvisionedEntry<TContent = unknown> {
  id: string;
  content: TContent;
  content_hash: string;
}

export type ProvisionedEntryRecordPhase = 'provisioned' | 'verified';

export interface ProvisionedEntryRecord {
  ts: string;
  entry_id: string;
  content_hash: string;
  target_path: string;
  phase: ProvisionedEntryRecordPhase;
}

export interface MissionOrchestrationJournalEntry {
  ts: string;
  event_id: string;
  event_type: MissionOrchestrationEventType;
  mission_id: string;
  status: MissionOrchestrationJournalStatus;
  payload_hash: string;
  operation: MissionOperation;
  outcome: MissionOperationOutcome;
  requested_by?: string;
  causation_id?: string;
  correlation_id?: string;
  scope?: EventScope;
}

export interface ReducedMissionOperation {
  event_id: string;
  operation: MissionOperation;
  outcome: MissionOperationOutcome;
  status: MissionOrchestrationJournalStatus;
}

export interface ReducedMissionState {
  operations: Record<string, ReducedMissionOperation>;
  pending_operation_ids: string[];
  terminal_failure: ReducedMissionOperation | null;
}

export interface MissionOrchestrationReplayPlan {
  last_completed_event_id?: string;
  next_event?: MissionOrchestrationEvent | null;
  pending_event_ids: string[];
  replay_count: number;
}

function missionPathForScope(missionId: string, scope?: EventScope): string {
  if (scope?.tenant_slug) {
    return pathResolver.tenantMissionDir(missionId, scope.tenant_slug, scope.tier);
  }
  return (
    pathResolver.findMissionPath(missionId) ||
    pathResolver.missionDir(missionId, scope?.tier || 'public')
  );
}

function journalDir(missionId: string, scope?: EventScope): string {
  return `${missionPathForScope(missionId, scope)}/coordination`;
}

function journalPath(missionId: string, scope?: EventScope): string {
  return `${journalDir(missionId, scope)}/orchestration-journal.jsonl`;
}

function provisionedEntriesPath(missionId: string, scope?: EventScope): string {
  return `${journalDir(missionId, scope)}/provisioned-entries.jsonl`;
}

function eventDir(): string {
  return pathResolver.shared(`coordination/orchestration/events`);
}

function ensureJournalDir(missionId: string, scope?: EventScope): void {
  safeMkdir(journalDir(missionId, scope));
}

function payloadHash(payload: unknown): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex');
}

function provisionedEntryHash(content: unknown): string {
  return payloadHash(content);
}

/** Mint the id and content hash before a worker artifact is written. */
export function provisionMissionEntry<TContent>(content: TContent): ProvisionedEntry<TContent> {
  return {
    id: `PE-${crypto.randomUUID().slice(0, 12).toUpperCase()}`,
    content,
    content_hash: provisionedEntryHash(content),
  };
}

/**
 * Verify the persisted artifact against the provisioned intent. Recovery must
 * reject a mismatch rather than silently repair or replay it.
 */
export function verifyProvisionedEntry<TContent>(
  provisioned: ProvisionedEntry<TContent>,
  persisted: unknown
): asserts persisted is PersistedProvisionedEntry<TContent> {
  const candidate = persisted as Partial<PersistedProvisionedEntry<TContent>> | null;
  if (
    !candidate ||
    candidate.id !== provisioned.id ||
    candidate.content_hash !== provisioned.content_hash ||
    provisionedEntryHash(candidate.content) !== provisioned.content_hash
  ) {
    throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_mismatch');
  }
}

/**
 * Complete the local artifact half of provision → record → write → verify.
 * The caller records the returned id in the durable operation log before
 * invoking this helper; this function only owns the secure write and verify.
 */
export function writeProvisionedEntry<TContent>(
  filePath: string,
  provisioned: ProvisionedEntry<TContent>
): PersistedProvisionedEntry<TContent> {
  safeWriteFile(filePath, `${JSON.stringify(provisioned, null, 2)}\n`);
  return readProvisionedEntry(filePath, provisioned);
}

/** Read and verify a provisioned artifact during resume/reconciliation. */
export function readProvisionedEntry<TContent>(
  filePath: string,
  provisioned: ProvisionedEntry<TContent>
): PersistedProvisionedEntry<TContent> {
  let persisted: unknown;
  try {
    persisted = readJson<unknown>(filePath);
  } catch {
    throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_unreadable');
  }
  verifyProvisionedEntry(provisioned, persisted);
  return persisted;
}

/** Record the intent before a mission-local artifact write begins. */
export function appendProvisionedEntryRecord(input: {
  missionId: string;
  entry: ProvisionedEntry;
  targetPath: string;
  phase: ProvisionedEntryRecordPhase;
  scope?: EventScope;
}): ProvisionedEntryRecord {
  const record: ProvisionedEntryRecord = {
    ts: new Date().toISOString(),
    entry_id: input.entry.id,
    content_hash: input.entry.content_hash,
    target_path: input.targetPath,
    phase: input.phase,
  };
  const recordPath = provisionedEntriesPath(input.missionId, input.scope);
  const leasePath = `${journalDir(input.missionId, input.scope)}/writer-lease.json`;
  return withFencedWriterLeaseSync({
    resourceId: writerLeaseResourceId(leasePath),
    ownerId: `process:${process.pid}`,
    leasePath,
    fn: () => {
      ensureJournalDir(input.missionId, input.scope);
      appendJsonLine(recordPath, record);
      return record;
    },
  });
}

export function loadProvisionedEntryRecords(
  missionId: string,
  scope?: EventScope
): ProvisionedEntryRecord[] {
  const filePath = provisionedEntriesPath(missionId, scope);
  if (!safeExistsSync(filePath)) return [];
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((entry) => Boolean(entry.line))
    .map(({ line, lineNumber }) => {
      try {
        const parsed = JSON.parse(line) as Partial<ProvisionedEntryRecord>;
        if (
          typeof parsed.entry_id !== 'string' ||
          typeof parsed.content_hash !== 'string' ||
          typeof parsed.target_path !== 'string' ||
          typeof parsed.ts !== 'string' ||
          (parsed.phase !== 'provisioned' && parsed.phase !== 'verified')
        ) {
          throw new Error('record shape');
        }
        return parsed as ProvisionedEntryRecord;
      } catch (error) {
        throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_record:${lineNumber}`, {
          cause: error,
        });
      }
    });
}

/**
 * Write a JSON artifact in its native shape while retaining a hash-bound
 * provisioned receipt. The receipt is written first; a failed write therefore
 * remains visible to resume/reconciliation instead of looking like omission.
 */
export function writeProvisionedJson<TContent>(input: {
  missionId: string;
  filePath: string;
  targetPath: string;
  provisioned: ProvisionedEntry<TContent>;
  scope?: EventScope;
}): TContent {
  appendProvisionedEntryRecord({
    missionId: input.missionId,
    entry: input.provisioned,
    targetPath: input.targetPath,
    phase: 'provisioned',
    scope: input.scope,
  });
  safeWriteFile(input.filePath, `${JSON.stringify(input.provisioned.content, null, 2)}\n`);
  let content: unknown;
  try {
    content = readJson<unknown>(input.filePath);
  } catch {
    throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_unreadable');
  }
  verifyProvisionedEntry(input.provisioned, {
    id: input.provisioned.id,
    content,
    content_hash: input.provisioned.content_hash,
  });
  appendProvisionedEntryRecord({
    missionId: input.missionId,
    entry: input.provisioned,
    targetPath: input.targetPath,
    phase: 'verified',
    scope: input.scope,
  });
  return content as TContent;
}

/**
 * Write a text artifact while retaining the same hash-bound receipt contract
 * as native JSON artifacts. Text artifacts must remain native text on disk;
 * the provisioned wrapper is only an in-memory intent, never the file shape.
 */
export function writeProvisionedText(input: {
  missionId: string;
  filePath: string;
  targetPath: string;
  provisioned: ProvisionedEntry<string>;
  scope?: EventScope;
}): string {
  appendProvisionedEntryRecord({
    missionId: input.missionId,
    entry: input.provisioned,
    targetPath: input.targetPath,
    phase: 'provisioned',
    scope: input.scope,
  });
  safeWriteFile(input.filePath, input.provisioned.content);
  const content = String(safeReadFile(input.filePath, { encoding: 'utf8' }) || '');
  if (content !== input.provisioned.content) {
    throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_mismatch');
  }
  appendProvisionedEntryRecord({
    missionId: input.missionId,
    entry: input.provisioned,
    targetPath: input.targetPath,
    phase: 'verified',
    scope: input.scope,
  });
  return content;
}

function outcomeForStatus(status: MissionOrchestrationJournalStatus): MissionOperationOutcome {
  return {
    status: status === 'enqueued' ? 'pending' : status === 'completed' ? 'completed' : 'failed',
  };
}

function resolveOperation(input: {
  missionId: string;
  eventId: string;
  status: MissionOrchestrationJournalStatus;
  scope?: EventScope;
  operation?: Partial<Pick<MissionOperation, 'id' | 'kind' | 'attempt'>>;
}): MissionOperation {
  const operationId = input.operation?.id || input.eventId;
  const previous = loadMissionOrchestrationJournal(input.missionId, input.scope)
    .filter((entry) => entry.operation.id === operationId)
    .at(-1);
  const previousAttempt = previous?.operation.attempt || 0;
  const isRetry =
    input.status === 'enqueued' &&
    (previous?.outcome.status === 'failed' ||
      previous?.outcome.status === 'aborted' ||
      previous?.outcome.status === 'declined' ||
      previous?.outcome.status === 'suspended');
  const explicitAttempt = input.operation?.attempt;
  return {
    id: operationId,
    kind: input.operation?.kind || previous?.operation.kind || 'run',
    attempt:
      typeof explicitAttempt === 'number' &&
      Number.isInteger(explicitAttempt) &&
      explicitAttempt > 0
        ? explicitAttempt
        : isRetry
          ? previousAttempt + 1
          : Math.max(previousAttempt, 1),
  };
}

function normalizeJournalEntry(
  raw: Partial<MissionOrchestrationJournalEntry>
): MissionOrchestrationJournalEntry {
  const eventId = typeof raw.event_id === 'string' ? raw.event_id : '';
  const status = raw.status === 'completed' || raw.status === 'failed' ? raw.status : 'enqueued';
  const operation =
    raw.operation && typeof raw.operation === 'object'
      ? raw.operation
      : { id: eventId, kind: 'run' as const, attempt: 1 };
  const outcome =
    raw.outcome && typeof raw.outcome === 'object' ? raw.outcome : outcomeForStatus(status);
  return {
    ...(raw as MissionOrchestrationJournalEntry),
    operation: {
      id: typeof operation.id === 'string' ? operation.id : eventId,
      kind:
        operation.kind === 'compaction' ||
        operation.kind === 'handoff' ||
        operation.kind === 'checkpoint'
          ? operation.kind
          : 'run',
      attempt:
        typeof operation.attempt === 'number' &&
        Number.isInteger(operation.attempt) &&
        operation.attempt > 0
          ? operation.attempt
          : 1,
    },
    outcome: {
      status:
        outcome.status === 'completed' ||
        outcome.status === 'declined' ||
        outcome.status === 'aborted' ||
        outcome.status === 'failed' ||
        outcome.status === 'suspended'
          ? outcome.status
          : outcomeForStatus(status).status,
      ...(typeof outcome.reason === 'string' ? { reason: outcome.reason } : {}),
    },
  };
}

/** Purely reduce the durable operation records; no filesystem or clock access. */
export function reduceMissionState(
  records: readonly MissionOrchestrationJournalEntry[]
): ReducedMissionState {
  const operations: Record<string, ReducedMissionOperation> = {};
  for (const raw of records) {
    const entry = normalizeJournalEntry(raw);
    const previous = operations[entry.operation.id];
    if (previous && entry.operation.attempt < previous.operation.attempt) {
      throw new Error(`MISSION_LOG_CORRUPT:operation_attempt_regression:${entry.operation.id}`);
    }
    operations[entry.operation.id] = {
      event_id: entry.event_id,
      operation: entry.operation,
      outcome: entry.outcome,
      status: entry.status,
    };
  }
  const pending = Object.values(operations).filter((entry) => entry.outcome.status !== 'completed');
  const failed = pending.find((entry) => entry.outcome.status === 'failed') ?? null;
  return {
    operations,
    pending_operation_ids: pending.map((entry) => entry.operation.id),
    terminal_failure: failed,
  };
}

export function appendMissionOrchestrationJournalEntry(input: {
  missionId: string;
  eventId: string;
  eventType: MissionOrchestrationEventType;
  status: MissionOrchestrationJournalStatus;
  payload: unknown;
  requestedBy?: string;
  causationId?: string;
  correlationId?: string;
  scope?: EventScope;
  missionPathHint?: string;
  operation?: Partial<Pick<MissionOperation, 'id' | 'kind' | 'attempt'>>;
  outcome?: MissionOperationOutcome;
}): MissionOrchestrationJournalEntry {
  const scope = input.scope;
  const journalMissionPath = input.missionPathHint || missionPathForScope(input.missionId, scope);
  ensureJournalDir(input.missionId, scope);
  const entry: MissionOrchestrationJournalEntry = {
    ts: new Date().toISOString(),
    event_id: input.eventId,
    event_type: input.eventType,
    mission_id: input.missionId.toUpperCase(),
    status: input.status,
    payload_hash: payloadHash(input.payload),
    operation: resolveOperation(input),
    outcome: input.outcome || outcomeForStatus(input.status),
    ...(input.requestedBy ? { requested_by: input.requestedBy } : {}),
    ...(input.causationId ? { causation_id: input.causationId } : {}),
    ...(input.correlationId ? { correlation_id: input.correlationId } : {}),
    ...(scope ? { scope } : {}),
  };
  const leasePath = `${journalMissionPath}/coordination/writer-lease.json`;
  return withFencedWriterLeaseSync({
    resourceId: writerLeaseResourceId(leasePath),
    ownerId: `process:${process.pid}`,
    leasePath,
    fn: () => {
      appendJsonLine(`${journalMissionPath}/coordination/orchestration-journal.jsonl`, entry);
      return entry;
    },
  });
}

export function appendMissionOrchestrationJournalStatus(input: {
  missionId: string;
  eventId: string;
  eventType: MissionOrchestrationEventType;
  status: MissionOrchestrationJournalStatus;
  payload: unknown;
  requestedBy?: string;
  causationId?: string;
  correlationId?: string;
  scope?: EventScope;
  missionPathHint?: string;
}): MissionOrchestrationJournalEntry {
  return appendMissionOrchestrationJournalEntry(input);
}

export function loadMissionOrchestrationJournal(
  missionId: string,
  scope?: EventScope
): MissionOrchestrationJournalEntry[] {
  const filePath = journalPath(missionId, scope);
  if (!safeExistsSync(filePath)) return [];
  const raw = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
  return raw
    .split(/\r?\n/u)
    .map((line, index) => ({ line: line.trim(), lineNumber: index + 1 }))
    .filter((entry) => Boolean(entry.line))
    .map(({ line, lineNumber }) => {
      try {
        return normalizeJournalEntry(JSON.parse(line) as Partial<MissionOrchestrationJournalEntry>);
      } catch (error) {
        throw new Error(`MISSION_LOG_CORRUPT:journal_entry_unreadable:${lineNumber}`, {
          cause: error,
        });
      }
    });
}

export function loadMissionOrchestrationReplayPlan(
  missionId: string,
  scope?: EventScope
): MissionOrchestrationReplayPlan {
  const eventsDirectory = eventDir();
  const eventFiles = safeExistsSync(eventsDirectory)
    ? safeReaddir(eventsDirectory)
        .filter((name) => name.endsWith('.json'))
        .sort()
    : [];
  const events: MissionOrchestrationEvent[] = [];
  for (const fileName of eventFiles) {
    const eventPath = `${eventsDirectory}/${fileName}`;
    try {
      const event = loadMissionOrchestrationEvent(eventPath);
      if (
        event.mission_id === missionId.toUpperCase() &&
        (!scope || (event.scope && eventScopeMatches(event.scope, scope)))
      ) {
        events.push(event);
      }
    } catch {
      // Ignore unreadable legacy artifacts.
    }
  }
  events.sort((left, right) => left.created_at.localeCompare(right.created_at));

  const journalEntries = loadMissionOrchestrationJournal(missionId, scope);
  const reduced = reduceMissionState(journalEntries);

  let lastCompletedIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const reducedOperation = reduced.operations[events[index].event_id];
    if (reducedOperation?.outcome.status === 'completed') {
      lastCompletedIndex = index;
    }
  }

  const pendingEvents = events.slice(lastCompletedIndex + 1).filter((event) => {
    return reduced.operations[event.event_id]?.outcome.status !== 'completed';
  });

  return {
    last_completed_event_id:
      lastCompletedIndex >= 0 ? events[lastCompletedIndex].event_id : undefined,
    next_event: pendingEvents[0] || null,
    pending_event_ids: pendingEvents.map((event) => event.event_id),
    replay_count: pendingEvents.length,
  };
}
