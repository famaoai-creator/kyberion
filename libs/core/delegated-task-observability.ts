import {
  currentResourceAccessScope,
  runInResourceAccessScope,
} from './foundation/resource-access-scope.js';
import { resolvePolicyIdentityContext } from './identity-context-bridge.js';
import { getActiveSandboxPolicy, withSandboxPolicy } from './shell/sandbox-policy.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { logger } from './core.js';
import { getMissionAgentInputQueue, type AgentInputQueueEntry } from './agent/agent-input-queue.js';
import { enqueueDelegationNotification } from './mission/delegation-notifications.js';
import { sanitizeGapSamples } from './gap-phase.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeAppendFileSync,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { withExecutionContext, withExecutionContextAsync } from './authority.js';
import { isReservedScopeName, isValidTenantSlug } from './foundation/scope.js';
import {
  DELEGATION_RECORD_ROOT_PATH,
  LEGACY_DELEGATION_RECORD_DIR,
  LEGACY_DELEGATION_TRACE_PATH,
} from './foundation/runtime-state-roots.js';
import { storagePartitionSegments, tenantStoreLedgerPartitionOf } from './storage-layout.js';
import { withLockSync } from './foundation/lock-utils.js';
import { spawnManagedProcess, type ManagedProcessHandle } from './managed-process.js';
import {
  buildCancelledDelegationResult,
  buildCompletedDelegationResult,
  buildFailedDelegationResult,
  runWithDelegationExecutionTracker,
  type DelegationResult,
} from './delegation-result.js';

export interface DelegatedTaskTrace {
  trace_id: string;
  kind: 'delegated_task';
  created_at: string;
  completed_at?: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  /** Tenant partition this delegation belongs to (absent: system). */
  tenant_slug?: string;
  owner: string;
  instruction: string;
  context?: string;
  context_ref?: string;
  backend_name?: string;
  result_summary?: string;
  error?: string;
  /** KC-06: background/async delegations notify the worker loop on completion. */
  background?: boolean;
  /** KC-06: set when this delegation resumed an earlier one by id. */
  resumed_from?: string;
  mission_id?: string;
  task_id?: string;
  /** DH-12: durable child-session identity for cold resume. */
  continuable?: boolean;
  child_session_id?: string;
  /** Number of cold-resume activations claimed for this child session. */
  activation_count?: number;
  activation_id?: string;
  activated_at?: string;
  /** DH-12: activation is consumed even when dispatch fails. */
  activation_status?: 'pending' | 'claimed' | 'completed' | 'failed';
  activation_completed_at?: string;
  activation_result_delegation_id?: string;
  activation_failure?: DelegatedTaskActivationFailure;
  /** DH-12: child output and owner settlement are distinct provenance records. */
  child_report?: DelegatedTaskReport;
  settlement?: DelegatedTaskSettlement;
  /** QM-09: named-phase latency breakdown for this delegation. */
  gap_phases?: Array<{ phase: string; ms: number }>;
  /**
   * R2: structured terminal outcome. `status` above keeps the legacy enum
   * (incomplete → failed); this carries the precise status, failure
   * classification, usage and artifact references. The output text itself
   * stays in `result_summary`.
   */
  outcome?: DelegatedTaskOutcome;
}

/** R2: persisted projection of a DelegationResult (output text excluded). */
export type DelegatedTaskOutcome = Omit<DelegationResult, 'output_text'>;

function outcomeOf(result: DelegationResult): DelegatedTaskOutcome {
  const { output_text: _outputText, ...outcome } = result;
  return outcome;
}

export interface DelegatedTaskReport {
  source: 'child';
  delegation_id: string;
  child_session_id?: string;
  summary?: string;
  error?: string;
}

export interface DelegatedTaskSettlement {
  source: 'owner';
  report_delegation_id: string;
  settled_at: string;
  status: 'completed' | 'failed' | 'cancelled';
}

export interface DelegatedTaskActivationFailure {
  source: 'owner';
  activation_id: string;
  failed_at: string;
  error: string;
}

/**
 * KC-06: per-delegation persisted record. The append-only JSONL trace stays
 * the audit stream; this record is the resumable, id-addressable snapshot
 * (one JSON file per delegation) used by resume and by the post-compaction
 * active-task snapshot.
 */
export type DelegatedTaskRecord = Omit<DelegatedTaskTrace, 'trace_id'> & {
  delegation_id: string;
};

export interface DelegationHandle {
  readonly delegation_id: string;
  status(): DelegatedTaskRecord;
  /** Legacy text projection: resolves on completion, rejects otherwise. */
  join(): Promise<string>;
  /** R2: structured terminal result; never rejects for a delegation failure. */
  joinResult(): Promise<DelegationResult>;
  cancel(reason?: string): Promise<void>;
}

export interface DelegatedTaskInboxInput {
  text: string;
  requestedBy?: string;
  metadata?: Record<string, string | number | boolean>;
  /** Set false only when an already-running worker is consuming its own input. */
  wake?: boolean;
}

export interface DelegatedTaskWorkerWake {
  delegationId: string;
  childSessionId: string;
  reason: 'next_run';
}

export type DelegatedTaskWorkerHandler = (wake: DelegatedTaskWorkerWake) => Promise<void> | void;

/**
 * Store layout (runtime-storage-layout "Delegation trace and records"):
 * `<root>/system/` holds untenanted delegations, `<root>/confidential/<tenant>/`
 * tenant ones — `delegations.jsonl` (append-only audit trace) and
 * `records/<id>.json` (+ `records/child-inbox/<child>.jsonl`). `<root>` is the
 * registered ledger root `active/shared/runtime/delegation-records`, whose tenant
 * partitions only the tenant-bound `delegation_record_store` role may read or
 * write (tier-guard tenant check + dedicated-store rule).
 *
 * Tests namespace the store via KYBERION_DELEGATION_STORE_DIR (the partitions
 * and a hermetic `legacy/` fallback directory lie under it) and may pin one
 * trace file for every scope via KYBERION_DELEGATION_TRACE_PATH, so parallel
 * suites never clobber the real files (resolved lazily per call).
 */
export const DELEGATION_RECORD_STORE_ROLE = 'delegation_record_store';
/** Tenant delegations hold tenant instruction/context/result text: always confidential. */
const DELEGATION_TENANT_TIER = 'confidential';
const DELEGATION_TRACE_FILE = 'delegations.jsonl';
const DELEGATION_RECORDS_DIR = 'records';

function normalizeTenant(value: string | undefined): string | undefined {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase();
  return slug && isValidTenantSlug(slug) && !isReservedScopeName(slug) && slug !== 'system'
    ? slug
    : undefined;
}

