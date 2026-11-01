/** Work-coordination append-only ledger internals: roots, mutation fence, JSONL/state writers. */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { appendJsonLine, writeJson } from '../foundation/json.js';
import { streamJsonLines } from '../jsonl-read.js';
import { maintainStoreAfterAppend } from '../append-only-store.js';
import { logger } from '../core.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { nowIso } from '../foundation/time.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { withExecutionContext } from '../authority.js';
import { selectCurrentWorkItems } from './work-coordination-snapshot.js';
import { latestById } from './work-coordination-inventory.js';
import { validateWorkItem } from './work-coordination-identity.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { WORK_COORDINATION_ROOT_PATH } from '../foundation/runtime-state-roots.js';
import type {
  AppendCoordinationEventInput,
  CoordinationEvent,
  WorkCoordinationEventType,
  WorkItem,
  WorkItemAttempt,
  WorkLease,
} from './work-coordination-types.js';

const STORE_ROOT = WORK_COORDINATION_ROOT_PATH;
const OBS_ROOT = 'active/shared/observability/work-coordination';

let coordinationNamespaceOverride: string | null = null;
export let coordinationRootOverride: string | null = null;

export function setWorkCoordinationNamespace(namespace: string | null | undefined): void {
  coordinationNamespaceOverride = namespace ? normalizeCoordinationNamespace(namespace) : null;
}

export function clearWorkCoordinationNamespace(): void {
  coordinationNamespaceOverride = null;
}

export function withCoordinationRoot<T>(rootDir: string | undefined, fn: () => T): T {
  const previousRoot = coordinationRootOverride;
  coordinationRootOverride = rootDir ? path.resolve(rootDir) : null;
  try {
    return fn();
  } finally {
    coordinationRootOverride = previousRoot;
  }
}

export function randomId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function coordinationNamespace(): string {
  const configured =
    coordinationNamespaceOverride ||
    String(getRegisteredEnvText('KYBERION_WORK_COORDINATION_NAMESPACE') || '').trim();
  return configured ? normalizeCoordinationNamespace(configured) : '';
}

function normalizeCoordinationNamespace(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized || normalized === '.' || normalized === '..' || /[\\/\0]/u.test(normalized)) {
    throw new Error(`[RESOURCE_PATH_SCOPE] invalid work coordination namespace: ${value}`);
  }
  return normalized;
}

export function coordinationBase(): string {
  const base = path.resolve(coordinationRootOverride || pathResolver.rootDir());
  assertSafeRepositoryPath(path.join(base, '.work-coordination-root'), {
    allowMissingLeaf: true,
  });
  return base;
}

export function runtimeRoot(): string {
  const namespace = coordinationNamespace();
  const base = coordinationBase();
  return assertSafeRepositoryPath(
    pathResolver.vitestLivePath(
      path.resolve(base, namespace ? `${STORE_ROOT}/${namespace}` : STORE_ROOT)
    ),
    { allowMissingLeaf: true }
  );
}

const heldCoordinationMutations = new Set<string>();
/** All item/lease/event transitions share one synchronous reentrant inter-process fence. */
export function withCoordinationMutation<T>(fn: () => T): T {
  const key = crypto.createHash('sha256').update(runtimeRoot()).digest('hex');
  if (heldCoordinationMutations.has(key)) return fn();
  return withExecutionContext('infrastructure_sentinel', () =>
    withLockSync(`work-coordination:${key}`, () => {
      heldCoordinationMutations.add(key);
      try {
        return fn();
      } finally {
        heldCoordinationMutations.delete(key);
      }
    })
  );
}

export function observabilityRoot(): string {
  const namespace = coordinationNamespace();
  const base = coordinationBase();
  return assertSafeRepositoryPath(
    pathResolver.vitestLivePath(
      path.resolve(base, namespace ? `${OBS_ROOT}/${namespace}` : OBS_ROOT)
    ),
    { allowMissingLeaf: true }
  );
}

export function itemsPath(): string {
  return `${runtimeRoot()}/items.jsonl`;
}

export function leasesPath(): string {
  return `${runtimeRoot()}/leases.jsonl`;
}

export function boardsPath(): string {
  return `${runtimeRoot()}/boards.json`;
}

export function eventsPath(): string {
  return `${observabilityRoot()}/events.jsonl`;
}

export function ensureStore(): void {
  safeMkdir(runtimeRoot(), { recursive: true });
  safeMkdir(observabilityRoot(), { recursive: true });
}

/**
 * Streaming whole-history read: constant memory, so a store's size never
 * makes a read fail. Strict by default — the item/lease stores fail closed on
 * a torn or malformed record rather than adopting an unverifiable ID.
 * `tolerant` (the observability event feed) skips such lines and warns once.
 */
