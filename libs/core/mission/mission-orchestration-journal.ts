import { appendJsonLine, readJson, readJsonLines } from '../foundation/json.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { isRecord, readTextFile } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import * as crypto from 'node:crypto';
import * as nodePath from 'node:path';
import { isPathInside, pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeWriteFile,
  safeReaddir,
  safeLstat,
  safeAppendFileSync,
} from '../secure-io.js';
import { loadMissionOrchestrationEvent } from './mission-orchestration-event-loader.js';
import type {
  MissionOrchestrationEvent,
  MissionOrchestrationEventType,
} from './mission-orchestration-event-contract.js';
import {
  eventScopeMatches,
  normalizeEventScope,
  type EventScope,
  type EventScopeInput,
} from '../event-scope.js';
import {
  withFencedWriterLeaseSync,
  withWriterLeaseSnapshotSync,
  writerLeaseResourceId,
} from '../writer-lease.js';
import { resolveMissionDir, tryResolveOwnerScope, type OwnerScopeHint } from '../owner-scope.js';
import { createLogger, formatDiagnostic } from '../logger.js';
import { validateMissionBlueprint } from './mission-blueprint-validation.js';

const logger = createLogger('mission-next-tasks');

export type MissionOrchestrationJournalStatus = 'enqueued' | 'completed' | 'failed';

export type MissionOperationKind = 'run' | 'compaction' | 'handoff' | 'checkpoint';
export type MissionOperationOutcomeStatus =
  'pending' | 'completed' | 'declined' | 'aborted' | 'failed' | 'suspended';

export type MissionReplayRecoveryReason =
  'unverified_provisioned_entries' | 'missing_provisioned_entries';

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

const PROVISIONED_ENTRY_RECORD_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-provisioned-entry-record.schema.json'
);
const PROVISIONED_ENTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-provisioned-entry.schema.json'
);
const provisionedEntryRecordCatalog = defineCatalog<ProvisionedEntryRecord>({
  id: 'mission-provisioned-entry-record',
  path: PROVISIONED_ENTRY_RECORD_SCHEMA_PATH,
  schema: PROVISIONED_ENTRY_RECORD_SCHEMA_PATH,
});

function provisionedEntryCatalog(sourcePath: string) {
  return defineCatalog<ProvisionedEntry>({
    id: 'mission-provisioned-entry',
    path: sourcePath,
    schema: PROVISIONED_ENTRY_SCHEMA_PATH,
  });
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

const MISSION_ORCHESTRATION_JOURNAL_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-orchestration-journal-entry.schema.json'
);

function missionOrchestrationJournalCatalog(sourcePath: string) {
  return defineCatalog<MissionOrchestrationJournalEntry>({
    id: 'mission-orchestration-journal-entry',
    path: sourcePath,
    schema: MISSION_ORCHESTRATION_JOURNAL_SCHEMA_PATH,
  });
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
  recovery_required: boolean;
  recovery_reason?: MissionReplayRecoveryReason;
  unverified_provisioned_entries: ProvisionedEntryRecord[];
  missing_provisioned_entries: ProvisionedEntryRecord[];
}

/** An event scope only narrows the mission's own location (owner-scope hint). */
function ownerHintForScope(scope?: EventScope): OwnerScopeHint | undefined {
  if (!scope) return undefined;
  return {
    tier: scope.tier,
    ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}),
  };
}

/**
 * Directory of the existing mission, derived from where it actually lives.
 * Fails closed (OwnerScopeError) when the mission is unknown or the event
 * scope contradicts it — a journal write is never placed by a guessed tier.
 */
function missionPathForScope(missionId: string, scope?: EventScope): string {
  return assertSafeRepositoryPath(resolveMissionDir(missionId, ownerHintForScope(scope)), {
    allowMissingLeaf: true,
  });
}

/** Like missionPathForScope, but null for an unknown mission (read paths). */
function existingMissionPathForScope(missionId: string, scope?: EventScope): string | null {
  const owner = tryResolveOwnerScope({ kind: 'mission', id: missionId }, ownerHintForScope(scope));
  return owner ? assertSafeRepositoryPath(owner.dir, { allowMissingLeaf: true }) : null;
}

function journalDir(missionId: string, scope?: EventScope): string {
  return assertSafeRepositoryPath(
    nodePath.join(missionPathForScope(missionId, scope), 'coordination'),
    { allowMissingLeaf: true }
  );
}