/** The tenant this process (or the current resource scope) is bound to. */
function boundTenantSlug(): string | undefined {
  return normalizeTenant(
    currentResourceAccessScope()?.tenantSlug ?? resolvePolicyIdentityContext().tenantSlug
  );
}

function storeRootOverride(): string | undefined {
  return getRegisteredEnvText('KYBERION_DELEGATION_STORE_DIR')?.trim() || undefined;
}

function resolveStoreRoot(): string {
  const override = storeRootOverride();
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(override ?? DELEGATION_RECORD_ROOT_PATH),
    {
      allowMissingLeaf: true,
    }
  );
}

/** `<root>/system` or `<root>/confidential/<tenant>`. */
function partitionDir(tenant: string | undefined): string {
  return assertSafeRepositoryPath(
    path.join(
      resolveStoreRoot(),
      ...storagePartitionSegments(
        tenant ? { kind: 'tier', tier: DELEGATION_TENANT_TIER, tenant } : { kind: 'system' }
      )
    ),
    { allowMissingLeaf: true }
  );
}

function tracePathFor(tenant: string | undefined): string {
  const override = getRegisteredEnvText('KYBERION_DELEGATION_TRACE_PATH')?.trim();
  if (override) {
    return assertSafeRepositoryPath(pathResolver.rootResolve(override), { allowMissingLeaf: true });
  }
  return assertSafeRepositoryPath(path.join(partitionDir(tenant), DELEGATION_TRACE_FILE), {
    allowMissingLeaf: true,
  });
}

function recordsDirFor(tenant: string | undefined): string {
  return assertSafeRepositoryPath(path.join(partitionDir(tenant), DELEGATION_RECORDS_DIR), {
    allowMissingLeaf: true,
  });
}

function safeLeafId(value: string, label: string): string {
  const safeId = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!safeId) throw new Error(`${label} is required.`);
  return safeId;
}

function recordPathIn(tenant: string | undefined, delegationId: string): string {
  return assertSafeRepositoryPath(
    path.join(recordsDirFor(tenant), `${safeLeafId(delegationId, 'Delegation id')}.json`),
    { allowMissingLeaf: true }
  );
}

/**
 * Pre-partition shared copies (tenant-mixed). Test runs with a store override
 * use `<override>/legacy/` instead, so they never read the live legacy files.
 */
function legacyLocation(): { tracePath: string; recordDir: string } {
  const override = storeRootOverride();
  const base = override ? path.posix.join(override, 'legacy') : undefined;
  return {
    tracePath: assertSafeRepositoryPath(
      pathResolver.rootResolve(
        base ? path.posix.join(base, 'delegations.jsonl') : LEGACY_DELEGATION_TRACE_PATH
      ),
      { allowMissingLeaf: true }
    ),
    recordDir: assertSafeRepositoryPath(
      pathResolver.rootResolve(
        base ? path.posix.join(base, 'delegations') : LEGACY_DELEGATION_RECORD_DIR
      ),
      { allowMissingLeaf: true }
    ),
  };
}

function legacyRecordPath(delegationId: string): string {
  return assertSafeRepositoryPath(
    path.join(legacyLocation().recordDir, `${safeLeafId(delegationId, 'Delegation id')}.json`),
    { allowMissingLeaf: true }
  );
}

/**
 * Run `fn` as `delegation_record_store` bound to the tenant of the registered
 * partition `filePath` lies in; otherwise (system partition, test override,
 * legacy copy) as the caller. The role is tenant-bound: a caller with another
 * active tenant throws [ROLE_TENANT_SCOPE_MISMATCH] before `fn` runs.
 */
function asDelegationStore<T>(filePath: string, fn: () => T): T {
  const partition = tenantStoreLedgerPartitionOf(filePath);
  if (partition?.storeRole !== DELEGATION_RECORD_STORE_ROLE || !partition.tenant) return fn();
  return withExecutionContext(DELEGATION_RECORD_STORE_ROLE, fn, undefined, partition.tenant);
}

async function asDelegationStoreAsync<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const partition = tenantStoreLedgerPartitionOf(filePath);
  if (partition?.storeRole !== DELEGATION_RECORD_STORE_ROLE || !partition.tenant) return fn();
  return withExecutionContextAsync(DELEGATION_RECORD_STORE_ROLE, fn, undefined, partition.tenant);
}

/** The trace this process's scope appends to (honours the test override). */
export function delegatedTaskTracePath(): string {
  return tracePathFor(boundTenantSlug());
}

/**
 * Tenant-free trace files for system-scope readers (learning signals keep
 * closed tokens only): the system partition plus the legacy shared trace.
 */
export function systemDelegationTracePaths(): string[] {
  const paths = [tracePathFor(undefined)];
  const legacy = legacyLocation().tracePath;
  if (!paths.includes(legacy)) paths.push(legacy);
  return paths;
}

/**
 * Host-owned delegation bookkeeping (records, reservations) written through
 * the same sandbox/tenant narrowing as the delegation trace. Not for general use.
 */
export function writeDelegationHostLeaf(filePath: string, serialized: string): void {
  writeObservabilityLeaf(filePath, serialized, false);
}

/** Host-owned bookkeeping only: callers must serialize before entering this leaf. */
function writeObservabilityLeaf(filePath: string, serialized: string, append: boolean): void {
  const directory = path.dirname(filePath);
  const mkdirPaths: string[] = [];
  for (let current = directory; !safeExistsSync(current); current = path.dirname(current)) {
    mkdirPaths.push(current);
  }
  const write = () =>
    asDelegationStore(filePath, () => {
      if (mkdirPaths.length) safeMkdir(directory, { recursive: true });
      if (append) safeAppendFileSync(filePath, serialized);
      else safeWriteFile(filePath, serialized, { mkdir: false });
    });
  const policy = getActiveSandboxPolicy();
  const scope = currentResourceAccessScope();
  const tenantSlug =
    tenantStoreLedgerPartitionOf(filePath)?.tenant ||
    scope?.tenantSlug ||
    resolvePolicyIdentityContext().tenantSlug;
  if (policy?.mode !== 'read-only') return write();
  // A read-only delegation still owns its host bookkeeping: narrow the sandbox
  // to exactly this leaf instead of writing under the read-only policy, for
  // untenanted (system) delegations as well as tenant ones.
  const writeNarrowed = () =>
    withSandboxPolicy(
      { ...policy, mode: 'workspace-write', writableRoots: [directory, ...mkdirPaths] },
      write
    );
  if (!tenantSlug) return writeNarrowed();
  const relative = (target: string) =>
    path.relative(pathResolver.rootDir(), target).split(path.sep).join('/');
  runInResourceAccessScope(
    {
      tenantSlug,
      ...(scope?.organizationId ? { organizationId: scope.organizationId } : {}),
      ...(scope?.projectId ? { projectId: scope.projectId } : {}),
      readExact: [],
      writeExact: [relative(filePath)],
      mkdirExact: mkdirPaths.map(relative),
      allowProductKnowledgeRead: true,
    },
    writeNarrowed
  );
}