export function* streamJsonl<T>(
  logicalPath: string,
  options: { tolerant?: boolean } = {}
): Generator<T> {
  const file = assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true });
  if (!safeExistsSync(file)) return;
  if (!options.tolerant) {
    yield* streamJsonLines<T>(file, { chunkBytes: storeTuning.chunkBytes });
    return;
  }
  let malformed = 0;
  let firstMalformedLine = 0;
  yield* streamJsonLines<T>(file, {
    chunkBytes: storeTuning.chunkBytes,
    onMalformed: (_error, lineNumber) => {
      if (malformed === 0) firstMalformedLine = lineNumber;
      malformed++;
    },
  });
  if (malformed > 0) {
    logger.warn(
      `[work-coordination] skipped ${malformed} malformed line(s) in ${file} — torn append or corrupt record | next: inspect the line; the remaining events are listed | evidence: first malformed line ${firstMalformedLine}`
    );
  }
}

export function readJsonl<T>(logicalPath: string): T[] {
  return Array.from(streamJsonl<T>(logicalPath));
}

export function appendJsonl(logicalPath: string, record: unknown): void {
  withExecutionContext('infrastructure_sentinel', () => {
    ensureStore();
    appendJsonLine(assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true }), record);
  });
}

/** State publication keeps its governed writer role; serialization is shared. */
export function writeCoordinationState(logicalPath: string, value: unknown): void {
  withExecutionContext('infrastructure_sentinel', () => {
    ensureStore();
    writeJson(assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true }), value);
  });
}

export function currentWorkItems(): WorkItem[] {
  return selectCurrentWorkItems(readJsonl<WorkItem>(itemsPath()));
}

export function currentWorkItem(itemId: string): WorkItem | null {
  const normalized = String(itemId || '').trim();
  if (!normalized) return null;
  const items = currentWorkItems();
  return items.find((item) => item.item_id === normalized) || null;
}

export function currentLeaseRecords(): WorkLease[] {
  const records = readJsonl<WorkLease>(leasesPath());
  return latestById(records, 'lease_id').map((lease) => ({ ...lease }));
}

export function currentLeaseForItem(itemId: string): WorkLease | null {
  const now = Date.now();
  const leases = currentLeaseRecords()
    .filter((lease) => lease.item_id === itemId)
    .filter((lease) => lease.status === 'active')
    .filter((lease) => new Date(lease.expires_at).getTime() > now)
    .sort((a, b) => a.renewed_at.localeCompare(b.renewed_at));
  return leases.length > 0 ? leases[leases.length - 1] : null;
}

export function currentLeaseById(leaseId: string): WorkLease | null {
  const normalized = String(leaseId || '').trim();
  if (!normalized) return null;
  const leases = currentLeaseRecords();
  return leases.find((lease) => lease.lease_id === normalized) || null;
}