function readJournalDir(
  missionId: string,
  scope?: EventScope,
  missionPathHint?: string
): string | null {
  if (missionPathHint) return writeJournalDir(missionId, scope, missionPathHint);
  const missionPath = existingMissionPathForScope(missionId, scope);
  return missionPath
    ? assertSafeRepositoryPath(nodePath.join(missionPath, 'coordination'), {
        allowMissingLeaf: true,
      })
    : null;
}

function journalPath(
  missionId: string,
  scope?: EventScope,
  missionPathHint?: string
): string | null {
  const dir = readJournalDir(missionId, scope, missionPathHint);
  return dir
    ? assertSafeRepositoryPath(nodePath.join(dir, 'orchestration-journal.jsonl'), {
        allowMissingLeaf: true,
      })
    : null;
}

function provisionedEntriesPath(missionId: string, scope?: EventScope): string | null {
  const dir = readJournalDir(missionId, scope);
  return dir
    ? assertSafeRepositoryPath(nodePath.join(dir, 'provisioned-entries.jsonl'), {
        allowMissingLeaf: true,
      })
    : null;
}

function writeJournalDir(missionId: string, scope?: EventScope, missionPathHint?: string): string {
  if (!missionPathHint) return journalDir(missionId, scope);
  return assertSafeRepositoryPath(
    nodePath.join(
      assertSafeRepositoryPath(missionPathHint, { allowMissingLeaf: true }),
      'coordination'
    ),
    { allowMissingLeaf: true }
  );
}

function artifactPath(filePath: string): string {
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
}

function assertRegularArtifactPath(filePath: string): string {
  const safePath = artifactPath(filePath);
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_unreadable');
  }
  return safePath;
}

function writeProvisionedEntryRecord(
  recordPath: string,
  input: {
    missionId: string;
    entry: ProvisionedEntry;
    targetPath: string;
    phase: ProvisionedEntryRecordPhase;
  }
): ProvisionedEntryRecord {
  const record: ProvisionedEntryRecord = {
    ts: nowIso(),
    entry_id: input.entry.id,
    content_hash: input.entry.content_hash,
    target_path: input.targetPath,
    phase: input.phase,
  };
  const safeRecordPath = artifactPath(recordPath);
  const validated = provisionedEntryRecordCatalog.validate(record, safeRecordPath);
  safeMkdir(nodePath.dirname(safeRecordPath), { recursive: true });
  appendJsonLine(safeRecordPath, validated);
  return validated;
}

function eventDir(): string {
  return pathResolver.shared(`coordination/orchestration/events`);
}

function ensureJournalDir(missionId: string, scope?: EventScope, missionPathHint?: string): void {
  safeMkdir(writeJournalDir(missionId, scope, missionPathHint));
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

function normalizeProvisionedEntryRecord(value: unknown): ProvisionedEntryRecord | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.entry_id !== 'string' ||
    typeof value.content_hash !== 'string' ||
    typeof value.target_path !== 'string' ||
    typeof value.ts !== 'string' ||
    (value.phase !== 'provisioned' && value.phase !== 'verified')
  ) {
    return undefined;
  }
  return {
    ts: value.ts,
    entry_id: value.entry_id,
    content_hash: value.content_hash,
    target_path: value.target_path,
    phase: value.phase,
  };
}

function loadProvisionedEntryRecordAtLine(
  value: unknown,
  sourcePath: string
): ProvisionedEntryRecord {
  const validated = provisionedEntryRecordCatalog.validate(value, sourcePath);
  const normalized = normalizeProvisionedEntryRecord(validated);
  if (!normalized) throw new Error('record shape');
  return normalized;
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
  const validated = provisionedEntryCatalog('provisioned-entry').validate(
    persisted,
    'provisioned-entry'
  );
  const candidate = validated as Partial<PersistedProvisionedEntry<TContent>> | null;
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
  const safeFilePath = artifactPath(filePath);
  const validated = provisionedEntryCatalog(safeFilePath).validate(provisioned, safeFilePath);
  safeWriteFile(safeFilePath, `${JSON.stringify(validated, null, 2)}\n`);
  return readProvisionedEntry(safeFilePath, provisioned);
}