function appendTrace(record: DelegatedTaskTrace): void {
  const serialized = `${JSON.stringify(record)}\n`;
  writeObservabilityLeaf(tracePathFor(normalizeTenant(record.tenant_slug)), serialized, true);
}

const DELEGATED_TASK_RECORD_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/delegated-task-record.schema.json'
);

function delegatedTaskRecordCatalog(filePath: string) {
  return defineCatalog<DelegatedTaskRecord>({
    id: 'delegated-task-record',
    path: filePath,
    schema: DELEGATED_TASK_RECORD_SCHEMA_PATH,
  });
}

function readRecordFile(filePath: string): DelegatedTaskRecord | null {
  return asDelegationStore(filePath, () => {
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return null;
    return delegatedTaskRecordCatalog(filePath).load();
  });
}

/**
 * Tenant a legacy (pre-partition) record belongs to: its stamp, else the
 * location of its mission (`active/[archive/]missions/<tier>/<tenant>/<id>`).
 * `{}` = untenanted (no mission, or an untenanted one); null = unattributable
 * (the mission exists but is not visible to this process).
 */
function legacyRecordTenant(record: {
  tenant_slug?: string;
  mission_id?: string;
}): { tenant?: string } | null {
  const stamped = normalizeTenant(record.tenant_slug);
  if (stamped) return { tenant: stamped };
  if (!record.mission_id) return {};
  let missionPath: string | null = null;
  try {
    missionPath = pathResolver.findMissionPath(record.mission_id);
  } catch {
    return null;
  }
  if (!missionPath) return {};
  const segments = path.relative(pathResolver.rootDir(), missionPath).split(path.sep);
  const start = segments[1] === 'archive' ? 3 : 2;
  const rest = segments.slice(start + 1);
  return rest.length === 2 ? { tenant: normalizeTenant(rest[0]) } : {};
}

interface LocatedDelegatedTaskRecord {
  record: DelegatedTaskRecord;
  /** Partition tenant (undefined = system). */
  tenant?: string;
  /** Found in the shared pre-partition directory. */
  legacy: boolean;
}

/** Tenant partitions present under the store root (directory names only). */
function listTenantPartitions(): string[] {
  const tierDir = path.join(resolveStoreRoot(), DELEGATION_TENANT_TIER);
  if (!safeExistsSync(tierDir)) return [];
  try {
    return safeReaddir(tierDir)
      .map((entry) => normalizeTenant(entry))
      .filter((entry): entry is string => Boolean(entry))
      .sort();
  } catch (error) {
    logger.debug(
      `delegation partition listing skipped — ${error instanceof Error ? error.message : String(error)} | next: none | evidence: ${tierDir}`
    );
    return [];
  }
}

function loadFromPartition(
  tenant: string | undefined,
  delegationId: string
): LocatedDelegatedTaskRecord | null {
  try {
    const record = readRecordFile(recordPathIn(tenant, delegationId));
    if (!record) return null;
    if (normalizeTenant(record.tenant_slug) !== tenant) {
      logger.warn(
        `delegation record refused — its tenant stamp does not match its partition | next: inspect the record before reuse | evidence: ${delegationId}`
      );
      return null;
    }
    return { record, tenant, legacy: false };
  } catch (error) {
    logger.debug(
      `delegation record unreadable — ${error instanceof Error ? error.message : String(error)} | next: none | evidence: ${delegationId}`
    );
    return null;
  }
}

/**
 * Legacy fallback: the shared pre-partition record, only when attributed to
 * `tenant` (a tenant-bound reader) or for an unbound reader (which may read
 * the shared directory, as before) — never another tenant's record.
 */
function loadFromLegacy(
  delegationId: string,
  boundTenant: string | undefined
): LocatedDelegatedTaskRecord | null {
  let record: DelegatedTaskRecord | null;
  try {
    record = readRecordFile(legacyRecordPath(delegationId));
  } catch {
    return null;
  }
  if (!record) return null;
  const attribution = legacyRecordTenant(record);
  if (boundTenant) {
    if (attribution?.tenant !== boundTenant) return null;
  } else if (!attribution) {
    return null;
  }
  const tenant = attribution?.tenant;
  return {
    record: { ...record, ...(tenant ? { tenant_slug: tenant } : {}) },
    tenant,
    legacy: true,
  };
}

/**
 * Find a delegation record. A tenant-bound process looks only in its own
 * partition (then the legacy copies attributed to it); an unbound process
 * looks in the system partition, then every tenant partition (read as the
 * store role bound to that tenant), then the legacy directory.
 */
function locateDelegatedTaskRecord(delegationId: string): LocatedDelegatedTaskRecord | null {
  const bound = boundTenantSlug();
  if (bound) return loadFromPartition(bound, delegationId) ?? loadFromLegacy(delegationId, bound);
  const direct = loadFromPartition(undefined, delegationId);
  if (direct) return direct;
  for (const tenant of listTenantPartitions()) {
    const found = loadFromPartition(tenant, delegationId);
    if (found) return found;
  }
  return loadFromLegacy(delegationId, undefined);
}

/** Inbox of a continuable child, next to its record (legacy inbox kept while it still holds input). */
function childInboxPath(record: DelegatedTaskRecord): string {
  const leaf = `${safeLeafId(record.child_session_id ?? '', 'Child session id')}.jsonl`;
  const partitioned = assertSafeRepositoryPath(
    path.join(recordsDirFor(normalizeTenant(record.tenant_slug)), 'child-inbox', leaf),
    { allowMissingLeaf: true }
  );
  const legacy = assertSafeRepositoryPath(
    path.join(legacyLocation().recordDir, 'child-inbox', leaf),
    { allowMissingLeaf: true }
  );
  const partitionedExists = asDelegationStore(partitioned, () => safeExistsSync(partitioned));
  return !partitionedExists && safeExistsSync(legacy) ? legacy : partitioned;
}