export function createWorkItemAttempt(input: {
  actorPeerId: string;
  actorUserId?: string;
  leaseId: string;
  traceId?: string;
  metadata?: Record<string, unknown>;
}): WorkItemAttempt {
  const now = nowIso();
  return {
    attempt_id: randomId('wattempt'),
    run_id: randomId('wrun'),
    status: 'running',
    started_at: now,
    actor_peer_id: input.actorPeerId,
    ...(input.actorUserId ? { actor_user_id: input.actorUserId } : {}),
    lease_id: input.leaseId,
    ...(input.traceId ? { trace_id: input.traceId } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function appendWorkItemAttemptEvent(
  eventType: WorkCoordinationEventType,
  itemId: string,
  attempt: WorkItemAttempt | null,
  note: string,
  actorPeerId?: string,
  actorUserId?: string,
  expectedVersion?: number
): void {
  appendEvent({
    eventType,
    itemId,
    actorPeerId,
    actorUserId,
    expectedVersion,
    status: attempt?.status,
    note,
    payload: attempt
      ? {
          attempt_id: attempt.attempt_id,
          run_id: attempt.run_id,
          status: attempt.status,
          started_at: attempt.started_at,
          ended_at: attempt.ended_at,
          actor_peer_id: attempt.actor_peer_id,
          actor_user_id: attempt.actor_user_id,
          lease_id: attempt.lease_id,
          summary: attempt.summary,
          blocked_reason: attempt.blocked_reason,
          failure_reason: attempt.failure_reason,
          trace_id: attempt.trace_id,
          metadata: attempt.metadata,
        }
      : undefined,
  });
}

/**
 * MSN-LOG-STORE-HARDENING-20261016: cap the per-item attempts array carried
 * by every versioned snapshot. Each item version embedded its FULL attempt
 * history (observed: 16 attempts ≈ 239KB in one record), so every status
 * change re-wrote all prior attempts — the store grew quadratically and the
 * largest line reached ~240KB. Only the tail is retained; the complete
 * attempt history stays in `observability/work-coordination/events.jsonl`
 * via appendWorkItemAttemptEvent.
 */
export const MAX_RETAINED_ITEM_ATTEMPTS = 10;

export function boundItemAttempts(item: WorkItem): WorkItem {
  const attempts = item.attempts;
  if (!attempts || attempts.length <= MAX_RETAINED_ITEM_ATTEMPTS) return item;
  return { ...item, attempts: attempts.slice(-MAX_RETAINED_ITEM_ATTEMPTS) };
}

/**
 * Write-time retention (storage-retention-catalog `compact` entries for
 * items.jsonl / leases.jsonl). The readers stream, so size never makes a read
 * fail; folding only bounds disk. The policy is explicit rather than
 * `'catalog'` because the namespace / root override moves the store off the
 * catalog's exact path. Runs inside the coordination mutation fence, so the
 * store lock is already held (`lockId: null`); the shared append-only-store
 * rewrite is race-safe for lock-free readers. The pre-compaction union is
 * archived under `<coordination base>/active/archive/jsonl-compaction/`.
 */
export const WORK_ITEMS_COMPACT_MIN_BYTES = 2 * 1024 * 1024;
export const WORK_LEASES_COMPACT_MIN_BYTES = 1024 * 1024;
const COMPACTION_ARCHIVE_REPO_SUBPATH = 'active/archive/jsonl-compaction';

interface WorkCoordinationStoreTuning {
  itemsCompactMinBytes?: number;
  leasesCompactMinBytes?: number;
  /** Range-read chunk size for the streaming readers (tests inject small values). */
  chunkBytes?: number;
}
let storeTuning: WorkCoordinationStoreTuning = {};

/** Test seam: override compaction thresholds / read chunking; call with `{}` to reset. */
export function setWorkCoordinationStoreTuningForTests(tuning: WorkCoordinationStoreTuning): void {
  storeTuning = { ...tuning };
}

/**
 * Items fold to the latest snapshot per item_id, except creation snapshots
 * (version 1), which are kept verbatim: `createWorkItemIfAbsent` compares a
 * replay against the original creation identity and treats several version-1
 * snapshots as ambiguous ownership, so both facts must survive compaction.
 */
export function workItemCompactionKey(record: Record<string, unknown>): string | undefined {
  if (record.version === 1) return undefined;
  const id = record.item_id;
  return typeof id === 'string' && id ? id : undefined;
}

function maintainCoordinationStore(
  filePath: string,
  key: 'item_id' | 'lease_id',
  minBytes: number
): void {
  withCoordinationMutation(() => {
    const base = coordinationBase();
    const archiveDir = path.join(
      base,
      COMPACTION_ARCHIVE_REPO_SUBPATH,
      path.dirname(path.relative(base, filePath))
    );
    maintainStoreAfterAppend(
      filePath,
      {
        action: 'compact',
        key: key === 'item_id' ? workItemCompactionKey : 'lease_id',
        minBytes,
        archiveDir,
      },
      { lockId: null, chunkBytes: storeTuning.chunkBytes }
    );
  });
}

export function appendItemSnapshot(item: WorkItem): WorkItem {
  const bounded = boundItemAttempts(item);
  validateWorkItem(bounded);
  const file = itemsPath();
  appendJsonl(file, bounded);
  maintainCoordinationStore(
    file,
    'item_id',
    storeTuning.itemsCompactMinBytes ?? WORK_ITEMS_COMPACT_MIN_BYTES
  );
  return bounded;
}

export function appendLeaseSnapshot(lease: WorkLease): WorkLease {
  const file = leasesPath();
  appendJsonl(file, lease);
  maintainCoordinationStore(
    file,
    'lease_id',
    storeTuning.leasesCompactMinBytes ?? WORK_LEASES_COMPACT_MIN_BYTES
  );
  return lease;
}

export function createEvent(payload: AppendCoordinationEventInput): CoordinationEvent {
  return {
    event_id: randomId('wce'),
    ts: nowIso(),
    event_type: payload.eventType,
    ...(payload.itemId ? { item_id: payload.itemId } : {}),
    ...(payload.boardId ? { board_id: payload.boardId } : {}),
    ...(payload.leaseId ? { lease_id: payload.leaseId } : {}),
    ...(payload.actorPeerId ? { actor_peer_id: payload.actorPeerId } : {}),
    ...(payload.actorUserId ? { actor_user_id: payload.actorUserId } : {}),
    ...(payload.commandId ? { command_id: payload.commandId } : {}),
    ...(payload.idempotencyKey ? { idempotency_key: payload.idempotencyKey } : {}),
    ...(typeof payload.expectedVersion === 'number'
      ? { expected_version: payload.expectedVersion }
      : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.note ? { note: payload.note } : {}),
    ...(payload.payload ? { payload: payload.payload } : {}),
  };
}

export function appendEvent(payload: AppendCoordinationEventInput): CoordinationEvent {
  return withCoordinationMutation(() => {
    const event = createEvent(payload);
    appendJsonl(eventsPath(), event);
    return event;
  });
}