/** Read and verify a provisioned artifact during resume/reconciliation. */
export function readProvisionedEntry<TContent>(
  filePath: string,
  provisioned: ProvisionedEntry<TContent>
): PersistedProvisionedEntry<TContent> {
  const safeFilePath = artifactPath(filePath);
  let persisted: unknown;
  try {
    persisted = readJson<unknown>(assertRegularArtifactPath(safeFilePath));
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
  missionPathHint?: string;
}): ProvisionedEntryRecord {
  const writeDir = writeJournalDir(input.missionId, input.scope, input.missionPathHint);
  const recordPath = nodePath.join(writeDir, 'provisioned-entries.jsonl');
  const leasePath = nodePath.join(writeDir, 'writer-lease.json');
  return withFencedWriterLeaseSync({
    resourceId: writerLeaseResourceId(leasePath),
    ownerId: `process:${process.pid}`,
    leasePath,
    fn: () => {
      return writeProvisionedEntryRecord(recordPath, input);
    },
  });
}

export function loadProvisionedEntryRecords(
  missionId: string,
  scope?: EventScope
): ProvisionedEntryRecord[] {
  const filePath = provisionedEntriesPath(missionId, scope);
  if (!filePath || !safeExistsSync(filePath)) return [];
  if (!safeLstat(filePath).isFile()) {
    throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_record_file`);
  }
  return readJsonLines<ProvisionedEntryRecord>(filePath, {
    map: (value, lineNumber) =>
      loadProvisionedEntryRecordAtLine(value, `${filePath}:${lineNumber}`),
    onMalformed: (error, lineNumber) => {
      throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_record:${lineNumber}`, {
        cause: error,
      });
    },
  });
}

/**
 * Return provision receipts that never reached their verified phase. A
 * verified receipt without a preceding provisioned receipt is itself corrupt:
 * accepting it would make a partial write look durable during resume.
 */
export function findUnverifiedProvisionedEntries(
  records: readonly ProvisionedEntryRecord[]
): ProvisionedEntryRecord[] {
  const pending = new Map<string, ProvisionedEntryRecord>();
  for (const record of records) {
    if (record.phase === 'provisioned') {
      if (pending.has(record.entry_id)) {
        throw new Error(`MISSION_LOG_CORRUPT:duplicate_provisioned_entry:${record.entry_id}`);
      }
      pending.set(record.entry_id, record);
      continue;
    }
    if (!pending.delete(record.entry_id)) {
      throw new Error(`MISSION_LOG_CORRUPT:verified_entry_without_provision:${record.entry_id}`);
    }
  }
  return [...pending.values()];
}

function provisionedTargetPath(
  missionId: string,
  record: ProvisionedEntryRecord,
  scope?: EventScope
): string {
  if (!record.target_path || nodePath.isAbsolute(record.target_path)) {
    throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_scope:${record.entry_id}`);
  }
  const missionPath = missionPathForScope(missionId, scope);
  const resolved = nodePath.resolve(missionPath, record.target_path);
  if (resolved !== missionPath && !isPathInside(missionPath, resolved)) {
    throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_scope:${record.entry_id}`);
  }
  return artifactPath(resolved);
}

/**
 * Check verified receipts against their current mission-local artifact. A
 * missing target is recoverable through the operator reconciliation scaffold;
 * a present target with a different hash is log corruption and must stop
 * replay immediately.
 */