function requireDelegatedTaskRecord(
  delegationId: string,
  requestedBy?: string
): DelegatedTaskRecord {
  const record = loadDelegatedTaskRecord(delegationId);
  if (!record) throw new Error(`Delegated task record not found for id "${delegationId}".`);
  if (!record.continuable || !record.child_session_id) {
    throw new Error(`Delegated task "${delegationId}" is not a continuable child session.`);
  }
  if (requestedBy && requestedBy !== record.owner) {
    throw new Error(
      `Delegated task "${delegationId}" is owned by "${record.owner}"; inbox access rejected for requester "${requestedBy}".`
    );
  }
  return record;
}

/** Run a child-inbox queue operation as the store role of the inbox's partition. */
function withChildInbox<T>(
  record: DelegatedTaskRecord,
  fn: (queue: ReturnType<typeof getMissionAgentInputQueue>) => Promise<T>
): Promise<T> {
  const queuePath = childInboxPath(record);
  return asDelegationStoreAsync(queuePath, () =>
    fn(getMissionAgentInputQueue({ missionId: record.child_session_id!, queuePath }))
  );
}

interface DelegatedTaskWorkerRegistration {
  owner: string;
  handler: DelegatedTaskWorkerHandler;
  wakeInFlight?: Promise<void>;
}

export interface DelegatedTaskWorkerProcessSpec {
  resourceId: string;
  delegationId: string;
  owner: string;
  /** Tenant of the delegation: the worker process is bound to it (KYBERION_TENANT). */
  tenantSlug?: string;
  command: string;
  args: string[];
  metadata: Record<string, string>;
}

/** Build the deterministic command used by the runtime-supervised worker. */
export function buildDelegatedTaskWorkerProcessSpec(
  delegationId: string,
  owner: string
): DelegatedTaskWorkerProcessSpec {
  const record = requireDelegatedTaskRecord(delegationId, owner);
  if (record.status === 'started') {
    throw new Error(`[DELEGATED_TASK_WORKER] child delegation "${delegationId}" is still running`);
  }
  if ((record.activation_count ?? 0) >= 1) {
    throw new Error(
      `[DELEGATED_TASK_WORKER] child delegation "${delegationId}" has already been activated`
    );
  }
  const resourceId = `delegated-task-worker:${delegationId}`;
  const tenantSlug = normalizeTenant(record.tenant_slug);
  return {
    resourceId,
    delegationId,
    owner,
    ...(tenantSlug ? { tenantSlug } : {}),
    command: process.execPath,
    args: [
      '--import',
      assertSafeRepositoryPath(pathResolver.rootResolve('scripts/ts-loader.mjs')),
      assertSafeRepositoryPath(pathResolver.rootResolve('scripts/delegated_task_worker.ts')),
      '--delegation-id',
      delegationId,
      '--owner',
      owner,
    ],
    metadata: {
      delegationId,
      childSessionId: record.child_session_id!,
      owner,
      workerKind: 'continuable-delegation',
      ...(tenantSlug ? { tenantSlug } : {}),
    },
  };
}

/** Spawn a cold-resume worker under runtime-supervisor management. */
export function spawnDelegatedTaskWorkerProcess(
  delegationId: string,
  owner: string
): ManagedProcessHandle {
  const spec = buildDelegatedTaskWorkerProcessSpec(delegationId, owner);
  return spawnManagedProcess({
    resourceId: spec.resourceId,
    kind: 'service',
    ownerId: spec.owner,
    ownerType: 'delegated-task-worker',
    command: spec.command,
    args: spec.args,
    spawnOptions: {
      cwd: pathResolver.rootDir(),
      // A tenant delegation's worker runs bound to that tenant, so it reads and
      // settles the record in the tenant's own partition only.
      env: spec.tenantSlug ? { ...process.env, KYBERION_TENANT: spec.tenantSlug } : process.env,
      stdio: 'ignore',
    },
    shutdownPolicy: 'manual',
    metadata: spec.metadata,
  });
}

/**
 * A process-local worker registry is the execution seam for a dedicated child
 * worker process. The durable inbox remains the source of truth: registration
 * only supplies a wake/execute handler and never carries prompt text.
 */
const delegatedTaskWorkers = new Map<string, DelegatedTaskWorkerRegistration>();

async function wakeRegisteredDelegatedTaskWorker(
  delegationId: string,
  requestedBy?: string
): Promise<boolean> {
  const registration = delegatedTaskWorkers.get(delegationId);
  if (!registration) return false;
  const record = requireDelegatedTaskRecord(delegationId, requestedBy);
  if (record.status === 'started') return false;
  const pending = await withChildInbox(record, (queue) =>
    queue.peek('next_run', 1, { sessionId: record.child_session_id })
  );
  if (pending.length === 0) return false;
  if (registration.wakeInFlight) {
    await registration.wakeInFlight;
    return true;
  }
  const wake: DelegatedTaskWorkerWake = {
    delegationId,
    childSessionId: record.child_session_id!,
    reason: 'next_run',
  };
  // Defer handler invocation until after the in-flight marker is installed;
  // enqueue and explicit wake calls can otherwise race before assignment.
  const execution = Promise.resolve().then(() => registration.handler(wake));
  registration.wakeInFlight = execution;
  try {
    await execution;
    return true;
  } finally {
    if (registration.wakeInFlight === execution) registration.wakeInFlight = undefined;
  }
}

/**
 * Register a child worker runtime. On registration, pending durable input is
 * replayed once; later `next_run` enqueue operations request the same wake.
 */
