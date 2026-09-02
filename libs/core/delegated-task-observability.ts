import { appendJsonLine, readJson } from './foundation/json.js';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { nowIso } from './foundation/time.js';
import { logger } from './core.js';
import { getMissionAgentInputQueue, type AgentInputQueueEntry } from './agent-input-queue.js';
import { enqueueDelegationNotification } from './delegation-notifications.js';
import { sanitizeGapSamples } from './gap-phase.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import { withLockSync } from './src/lock-utils.js';
import { spawnManagedProcess, type ManagedProcessHandle } from './managed-process.js';

export interface DelegatedTaskTrace {
  trace_id: string;
  kind: 'delegated_task';
  created_at: string;
  completed_at?: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
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
  join(): Promise<string>;
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

// Tests namespace the trace/store via KYBERION_DELEGATION_TRACE_PATH /
// KYBERION_DELEGATION_STORE_DIR so parallel suites never clobber the real
// observability files (resolved lazily per call).
function resolveTracePath(): string {
  const override = getRegisteredEnvText('KYBERION_DELEGATION_TRACE_PATH')?.trim();
  const candidate = override
    ? pathResolver.rootResolve(override)
    : pathResolver.shared('observability/delegations.jsonl');
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

function resolveStoreDir(): string {
  const override = getRegisteredEnvText('KYBERION_DELEGATION_STORE_DIR')?.trim();
  const candidate = override
    ? pathResolver.rootResolve(override)
    : pathResolver.shared('observability/delegations');
  return assertSafeRepositoryPath(candidate, { allowMissingLeaf: true });
}

function ensureTraceDir(): void {
  const traceDir = assertSafeRepositoryPath(path.dirname(resolveTracePath()), {
    allowMissingLeaf: true,
  });
  if (!safeExistsSync(traceDir)) {
    safeMkdir(traceDir, { recursive: true });
  }
}

function appendTrace(record: DelegatedTaskTrace): void {
  ensureTraceDir();
  appendJsonLine(resolveTracePath(), record);
}

function recordPath(delegationId: string): string {
  const safeId = String(delegationId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!safeId) throw new Error('Delegation id is required.');
  return assertSafeRepositoryPath(path.join(resolveStoreDir(), `${safeId}.json`), {
    allowMissingLeaf: true,
  });
}

function childInboxPath(childSessionId: string): string {
  const safeId = String(childSessionId || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!safeId) throw new Error('Child session id is required.');
  return assertSafeRepositoryPath(path.join(resolveStoreDir(), 'child-inbox', `${safeId}.jsonl`), {
    allowMissingLeaf: true,
  });
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

function childInboxQueue(record: DelegatedTaskRecord) {
  return getMissionAgentInputQueue({
    missionId: record.child_session_id!,
    queuePath: childInboxPath(record.child_session_id!),
  });
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
  return {
    resourceId,
    delegationId,
    owner,
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
      env: process.env,
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
  const pending = await childInboxQueue(record).peek('next_run', 1, {
    sessionId: record.child_session_id,
  });
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
  const entry = await childInboxQueue(record).enqueue({
    delivery: 'next_run',
    text: input.text,
    ...(input.metadata ? { metadata: input.metadata } : {}),
    scope: { sessionId: record.child_session_id },
  });
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
  const pending = await childInboxQueue(record).peek('next_run', 1, {
    sessionId: record.child_session_id,
  });
  return pending.length > 0;
}

/** Consume the child-session inbox at one cold-resume boundary. */
export async function consumeDelegatedTaskInbox(
  delegationId: string,
  options: { requestedBy?: string; limit?: number } = {}
): Promise<AgentInputQueueEntry[]> {
  const record = requireDelegatedTaskRecord(delegationId, options.requestedBy);
  return childInboxQueue(record).consume('next_run', options.limit ?? 32, {
    sessionId: record.child_session_id,
  });
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

function persistRecordStrict(trace: DelegatedTaskTrace): void {
  const dir = assertSafeRepositoryPath(resolveStoreDir(), { allowMissingLeaf: true });
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  const { trace_id, ...rest } = trace;
  const record: DelegatedTaskRecord = { delegation_id: trace_id, ...rest };
  safeWriteFile(recordPath(trace_id), `${JSON.stringify(record, null, 2)}\n`);
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
}): DelegatedTaskTrace {
  const trace: DelegatedTaskTrace = {
    trace_id: randomUUID(),
    kind: 'delegated_task',
    created_at: nowIso(),
    status: 'started',
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
  }
): DelegatedTaskTrace {
  const gapPhases = outcome.gapPhases
    ? sanitizeGapSamples(outcome.gapPhases, (message) => logger.warn(message))
    : undefined;
  const completedAt = nowIso();
  const completed: DelegatedTaskTrace = {
    ...trace,
    completed_at: completedAt,
    status: outcome.error ? 'failed' : 'completed',
    ...(outcome.resultSummary ? { result_summary: outcome.resultSummary } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(gapPhases && gapPhases.length ? { gap_phases: gapPhases } : {}),
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
      process.env.MISSION_ROLE ||
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
  const controller = new AbortController();
  const result = Promise.resolve()
    .then(() => input.execute(controller.signal))
    .then((value) => {
      if (!cancelled) record = completeDelegatedTaskTrace(record, { resultSummary: value });
      return value;
    })
    .catch((error: unknown) => {
      if (!cancelled) {
        record = completeDelegatedTaskTrace(record, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      throw error;
    });
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

export function loadDelegatedTaskRecord(delegationId: string): DelegatedTaskRecord | null {
  try {
    const filePath = recordPath(delegationId);
    if (!safeExistsSync(filePath)) return null;
    const parsed = readJson<DelegatedTaskRecord>(filePath);
    return parsed && typeof parsed.delegation_id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Still-running delegations (status `started`), newest first. Feeds the
 * post-compaction active-task snapshot (bounded by `limit`).
 */
export function listActiveDelegatedTaskRecords(limit = 8): DelegatedTaskRecord[] {
  const boundedLimit = Math.max(0, Math.floor(limit));
  if (boundedLimit === 0) return [];
  const dir = assertSafeRepositoryPath(resolveStoreDir(), { allowMissingLeaf: true });
  if (!safeExistsSync(dir)) return [];
  const records: DelegatedTaskRecord[] = [];
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith('.json')) continue;
    const record = loadDelegatedTaskRecord(entry.slice(0, -'.json'.length));
    if (record?.status === 'started') records.push(record);
  }
  return records
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
      options.backend ?? (await import('./reasoning-backend.js')).getReasoningBackend();
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

export function delegatedTaskStoreDir(): string {
  return resolveStoreDir();
}