export function findMissingProvisionedEntries(
  missionId: string,
  records: readonly ProvisionedEntryRecord[],
  scope?: EventScope
): ProvisionedEntryRecord[] {
  // A mission artifact can be intentionally rewritten (for example when a
  // task status advances). Only the latest verified receipt for each target
  // describes the bytes that are expected to exist now; older receipts are
  // historical evidence, not current-state assertions.
  const latestVerifiedByTarget = new Map<string, ProvisionedEntryRecord>();
  for (const record of records) {
    if (record.phase === 'verified') latestVerifiedByTarget.set(record.target_path, record);
  }

  const missing: ProvisionedEntryRecord[] = [];
  for (const record of latestVerifiedByTarget.values()) {
    const targetPath = provisionedTargetPath(missionId, record, scope);
    if (!safeExistsSync(targetPath)) {
      missing.push(record);
      continue;
    }
    if (!safeLstat(targetPath).isFile()) {
      throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_unreadable:${record.entry_id}`);
    }

    let raw: string;
    try {
      raw = readTextFile(targetPath);
    } catch (error) {
      throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_unreadable:${record.entry_id}`, {
        cause: error,
      });
    }
    if (provisionedEntryHash(raw) === record.content_hash) continue;

    try {
      const parsed = readJson<unknown>(targetPath);
      if (provisionedEntryHash(parsed) === record.content_hash) continue;
    } catch {
      // Native text artifacts are expected to fail JSON parsing; their raw
      // content was already checked above.
    }
    throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_mismatch:${record.entry_id}`);
  }
  return missing;
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
  missionPathHint?: string;
}): TContent {
  const { provisioned, ...target } = input;
  return writeProvisionedJsonFrom({ ...target, build: () => provisioned }) as TContent;
}

/**
 * Advisory blueprint check at the NEXT_TASKS write boundary: error-severity
 * findings surface as diagnostics, warnings stay at debug. The write itself
 * is never blocked — kickoff and rebuilds legitimately write boards in
 * stages, and readers keep their own graph checks.
 */
function reportNextTasksBlueprint(missionId: string, board: unknown): void {
  for (const message of validateMissionBlueprint(board)) {
    const why = `${message.code}: ${message.message}${message.subject_id ? ` [${message.subject_id}]` : ''}`;
    if (message.severity === 'error') {
      logger.warn(
        formatDiagnostic({
          component: 'mission-next-tasks',
          what: `NEXT_TASKS.json blueprint violation in ${missionId}`,
          why,
          next: 'repair the task board or re-plan (the write was advisory-recorded, not blocked)',
          evidence: 'NEXT_TASKS.json',
        })
      );
    } else {
      logger.debug(
        formatDiagnostic({
          component: 'mission-next-tasks',
          what: `NEXT_TASKS.json blueprint note in ${missionId}`,
          why,
          evidence: 'NEXT_TASKS.json',
        })
      );
    }
  }
}

/**
 * {@link writeProvisionedJson} whose entry is built under the writer lease, so
 * a read-modify-write of the artifact sees no other writer between its read
 * and its write. `build` runs inside the lease and must not take it again;
 * returning `undefined` writes nothing.
 */
export function writeProvisionedJsonFrom<TContent>(input: {
  missionId: string;
  filePath: string;
  targetPath: string;
  build: () => ProvisionedEntry<TContent> | undefined;
  scope?: EventScope;
  missionPathHint?: string;
}): TContent | undefined {
  const writeDir = writeJournalDir(input.missionId, input.scope, input.missionPathHint);
  const recordPath = nodePath.join(writeDir, 'provisioned-entries.jsonl');
  const leasePath = nodePath.join(writeDir, 'writer-lease.json');
  return withFencedWriterLeaseSync({
    resourceId: writerLeaseResourceId(leasePath),
    ownerId: `process:${process.pid}`,
    leasePath,
    fn: () => {
      const provisioned = input.build();
      if (!provisioned) return undefined;
      if (input.targetPath === 'NEXT_TASKS.json') {
        reportNextTasksBlueprint(input.missionId, provisioned.content);
      }
      writeProvisionedEntryRecord(recordPath, {
        missionId: input.missionId,
        entry: provisioned,
        targetPath: input.targetPath,
        phase: 'provisioned',
      });
      const safeFilePath = artifactPath(input.filePath);
      safeWriteFile(safeFilePath, `${JSON.stringify(provisioned.content, null, 2)}\n`);
      let content: unknown;
      try {
        content = readJson<unknown>(assertRegularArtifactPath(safeFilePath));
      } catch {
        throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_unreadable');
      }
      verifyProvisionedEntry(provisioned, {
        id: provisioned.id,
        content,
        content_hash: provisioned.content_hash,
      });
      writeProvisionedEntryRecord(recordPath, {
        missionId: input.missionId,
        entry: provisioned,
        targetPath: input.targetPath,
        phase: 'verified',
      });
      return content as TContent;
    },
  });
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
  missionPathHint?: string;
}): string {
  const writeDir = writeJournalDir(input.missionId, input.scope, input.missionPathHint);
  const recordPath = nodePath.join(writeDir, 'provisioned-entries.jsonl');
  const leasePath = nodePath.join(writeDir, 'writer-lease.json');
  return withFencedWriterLeaseSync({
    resourceId: writerLeaseResourceId(leasePath),
    ownerId: `process:${process.pid}`,
    leasePath,
    fn: () => {
      writeProvisionedEntryRecord(recordPath, {
        missionId: input.missionId,
        entry: input.provisioned,
        targetPath: input.targetPath,
        phase: 'provisioned',
      });
      const safeFilePath = artifactPath(input.filePath);
      safeWriteFile(safeFilePath, input.provisioned.content);
      const content = readTextFile(assertRegularArtifactPath(safeFilePath));
      if (content !== input.provisioned.content) {
        throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_mismatch');
      }
      writeProvisionedEntryRecord(recordPath, {
        missionId: input.missionId,
        entry: input.provisioned,
        targetPath: input.targetPath,
        phase: 'verified',
      });
      return content;
    },
  });
}

/** Append bytes and their whole-file receipt under the same writer lease. */
export function appendProvisionedText(input: {
  missionId: string;
  filePath: string;
  targetPath: string;
  content: string;
  missionPathHint?: string;
  scope?: EventScope;
  /** Explicit operator repair only; the old writer receipted an empty ledger once. */
  repairLegacyEmptyLedger?: boolean;
  validateContent?: (content: string) => void;
}): boolean {
  const writeDir = writeJournalDir(input.missionId, input.scope, input.missionPathHint);
  const recordPath = nodePath.join(writeDir, 'provisioned-entries.jsonl');
  const leasePath = nodePath.join(writeDir, 'writer-lease.json');
  const file = artifactPath(input.filePath);
  const expected = nodePath.resolve(writeDir, '..', input.targetPath);
  if (file !== expected || !isPathInside(nodePath.resolve(writeDir, '..'), expected)) {
    throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_scope');
  }
  return withFencedWriterLeaseSync({
    resourceId: writerLeaseResourceId(leasePath),
    ownerId: `process:${process.pid}`,
    leasePath,
    fn: () => {
      const records = safeExistsSync(recordPath)
        ? readJsonLines<ProvisionedEntryRecord>(recordPath, {
            map: (value, line) => loadProvisionedEntryRecordAtLine(value, `${recordPath}:${line}`),
            onMalformed: () => {
              throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_record');
            },
          }).filter((record) => record.target_path === input.targetPath)
        : [];
      if (findUnverifiedProvisionedEntries(records).length) {
        throw new Error('MISSION_LOG_CORRUPT:unverified_provisioned_entries');
      }
      const current = safeExistsSync(file) ? readTextFile(assertRegularArtifactPath(file)) : '';
      input.validateContent?.(current + input.content);
      const latest = records.at(-1);
      const matches = latest?.content_hash === provisionedEntryHash(current);
      const legacyEmpty =
        input.repairLegacyEmptyLedger &&
        input.targetPath === 'execution-ledger.jsonl' &&
        records.length === 2 &&
        records[0].phase === 'provisioned' &&
        records[1].phase === 'verified' &&
        records[0].entry_id === records[1].entry_id &&
        records.every((record) => record.content_hash === provisionedEntryHash(''));
      if (latest && !matches && !legacyEmpty) {
        throw new Error(`MISSION_LOG_CORRUPT:provisioned_entry_mismatch:${latest.entry_id}`);
      }
      if (!latest && current) throw new Error('MISSION_LOG_CORRUPT:unreceipted_text');
      if (input.repairLegacyEmptyLedger && (matches || !legacyEmpty)) return false;
      const provisioned = provisionMissionEntry(current + input.content);
      writeProvisionedEntryRecord(recordPath, {
        missionId: input.missionId,
        entry: provisioned,
        targetPath: input.targetPath,
        phase: 'provisioned',
      });
      safeMkdir(nodePath.dirname(file), { recursive: true });
      safeAppendFileSync(file, input.content);
      if (readTextFile(assertRegularArtifactPath(file)) !== provisioned.content) {
        throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_mismatch');
      }
      writeProvisionedEntryRecord(recordPath, {
        missionId: input.missionId,
        entry: provisioned,
        targetPath: input.targetPath,
        phase: 'verified',
      });
      return true;
    },
  });
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
  missionPathHint?: string;
  operation?: Partial<Pick<MissionOperation, 'id' | 'kind' | 'attempt'>>;
}): MissionOperation {
  const operationId = input.operation?.id || input.eventId;
  const previous = loadMissionOrchestrationJournal(
    input.missionId,
    input.scope,
    input.missionPathHint
  )
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

function normalizeJournalEntry(raw: unknown): MissionOrchestrationJournalEntry {
  if (!isRecord(raw)) throw new Error('record shape');
  const eventId = typeof raw.event_id === 'string' ? raw.event_id : '';
  const status = raw.status === 'completed' || raw.status === 'failed' ? raw.status : 'enqueued';
  const operation = isRecord(raw.operation)
    ? raw.operation
    : { id: eventId, kind: 'run' as const, attempt: 1 };
  const outcome = isRecord(raw.outcome) ? raw.outcome : outcomeForStatus(status);
  if (
    typeof raw.ts !== 'string' ||
    typeof raw.event_type !== 'string' ||
    typeof raw.mission_id !== 'string' ||
    typeof raw.payload_hash !== 'string' ||
    typeof raw.status !== 'string' ||
    !['enqueued', 'completed', 'failed'].includes(raw.status)
  ) {
    throw new Error('record shape');
  }
  if (raw.scope !== undefined && !isRecord(raw.scope)) throw new Error('record scope shape');
  let scope: EventScope | undefined;
  if (isRecord(raw.scope)) {
    try {
      scope = normalizeEventScope(raw.scope as unknown as EventScopeInput);
    } catch (error) {
      throw new Error('record scope shape', { cause: error });
    }
  }
  return {
    ts: raw.ts,
    event_id: eventId,
    event_type: raw.event_type as MissionOrchestrationEventType,
    mission_id: raw.mission_id,
    status: raw.status as MissionOrchestrationJournalStatus,
    payload_hash: raw.payload_hash,
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
    ...(typeof raw.requested_by === 'string' ? { requested_by: raw.requested_by } : {}),
    ...(typeof raw.causation_id === 'string' ? { causation_id: raw.causation_id } : {}),
    ...(typeof raw.correlation_id === 'string' ? { correlation_id: raw.correlation_id } : {}),
    ...(scope ? { scope } : {}),
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
  const journalMissionPath = input.missionPathHint
    ? assertSafeRepositoryPath(input.missionPathHint, { allowMissingLeaf: true })
    : missionPathForScope(input.missionId, scope);
  ensureJournalDir(input.missionId, scope, input.missionPathHint);
  const entry: MissionOrchestrationJournalEntry = {
    ts: nowIso(),
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
  const journalFilePath = assertSafeRepositoryPath(
    `${journalMissionPath}/coordination/orchestration-journal.jsonl`,
    { allowMissingLeaf: true }
  );
  const validatedEntry = missionOrchestrationJournalCatalog(journalFilePath).validate(
    entry,
    journalFilePath
  );
  const leasePath = assertSafeRepositoryPath(
    nodePath.join(journalMissionPath, 'coordination', 'writer-lease.json'),
    { allowMissingLeaf: true }
  );
  return withFencedWriterLeaseSync({
    resourceId: writerLeaseResourceId(leasePath),
    ownerId: `process:${process.pid}`,
    leasePath,
    fn: () => {
      appendJsonLine(journalFilePath, validatedEntry);
      return validatedEntry;
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
  scope?: EventScope,
  missionPathHint?: string
): MissionOrchestrationJournalEntry[] {
  const filePath = journalPath(missionId, scope, missionPathHint);
  if (!filePath || !safeExistsSync(filePath)) return [];
  if (!safeLstat(filePath).isFile()) {
    throw new Error('MISSION_LOG_CORRUPT:journal_file_not_regular');
  }
  return readJsonLines<MissionOrchestrationJournalEntry>(filePath, {
    map: (value, lineNumber) => {
      const validated = missionOrchestrationJournalCatalog(filePath).validate(
        value,
        `${filePath}:${lineNumber}`
      );
      return normalizeJournalEntry(validated);
    },
    onMalformed: (error, lineNumber) => {
      throw new Error(`MISSION_LOG_CORRUPT:journal_entry_unreadable:${lineNumber}`, {
        cause: error,
      });
    },
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

  const readSnapshot = () => {
    const journalEntries = loadMissionOrchestrationJournal(missionId, scope);
    const reduced = reduceMissionState(journalEntries);
    const provisionedRecords = loadProvisionedEntryRecords(missionId, scope);
    const unverifiedProvisionedEntries = findUnverifiedProvisionedEntries(provisionedRecords);
    const missingProvisionedEntries =
      unverifiedProvisionedEntries.length > 0
        ? []
        : findMissingProvisionedEntries(missionId, provisionedRecords, scope);
    return { reduced, unverifiedProvisionedEntries, missingProvisionedEntries };
  };
  const directory = readJournalDir(missionId, scope);
  const { reduced, unverifiedProvisionedEntries, missingProvisionedEntries } = directory
    ? withWriterLeaseSnapshotSync(nodePath.join(directory, 'writer-lease.json'), readSnapshot)
    : readSnapshot();
  const recoveryRequired =
    unverifiedProvisionedEntries.length > 0 || missingProvisionedEntries.length > 0;

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
    next_event: recoveryRequired ? null : pendingEvents[0] || null,
    pending_event_ids: pendingEvents.map((event) => event.event_id),
    replay_count: pendingEvents.length,
    recovery_required: recoveryRequired,
    ...(recoveryRequired
      ? {
          recovery_reason:
            unverifiedProvisionedEntries.length > 0
              ? ('unverified_provisioned_entries' as const)
              : ('missing_provisioned_entries' as const),
        }
      : {}),
    unverified_provisioned_entries: unverifiedProvisionedEntries,
    missing_provisioned_entries: missingProvisionedEntries,
  };
}

/**
 * Operator-repair only: re-baseline the receipt chain to the CURRENT bytes.
 * A provisioned receipt binds the whole file, so a ledger that grew through
 * an unreceipted writer is honest content but fails the append-time check
 * forever. The content is validated BEFORE the receipt is issued — this
 * attests existing bytes, it can never mint new history. Callable only
 * from the operator repair facade (repairLegacyMissionExecutionLedger),
 * never from ordinary append or resume paths.
 */
export function receiptCurrentProvisionedText(input: {
  missionId: string;
  filePath: string;
  targetPath: string;
  missionPathHint?: string;
  scope?: EventScope;
  validateContent?: (content: string) => void;
}): boolean {
  const writeDir = writeJournalDir(input.missionId, input.scope, input.missionPathHint);
  const recordPath = nodePath.join(writeDir, 'provisioned-entries.jsonl');
  const leasePath = nodePath.join(writeDir, 'writer-lease.json');
  const file = artifactPath(input.filePath);
  const expected = nodePath.resolve(writeDir, '..', input.targetPath);
  if (file !== expected || !isPathInside(nodePath.resolve(writeDir, '..'), expected)) {
    throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_scope');
  }
  return withFencedWriterLeaseSync({
    resourceId: writerLeaseResourceId(leasePath),
    ownerId: `process:${process.pid}`,
    leasePath,
    fn: () => {
      const records = safeExistsSync(recordPath)
        ? readJsonLines<ProvisionedEntryRecord>(recordPath, {
            map: (value, line) => loadProvisionedEntryRecordAtLine(value, `${recordPath}:${line}`),
            onMalformed: () => {
              throw new Error('MISSION_LOG_CORRUPT:provisioned_entry_record');
            },
          }).filter((record) => record.target_path === input.targetPath)
        : [];
      if (findUnverifiedProvisionedEntries(records).length) {
        throw new Error('MISSION_LOG_CORRUPT:unverified_provisioned_entries');
      }
      const current = safeExistsSync(file) ? readTextFile(assertRegularArtifactPath(file)) : '';
      // Content validity is proven before the receipt is issued — the
      // receipt attests what is on disk, nothing else.
      input.validateContent?.(current);
      const latest = records.at(-1);
      if (latest?.content_hash === provisionedEntryHash(current)) return false;
      const provisioned = provisionMissionEntry(current);
      writeProvisionedEntryRecord(recordPath, {
        missionId: input.missionId,
        entry: provisioned,
        targetPath: input.targetPath,
        phase: 'provisioned',
      });
      writeProvisionedEntryRecord(recordPath, {
        missionId: input.missionId,
        entry: provisioned,
        targetPath: input.targetPath,
        phase: 'verified',
      });
      return true;
    },
  });
}
