/** Work-coordination append-only ledger internals: roots, mutation fence, JSONL/state writers. */
import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { appendJsonLine, readJsonLines, writeJson } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { nowIso } from '../foundation/time.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { withExecutionContext } from '../authority.js';
import { selectCurrentWorkItems } from './work-coordination-snapshot.js';
import { latestById } from './work-coordination-inventory.js';
import { validateWorkItem } from './work-coordination-identity.js';
import { assertSafeRepositoryPath, safeLstat, safeMkdir, safeWriteFile } from '../secure-io.js';
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

export function readJsonl<T>(logicalPath: string): T[] {
  return readJsonLines<T>(assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true }));
}

export function appendJsonl(logicalPath: string, record: unknown): void {
  withExecutionContext('infrastructure_sentinel', () => {
    ensureStore();
    appendJsonLine(assertSafeRepositoryPath(logicalPath, { allowMissingLeaf: true }), record);
  });
}

/** Whole-file JSONL rewrite (compaction): truncate once, then append each record through the canonical line writer. */
export function rewriteJsonl(absolutePath: string, records: readonly unknown[]): void {
  withExecutionContext('infrastructure_sentinel', () => {
    ensureStore();
    safeWriteFile(absolutePath, '');
    for (const record of records) appendJsonLine(absolutePath, record);
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
 * Store growth guard: the append-only stores are also the read path, and
 * `readJsonLines` enforces the secure 100 MB read cap — a store that grows past
 * it self-DoSes every reader, including the janitor that exists to compact it
 * (observed: one crash-looping item inflated items.jsonl to 100 MB and halted
 * all `pnpm work` commands). Appends run inside the coordination mutation
 * fence, so once a store crosses the threshold we fold it in place: latest
 * record per key, keyless rows verbatim, original archived under
 * `active/archive/jsonl-compaction/` matching the janitor's layout.
 */
const APPEND_ONLY_COMPACT_AT_BYTES = 64 * 1024 * 1024;
const COMPACTION_ARCHIVE_REPO_SUBPATH = 'active/archive/jsonl-compaction';

function maybeCompactAppendOnlyStore(filePath: string, keyField: string): void {
  const stat = safeLstat(filePath);
  if (!stat.isFile() || stat.size < APPEND_ONLY_COMPACT_AT_BYTES) return;
  const records = readJsonLines<Record<string, unknown>>(filePath);
  const lastIndex = new Map<string, number>();
  records.forEach((record, index) => {
    const key = record[keyField];
    if (typeof key === 'string' && key) lastIndex.set(key, index);
  });
  const kept = records.filter((record, index) => {
    const key = record[keyField];
    return typeof key !== 'string' || !key || lastIndex.get(key) === index;
  });
  const stamp = nowIso().replace(/[-:]/g, '').replace(/\..*$/, '');
  const repoRel = path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
  const archivePath = assertSafeRepositoryPath(
    path.resolve(
      pathResolver.rootDir(),
      COMPACTION_ARCHIVE_REPO_SUBPATH,
      `${repoRel.replace(/\.jsonl$/, '')}.${stamp}Z-${process.pid}.jsonl`
    ),
    { allowMissingLeaf: true }
  );
  safeMkdir(path.dirname(archivePath), { recursive: true });
  rewriteJsonl(archivePath, records);
  rewriteJsonl(filePath, kept);
}

export function appendItemSnapshot(item: WorkItem): WorkItem {
  const bounded = boundItemAttempts(item);
  validateWorkItem(bounded);
  const file = itemsPath();
  appendJsonl(file, bounded);
  maybeCompactAppendOnlyStore(file, 'item_id');
  return bounded;
}

export function appendLeaseSnapshot(lease: WorkLease): WorkLease {
  const file = leasesPath();
  appendJsonl(file, lease);
  maybeCompactAppendOnlyStore(file, 'lease_id');
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