export function registerDelegatedTaskWorker(
  delegationId: string,
  input: { owner: string; handler: DelegatedTaskWorkerHandler }
): () => void {
  const record = requireDelegatedTaskRecord(delegationId, input.owner);
  if (record.status === 'started') {
    throw new Error(`[DELEGATED_TASK_WORKER] child delegation "${delegationId}" is still running`);
  }
  if ((record.activation_count ?? 0) >= 1) {
    throw new Error(
      `[DELEGATED_TASK_WORKER] child delegation "${delegationId}" has already been activated`
    );
  }
  if (!input.owner.trim()) throw new Error('[DELEGATED_TASK_WORKER] owner is required.');
  if (typeof input.handler !== 'function')
    throw new Error('[DELEGATED_TASK_WORKER] handler is required.');
  if (delegatedTaskWorkers.has(delegationId)) {
    throw new Error(`[DELEGATED_TASK_WORKER] worker already registered: ${delegationId}`);
  }
  const registration: DelegatedTaskWorkerRegistration = {
    owner: input.owner,
    handler: input.handler,
  };
  delegatedTaskWorkers.set(delegationId, registration);
  void wakeRegisteredDelegatedTaskWorker(delegationId, input.owner).catch((error) => {
    logger.warn(
      `[delegated-task] child worker wake failed during registration: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
  return () => {
    if (delegatedTaskWorkers.get(delegationId) === registration) {
      delegatedTaskWorkers.delete(delegationId);
    }
  };
}

/** Explicitly await a worker wake, useful to a daemon/worker event loop. */
export function wakeDelegatedTaskWorker(
  delegationId: string,
  requestedBy?: string
): Promise<boolean> {
  return wakeRegisteredDelegatedTaskWorker(delegationId, requestedBy);
}

/**
 * Enqueue data for a continuable child. The child-session inbox is the only
 * durable input queue used by cold resume; callers do not write a follow-up
 * directly into the resumed prompt.
 */
export async function enqueueDelegatedTaskInbox(
  delegationId: string,
  input: DelegatedTaskInboxInput
): Promise<AgentInputQueueEntry> {
  const record = requireDelegatedTaskRecord(delegationId, input.requestedBy);
  const entry = await withChildInbox(record, (queue) =>
    queue.enqueue({
      delivery: 'next_run',
      text: input.text,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      scope: { sessionId: record.child_session_id },
    })
  );
  if (input.wake !== false) {
    void wakeRegisteredDelegatedTaskWorker(delegationId, input.requestedBy).catch((error) => {
      logger.warn(
        `[delegated-task] child worker wake failed after enqueue: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }
  return entry;
}

/** Return whether a continuable child still has durable work waiting to run. */
export async function hasPendingDelegatedTaskInbox(
  delegationId: string,
  requestedBy?: string
): Promise<boolean> {
  const record = requireDelegatedTaskRecord(delegationId, requestedBy);
  const pending = await withChildInbox(record, (queue) =>
    queue.peek('next_run', 1, { sessionId: record.child_session_id })
  );
  return pending.length > 0;
}

/** Consume the child-session inbox at one cold-resume boundary. */
export async function consumeDelegatedTaskInbox(
  delegationId: string,
  options: { requestedBy?: string; limit?: number } = {}
): Promise<AgentInputQueueEntry[]> {
  const record = requireDelegatedTaskRecord(delegationId, options.requestedBy);
  return withChildInbox(record, (queue) =>
    queue.consume('next_run', options.limit ?? 32, { sessionId: record.child_session_id })
  );
}

function persistRecord(trace: DelegatedTaskTrace): void {
  try {
    persistRecordStrict(trace);
  } catch (error) {
    // The persisted record is a resumability aid — never fail the delegation.
    logger.warn(
      `[delegated-task] record persistence failed (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

/**
 * Write the record to its own tenant's partition (`tenant_slug`, stamped at
 * start; system when absent). A legacy shared copy of the same delegation is
 * removed once the partitioned copy is written (migration on first write).
 */
function persistRecordStrict(trace: DelegatedTaskTrace): void {
  const { trace_id, ...rest } = trace;
  const record: DelegatedTaskRecord = { delegation_id: trace_id, ...rest };
  const filePath = recordPathIn(normalizeTenant(record.tenant_slug), trace_id);
  const canonical = delegatedTaskRecordCatalog(filePath).validate(record, filePath);
  const serialized = `${JSON.stringify(canonical, null, 2)}\n`;
  writeObservabilityLeaf(filePath, serialized, false);
  removeLegacyRecordCopy(trace_id);
}

function removeLegacyRecordCopy(delegationId: string): void {
  const legacyPath = legacyRecordPath(delegationId);
  try {
    if (!safeExistsSync(legacyPath) || !safeLstat(legacyPath).isFile()) return;
    safeUnlinkSync(legacyPath);
    logger.info(
      `[delegated-task] legacy shared record migrated into its partition: ${delegationId}`
    );
  } catch (error) {
    logger.warn(
      `delegation legacy record not removed — ${error instanceof Error ? error.message : String(error)} | next: the partitioned copy is authoritative; tenant offboarding scrubs the legacy copy | evidence: ${legacyPath}`
    );
  }
}

export function startDelegatedTaskTrace(input: {
  owner: string;
  instruction: string;
  context?: string;
  contextRef?: string;
  backendName?: string;
  /** KC-06: background delegations enqueue a claim-based notification on completion. */
  background?: boolean;
  resumedFrom?: string;
  missionId?: string;
  taskId?: string;
  /** DH-12: make this delegation a durable child session resumable once. */
  continuable?: boolean;
  /**
   * Tenant partition of the trace/record. Defaults to the bound tenant; a
   * resume passes its source record's tenant so the resumed prompt (which
   * embeds the original instruction) never lands in the system partition.
   */
  tenantSlug?: string;
}): DelegatedTaskTrace {
  const bound = boundTenantSlug();
  const requested = normalizeTenant(input.tenantSlug);
  if (bound && requested && requested !== bound) {
    throw new Error(
      `[DELEGATION_TENANT_SCOPE_MISMATCH] this process is bound to tenant '${bound}'; a delegation for another tenant is refused`
    );
  }
  const tenantSlug = requested ?? bound;
  const trace: DelegatedTaskTrace = {
    trace_id: randomUUID(),
    kind: 'delegated_task',
    created_at: nowIso(),
    status: 'started',
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    owner: input.owner,
    instruction: input.instruction,
    ...(input.context ? { context: input.context } : {}),
    ...(input.contextRef ? { context_ref: input.contextRef } : {}),
    ...(input.backendName ? { backend_name: input.backendName } : {}),
    ...(input.background ? { background: true } : {}),
    ...(input.resumedFrom ? { resumed_from: input.resumedFrom } : {}),
    ...(input.missionId ? { mission_id: input.missionId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
    ...(input.continuable
      ? {
          continuable: true,
          child_session_id: `child-${randomUUID()}`,
          activation_count: 0,
          activation_status: 'pending',
        }
      : {}),
  };
  appendTrace(trace);
  persistRecord(trace);
  return trace;
}

export function completeDelegatedTaskTrace(
  trace: DelegatedTaskTrace,
  outcome: {
    resultSummary?: string;
    error?: string;
    gapPhases?: Array<{ phase: string; ms: number }>;
    /** R2: structured result; derived from resultSummary/error when absent. */
    result?: DelegationResult;
  }
): DelegatedTaskTrace {
  const gapPhases = outcome.gapPhases
    ? sanitizeGapSamples(outcome.gapPhases, (message) => logger.warn(message))
    : undefined;
  const completedAt = nowIso();
  const result =
    outcome.result ??
    (outcome.error
      ? buildFailedDelegationResult(new Error(outcome.error))
      : buildCompletedDelegationResult(outcome.resultSummary ?? ''));
  const completed: DelegatedTaskTrace = {
    ...trace,
    completed_at: completedAt,
    status: outcome.error ? 'failed' : 'completed',
    ...(outcome.resultSummary ? { result_summary: outcome.resultSummary } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(gapPhases && gapPhases.length ? { gap_phases: gapPhases } : {}),
    outcome: outcomeOf(result),
    child_report: {
      source: 'child',
      delegation_id: trace.trace_id,
      ...(trace.child_session_id ? { child_session_id: trace.child_session_id } : {}),
      ...(outcome.resultSummary ? { summary: outcome.resultSummary } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    },
    settlement: {
      source: 'owner',
      report_delegation_id: trace.trace_id,
      settled_at: completedAt,
      status: outcome.error ? 'failed' : 'completed',
    },
  };
  appendTrace(completed);
  persistRecord(completed);
  if (completed.background) {
    // KC-06: background completions are delivered into the running worker's
    // context via the claim-based notification queue — best-effort only.
    try {
      enqueueDelegationNotification({
        delegationId: completed.trace_id,
        owner: completed.owner,
        ...(completed.mission_id ? { missionId: completed.mission_id } : {}),
        ...(completed.task_id ? { taskId: completed.task_id } : {}),
        ...(completed.child_session_id ? { childSessionId: completed.child_session_id } : {}),
        status: completed.status === 'failed' ? 'failed' : 'completed',
        instruction: completed.instruction,
        result: completed.result_summary,
        error: completed.error,
        completedAt: completed.completed_at,
      });
    } catch (error) {
      logger.warn(
        `[delegated-task] completion notification enqueue failed (non-fatal): ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return completed;
}

export function cancelDelegatedTaskTrace(
  trace: DelegatedTaskTrace,
  reason = 'cancelled by caller'
): DelegatedTaskTrace {
  const cancelledAt = nowIso();
  const cancelled: DelegatedTaskTrace = {
    ...trace,
    completed_at: cancelledAt,
    status: 'cancelled',
    error: reason,
    outcome: outcomeOf(buildCancelledDelegationResult(reason)),
    settlement: {
      source: 'owner',
      report_delegation_id: trace.trace_id,
      settled_at: cancelledAt,
      status: 'cancelled',
    },
  };
  appendTrace(cancelled);
  persistRecord(cancelled);
  return cancelled;
}

/**
 * Atomically claim the single cold-resume activation of a continuable child.
 * The record is persisted before the caller may dispatch the resumed child.
 */
export function claimDelegatedTaskActivation(
  delegationId: string,
  requestedBy?: string
): DelegatedTaskRecord {
  return withLockSync(`delegation-activation:${delegationId}`, () => {
    const record = loadDelegatedTaskRecord(delegationId);
    if (!record) throw new Error(`Delegated task record not found for id "${delegationId}".`);
    if (!record.continuable || !record.child_session_id) {
      throw new Error(`Delegated task "${delegationId}" is not a continuable child session.`);
    }
    if (requestedBy && requestedBy !== record.owner) {
      throw new Error(
        `Delegated task "${delegationId}" is owned by "${record.owner}"; activation rejected for requester "${requestedBy}".`
      );
    }
    if ((record.activation_count ?? 0) >= 1) {
      throw new Error(
        `Delegated child session "${record.child_session_id}" has exhausted its one-shot activation.`
      );
    }
    const activated: DelegatedTaskRecord = {
      ...record,
      activation_count: 1,
      activation_id: randomUUID(),
      activated_at: nowIso(),
      activation_status: 'claimed',
    };
    const { delegation_id, ...rest } = activated;
    persistRecordStrict({ trace_id: delegation_id, ...rest });
    return activated;
  });
}

/**
 * Permanently record a cold-resume activation failure.
 *
 * The activation has already been consumed by `claimDelegatedTaskActivation`.
 * This second locked write makes that outcome explicit to operators and to a
 * future resume caller; it deliberately never resets `activation_count` or
 * creates a retry path.
 */
export function recordDelegatedTaskActivationFailure(
  delegationId: string,
  activationId: string,
  error: string
): DelegatedTaskRecord {
  return withLockSync(`delegation-activation:${delegationId}`, () => {
    const record = loadDelegatedTaskRecord(delegationId);
    if (!record) throw new Error(`Delegated task record not found for id "${delegationId}".`);
    if (!record.continuable || !record.child_session_id) {
      throw new Error(`Delegated task "${delegationId}" is not a continuable child session.`);
    }
    if (record.activation_id !== activationId) {
      throw new Error(`Delegated task "${delegationId}" activation id does not match.`);
    }
    if (record.activation_failure) return record;

    const failedAt = nowIso();
    const failure: DelegatedTaskRecord = {
      ...record,
      activation_status: 'failed',
      activation_failure: {
        source: 'owner',
        activation_id: activationId,
        failed_at: failedAt,
        error: String(error || 'activation failed').slice(0, 500),
      },
    };
    // The snapshot is the recovery authority. Keep the append-only audit
    // stream best-effort so an audit filesystem issue cannot erase the fact
    // that the one-shot activation is already consumed.
    const { delegation_id, ...rest } = failure;
    persistRecordStrict({ trace_id: delegation_id, ...rest });
    try {
      appendTrace({ trace_id: delegation_id, ...rest });
    } catch (appendError) {
      logger.warn(
        `[delegated-task] activation failure audit append failed (snapshot retained): ${
          appendError instanceof Error ? appendError.message : String(appendError)
        }`
      );
    }
    return failure;
  });
}

/**
 * Settle a claimed cold-resume activation after the child worker has produced
 * its result. A separate marker lets the supervisor distinguish a normal
 * worker exit from a crash that happened before dispatch settled.
 */
export function recordDelegatedTaskActivationCompletion(
  delegationId: string,
  activationId: string,
  resultDelegationId: string
): DelegatedTaskRecord {
  return withLockSync(`delegation-activation:${delegationId}`, () => {
    const record = loadDelegatedTaskRecord(delegationId);
    if (!record) throw new Error(`Delegated task record not found for id "${delegationId}".`);
    if (!record.continuable || !record.child_session_id) {
      throw new Error(`Delegated task "${delegationId}" is not a continuable child session.`);
    }
    if (record.activation_id !== activationId) {
      throw new Error(`Delegated task "${delegationId}" activation id does not match.`);
    }
    if (record.activation_failure) return record;
    if (record.activation_status === 'completed') return record;

    const completedAt = nowIso();
    const completed: DelegatedTaskRecord = {
      ...record,
      activation_status: 'completed',
      activation_completed_at: completedAt,
      activation_result_delegation_id: resultDelegationId,
    };
    const { delegation_id, ...rest } = completed;
    persistRecordStrict({ trace_id: delegation_id, ...rest });
    try {
      appendTrace({ trace_id: delegation_id, ...rest });
    } catch (appendError) {
      logger.warn(
        `[delegated-task] activation completion audit append failed (snapshot retained): ${
          appendError instanceof Error ? appendError.message : String(appendError)
        }`
      );
    }
    return completed;
  });
}

/**
 * Start a durable, id-addressable delegation without changing the legacy
 * delegateTask promise API. Cancellation is best effort: a provider may supply
 * a real cancel callback (for example SIGTERM/SIGKILL); otherwise the handle
 * stops awaiting the result and records the terminal cancellation state.
 */
export function createDelegationHandle(input: {
  owner?: string;
  instruction: string;
  context?: string;
  backendName?: string;
  missionId?: string;
  taskId?: string;
  continuable?: boolean;
  execute: (signal?: AbortSignal) => Promise<string>;
  cancel?: (reason: string) => Promise<void> | void;
}): DelegationHandle {
  const trace = startDelegatedTaskTrace({
    owner:
      input.owner ||
      getRegisteredEnvText('MISSION_ROLE') ||
      getRegisteredEnvText('KYBERION_PERSONA') ||
      'reasoning-backend',
    instruction: input.instruction,
    ...(input.context ? { context: input.context } : {}),
    ...(input.backendName ? { backendName: input.backendName } : {}),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.continuable ? { continuable: true } : {}),
  });
  let record = trace;
  let cancelled = false;
  let cancelPromise: Promise<void> | undefined;
  let structured: DelegationResult | undefined;
  const controller = new AbortController();
  const result = runWithDelegationExecutionTracker(async (tracker) => {
    // Preserve the deferred start: execute never runs before the handle exists.
    await Promise.resolve();
    try {
      const value = await input.execute(controller.signal);
      structured = buildCompletedDelegationResult(value, tracker.metadata);
      if (!cancelled) {
        record = completeDelegatedTaskTrace(record, { resultSummary: value, result: structured });
      }
      return value;
    } catch (error: unknown) {
      structured = buildFailedDelegationResult(error, tracker.metadata);
      if (!cancelled) {
        record = completeDelegatedTaskTrace(record, {
          error: error instanceof Error ? error.message : String(error),
          result: structured,
        });
      }
      throw error;
    }
  });
  const cancelledResult = () => buildCancelledDelegationResult(record.error || 'cancelled');
  return {
    delegation_id: trace.trace_id,
    status: () => {
      const { trace_id: _traceId, ...rest } = record;
      return { delegation_id: trace.trace_id, ...rest };
    },
    join: async () => {
      if (cancelled) throw new Error(`[DELEGATION_CANCELLED] ${record.error || 'cancelled'}`);
      const value = await result;
      if (cancelled) throw new Error(`[DELEGATION_CANCELLED] ${record.error || 'cancelled'}`);
      return value;
    },
    joinResult: async () => {
      if (cancelled) return cancelledResult();
      await result.catch(() => undefined);
      if (cancelled) return cancelledResult();
      return (
        structured ?? buildFailedDelegationResult(new Error('delegation settled without result'))
      );
    },
    cancel: async (reason = 'cancelled by caller') => {
      if (cancelled || record.status !== 'started') return;
      cancelled = true;
      controller.abort(reason);
      // A provider that cannot observe the signal may still settle later. The
      // handle remains terminal and join() refuses the late result.
      void result.catch(() => undefined);
      if (input.cancel) {
        cancelPromise = Promise.resolve(input.cancel(reason));
        await cancelPromise;
      }
      record = cancelDelegatedTaskTrace(record, reason);
    },
  };
}

/**
 * A delegation record visible to this process: a tenant-bound process sees its
 * own partition (and legacy shared records attributed to it) only — never
 * another tenant's; an unbound process searches the system partition, every
 * tenant partition, then the legacy shared directory.
 */
export function loadDelegatedTaskRecord(delegationId: string): DelegatedTaskRecord | null {
  try {
    return locateDelegatedTaskRecord(delegationId)?.record ?? null;
  } catch {
    return null;
  }
}

/**
 * Which partitions a delegation reader reads. Omitted: the process's own scope
 * (its bound tenant, or the system partition when unbound). A tenant-bound
 * process may only narrow to its own tenant; named tenants or the system
 * partition beyond that are dropped (a caller-supplied scope never broadens).
 */
export interface DelegationReadScope {
  tenants?: readonly string[];
  includeSystem?: boolean;
}

function effectiveReadScope(read?: DelegationReadScope): {
  tenants: string[];
  includeSystem: boolean;
} {
  const bound = boundTenantSlug();
  const requested = (read?.tenants ?? [])
    .map((tenant) => normalizeTenant(tenant))
    .filter((tenant): tenant is string => Boolean(tenant));
  if (bound) {
    if (read && (read.includeSystem || requested.some((tenant) => tenant !== bound))) {
      logger.debug(
        `delegation read narrowed — a tenant-bound process reads only its own partition | next: none | evidence: bound=${bound}`
      );
    }
    return { tenants: !read || requested.includes(bound) ? [bound] : [], includeSystem: false };
  }
  if (!read) return { tenants: [], includeSystem: true };
  return { tenants: [...new Set(requested)], includeSystem: read.includeSystem === true };
}

function readPartitionRecords(tenant: string | undefined): DelegatedTaskRecord[] {
  const dir = recordsDirFor(tenant);
  try {
    return asDelegationStore(dir, () => {
      if (!safeExistsSync(dir)) return [];
      return safeReaddir(dir)
        .filter((entry) => entry.endsWith('.json'))
        .map((entry) => loadFromPartition(tenant, entry.slice(0, -'.json'.length))?.record)
        .filter((record): record is DelegatedTaskRecord => Boolean(record));
    });
  } catch (error) {
    logger.debug(
      `delegation partition skipped — ${error instanceof Error ? error.message : String(error)} | next: read it from a process scoped to that tenant | evidence: ${dir}`
    );
    return [];
  }
}

/** Legacy shared records whose attribution falls inside the read scope. */
function readLegacyRecords(scope: { tenants: string[]; includeSystem: boolean }) {
  const dir = legacyLocation().recordDir;
  if (!safeExistsSync(dir)) return [];
  const records: DelegatedTaskRecord[] = [];
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.json')) continue;
    let record: DelegatedTaskRecord | null = null;
    try {
      record = readRecordFile(legacyRecordPath(entry.slice(0, -'.json'.length)));
    } catch {
      continue;
    }
    if (!record) continue;
    const attribution = legacyRecordTenant(record);
    if (!attribution) continue;
    const visible = attribution.tenant
      ? scope.tenants.includes(attribution.tenant)
      : scope.includeSystem;
    if (visible) {
      records.push({
        ...record,
        ...(attribution.tenant ? { tenant_slug: attribution.tenant } : {}),
      });
    }
  }
  return records;
}

/** Every record in the read scope (partitioned first, then unmigrated legacy copies). */
function listDelegatedTaskRecords(read?: DelegationReadScope): DelegatedTaskRecord[] {
  const scope = effectiveReadScope(read);
  const records = [
    ...(scope.includeSystem ? readPartitionRecords(undefined) : []),
    ...scope.tenants.flatMap((tenant) => readPartitionRecords(tenant)),
  ];
  const seen = new Set(records.map((record) => record.delegation_id));
  for (const record of readLegacyRecords(scope)) {
    if (!seen.has(record.delegation_id)) records.push(record);
  }
  return records;
}

/**
 * Still-running delegations (status `started`), newest first. Feeds the
 * post-compaction active-task snapshot (bounded by `limit`).
 */
export function listActiveDelegatedTaskRecords(
  limit = 8,
  read?: DelegationReadScope
): DelegatedTaskRecord[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  return listDelegatedTaskRecords(read)
    .filter((record) => record.status === 'started')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, boundedLimit);
}

/**
 * KC-06: resume a completed (or still-open) delegation by id — the stored
 * instruction and result are embedded as context for a fresh delegateTask
 * carrying the follow-up instruction.
 *
 * KD-05: when a subagent (rather than the owning worker itself) initiates
 * the resume, callers pass `requestedBy` so this function can verify the
 * requester actually owns the delegation — the Kyberion-side equivalent of
 * kimi-code's `ensureOwnedIdleSubagent`. A still-running delegation
 * (`status: 'started'`) is always rejected regardless of `requestedBy`: two
 * concurrent resumes of the same in-flight delegation is a race no caller
 * should be relying on.
 */
export async function resumeDelegatedTask(
  delegationId: string,
  followUpInstruction: string,
  options: {
    backend?: { delegateTask(instruction: string, context?: string): Promise<string> };
    owner?: string;
    /** KD-05: identity attempting the resume, checked against record.owner. */
    requestedBy?: string;
    /** Consume an already queued next_run entry from a registered child worker. */
    fromInbox?: boolean;
  } = {}
): Promise<{ result: string; trace: DelegatedTaskTrace; record: DelegatedTaskRecord }> {
  const record = loadDelegatedTaskRecord(delegationId);
  if (!record) {
    throw new Error(`Delegated task record not found for id "${delegationId}".`);
  }
  if (record.status === 'started') {
    throw new Error(
      `Delegated task "${delegationId}" is still running; resume is rejected until it completes or fails.`
    );
  }
  if (options.requestedBy && options.requestedBy !== record.owner) {
    throw new Error(
      `Delegated task "${delegationId}" is owned by "${record.owner}"; resume rejected for requester "${options.requestedBy}".`
    );
  }
  if (options.fromInbox && !record.continuable) {
    throw new Error(`Delegated task "${delegationId}" has no child-session inbox.`);
  }
  if (record.continuable) {
    // Claim before composing/dispatching so two cold resumes cannot both run.
    const activated = claimDelegatedTaskActivation(delegationId, options.requestedBy);
    Object.assign(record, activated);
  }
  const activationId = record.continuable ? record.activation_id : undefined;
  let trace: DelegatedTaskTrace | undefined;
  try {
    // Existing reasoning/delegation cycle is tracked by the module-boundary baseline.
    const backend =
      // eslint-disable-next-line import/no-cycle -- baseline until the delegation seam is split
      options.backend ?? (await import('./reasoning/reasoning-backend.js')).getReasoningBackend();
    const inboxEntries = record.continuable
      ? await (async () => {
          if (!options.fromInbox) {
            await enqueueDelegatedTaskInbox(delegationId, {
              text: followUpInstruction,
              ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
              metadata: { source: 'cold-resume' },
              wake: false,
            });
          }
          return consumeDelegatedTaskInbox(delegationId, {
            ...(options.requestedBy ? { requestedBy: options.requestedBy } : {}),
          });
        })()
      : [];
    if (options.fromInbox && inboxEntries.length === 0) {
      throw new Error(`[DELEGATED_TASK_WORKER] no pending inbox entry for "${delegationId}".`);
    }
    const effectiveFollowUpInstruction = record.continuable
      ? inboxEntries.map((entry) => entry.text).join('\n')
      : followUpInstruction;
    const prompt = [
      'You previously executed a delegated task. Resume it with the follow-up below;',
      'do not restart the original work from scratch.',
      '',
      'Original instruction:',
      record.instruction,
      '',
      'Previous result:',
      record.result_summary ||
        (record.error
          ? `The previous attempt failed: ${record.error}`
          : '(no result recorded yet — the task may still be running)'),
      '',
      'Follow-up instruction:',
      effectiveFollowUpInstruction,
    ].join('\n');
    trace = startDelegatedTaskTrace({
      owner: options.owner || record.owner,
      instruction: prompt,
      ...(record.context ? { context: record.context } : {}),
      ...(record.context_ref ? { contextRef: record.context_ref } : {}),
      resumedFrom: record.delegation_id,
      ...(record.mission_id ? { missionId: record.mission_id } : {}),
      ...(record.task_id ? { taskId: record.task_id } : {}),
      ...(record.tenant_slug ? { tenantSlug: record.tenant_slug } : {}),
    });
    const result = await backend.delegateTask(prompt, record.context);
    const completed = completeDelegatedTaskTrace(trace, { resultSummary: result });
    const settledRecord = activationId
      ? recordDelegatedTaskActivationCompletion(delegationId, activationId, completed.trace_id)
      : record;
    return { result, trace: completed, record: settledRecord };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (activationId) {
      try {
        Object.assign(
          record,
          recordDelegatedTaskActivationFailure(delegationId, activationId, errorMessage)
        );
      } catch (recordingError) {
        logger.error(
          `[delegated-task] cold-resume activation failure could not be recorded: ${
            recordingError instanceof Error ? recordingError.message : String(recordingError)
          }`
        );
      }
    }
    if (trace) {
      completeDelegatedTaskTrace(trace, { error: errorMessage });
    }
    throw error;
  }
}

/** Records directory of this process's scope (bound tenant partition, else system). */
export function delegatedTaskStoreDir(): string {
  return recordsDirFor(boundTenantSlug());
}

/** Where the record of `delegationId` lives (or would live) in this process's scope. */
export function delegatedTaskRecordPath(delegationId: string): string {
  return recordPathIn(boundTenantSlug(), delegationId);
}
