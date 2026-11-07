/**
 * Idempotent delegation (R5).
 *
 * A caller-supplied `idempotencyKey` binds one delegated execution to one
 * normalized payload. Concept borrowed from HarnessRouter's UHP idempotency
 * contract; re-implemented on Kyberion's runtime-store conventions:
 *
 * - same key + different payload hash → `DelegationIdempotencyConflictError`,
 *   nothing executes;
 * - same key + same hash while in flight → join the first execution
 *   (in-process: the same promise; cross-process: wait for its record);
 * - same key + same hash after terminal → replay the stored result;
 * - an in-flight reservation is assumed started (persisted before execute());
 *   it is released only when the failure provably happened before start (an
 *   explicit marker or a structural spawn failure). A dead or silent owner's
 *   record settles as `incomplete/interrupted` — never adopted, never re-run.
 *
 * Reservations are durable state under the registered partitioned root
 * `active/shared/runtime/delegation-idempotency/` (`confidential/<tenant>/`
 * for tenant scopes, `system/` otherwise), written through secure-io.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { logger } from '../core.js';
import { currentResourceAccessScope } from '../foundation/resource-access-scope.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { nowIso } from '../foundation/time.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { pathResolver } from '../path-resolver.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '../foundation/runtime-state-roots.js';
import { storagePartitionSegments } from '../storage-layout.js';
import { assertSafeRepositoryPath, safeExistsSync } from '../secure-io.js';
import { readJson } from '../foundation/json.js';
import { isRecordedProcessAlive, processStartMarker } from './workspace-process-identity.js';
import { writeDelegationHostLeaf } from './delegated-task-observability.js';
import {
  buildCompletedDelegationResult,
  buildFailedDelegationResult,
  delegationExecutionStartedFromError,
  DelegationTerminalError,
  markErrorExecutionStarted,
  runWithDelegationExecutionTracker,
  type DelegationResult,
} from './delegation-result.js';

/**
 * Reservation store root (repo-relative): a registered tier/tenant-partitioned
 * runtime-state root, so tier-guard applies the tenant boundary and tenant
 * offboarding / backup walk it. Tenant reservations live under
 * `confidential/<tenant>/` (they carry tenant delegation output), untenanted
 * ones under `system/`.
 */
export const DELEGATION_IDEMPOTENCY_STORE_ROOT =
  PARTITIONED_RUNTIME_STATE_ROOTS.delegation_idempotency;
/** Tier of tenant reservations: replayable results hold tenant delegation output. */
const RESERVATION_TIER = 'confidential';

/** Identifies this module instance so a recycled pid never adopts a reservation. */
const OWNER_INSTANCE = randomUUID();

export class DelegationIdempotencyConflictError extends Error {
  readonly code = 'DELEGATION_IDEMPOTENCY_CONFLICT';
  readonly failureClass = 'request' as const;
  readonly executionStarted = false;
  constructor(
    readonly idempotencyKey: string,
    readonly storedPayloadHash: string,
    readonly payloadHash: string
  ) {
    super(
      `[DELEGATION_IDEMPOTENCY_CONFLICT] idempotency key "${idempotencyKey}" is bound to a different delegation payload — refusing to execute | use a new key for a changed payload (e.g. the next attempt) | stored=${storedPayloadHash.slice(0, 12)} requested=${payloadHash.slice(0, 12)}`
    );
    this.name = 'DelegationIdempotencyConflictError';
  }
}

/** Derive a stable key for one attempt of one work item. */
export function deriveDelegationIdempotencyKey(input: {
  workItemId: string;
  attempt: number | string;
}): string {
  const workItemId = String(input.workItemId ?? '').trim();
  if (!workItemId) throw new Error('[DELEGATION_IDEMPOTENCY_KEY_INVALID] workItemId is required');
  const attempt =
    typeof input.attempt === 'number' ? input.attempt : String(input.attempt ?? '').trim();
  if (
    (typeof attempt === 'number' && (!Number.isSafeInteger(attempt) || attempt < 0)) ||
    attempt === ''
  ) {
    throw new Error(
      '[DELEGATION_IDEMPOTENCY_KEY_INVALID] attempt must be a non-negative integer or a run id'
    );
  }
  return `work-item:${workItemId}:attempt:${attempt}`;
}

/**
 * Options that never change what is executed: cancellation, presentation /
 * projection hints, stream watchdogs and audit receipts. Everything else is
 * execution-relevant (a deny-list, so a newly added option is conservatively
 * part of the payload and surfaces as a conflict rather than a silent replay).
 */
const NON_PAYLOAD_OPTION_KEYS: ReadonlySet<string> = new Set([
  'idempotencyKey',
  'signal',
  'delegation_result',
  'delegation_inactivity',
  'prompt_visibility',
]);

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalize(entry) ?? null);
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const entry = canonicalize((value as Record<string, unknown>)[key]);
    if (entry !== undefined) output[key] = entry;
  }
  return output;
}

/** sha256 of the normalized instruction, context and execution-relevant options. */
export function computeDelegationPayloadHash(input: {
  instruction: string;
  context?: string;
  options?: object;
}): string {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.options ?? {})) {
    if (!NON_PAYLOAD_OPTION_KEYS.has(key)) options[key] = value;
  }
  const normalized = canonicalize({
    instruction: String(input.instruction ?? ''),
    context: input.context ? String(input.context) : '',
    options,
  });
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Durable reservation. `started_at` is written BEFORE execution begins: an
 * in-flight record is assumed started (side effects may exist) unless the
 * owner later proves a pre-start failure and releases it. A dead owner's
 * in-flight record therefore settles as `incomplete/interrupted` — never a
 * re-run.
 */
export interface DelegationReservation {
  kind: 'delegation_reservation';
  idempotency_key: string;
  payload_hash: string;
  status: 'in_flight' | 'terminal' | 'released';
  reserved_at: string;
  owner_pid: number;
  owner_instance: string;
  /** Host the owner runs on; another host's pid is never probed locally. */
  owner_host: string;
  /** `ps lstart` (or platform equivalent) of the owner; guards pid reuse. */
  owner_start_marker?: string;
  /** Owner heartbeat; a stale heartbeat from another host means the owner is gone. */
  heartbeat_at: string;
  /** Principal (mission / organization / project) the key is namespaced by. */
  principal?: string;
  /** Assumed start, persisted before execute(). */
  started_at: string;
  completed_at?: string;
  result?: DelegationResult;
}

interface IdempotencyTiming {
  pollMs: number;
  /** Upper bound a joiner waits on another live owner before a typed timeout. */
  maxWaitMs: number;
  heartbeatMs: number;
  /** A heartbeat older than this from another host means the owner is gone. */
  leaseMs: number;
}

const DEFAULT_TIMING: IdempotencyTiming = {
  pollMs: 250,
  maxWaitMs: 60 * 60 * 1000,
  heartbeatMs: 30 * 1000,
  leaseMs: 5 * 60 * 1000,
};
let timing: IdempotencyTiming = { ...DEFAULT_TIMING };
let hostOverride: string | undefined;
let ownStartMarker: string | undefined | null = null;

function currentHost(): string {
  return hostOverride ?? os.hostname();
}

function selfStartMarker(): string | undefined {
  if (ownStartMarker === null) ownStartMarker = processStartMarker(process.pid);
  return ownStartMarker;
}

function scopeTenantSlug(): string | undefined {
  return currentResourceAccessScope()?.tenantSlug ?? resolvePolicyIdentityContext().tenantSlug;
}

/** Mission / organization / project principal that namespaces a key, when known. */
function scopePrincipal(): string | undefined {
  const scope = currentResourceAccessScope();
  const missionId = resolvePolicyIdentityContext().missionId;
  const parts = [
    missionId ? `mission:${missionId}` : '',
    scope?.organizationId ? `org:${scope.organizationId}` : '',
    scope?.projectId ? `project:${scope.projectId}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join('/') : undefined;
}

function keyDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 40);
}

function reservationPath(
  idempotencyKey: string,
  tenantSlug: string | undefined,
  principal: string | undefined
): string {
  const relative = path.posix.join(
    DELEGATION_IDEMPOTENCY_STORE_ROOT,
    ...storagePartitionSegments(
      tenantSlug ? { kind: 'tier', tier: RESERVATION_TIER, tenant: tenantSlug } : { kind: 'system' }
    ),
    `${keyDigest(`${principal ?? ''}\u0000${idempotencyKey}`)}.json`
  );
  return assertSafeRepositoryPath(pathResolver.rootResolve(relative), { allowMissingLeaf: true });
}

function isReservation(value: unknown): value is DelegationReservation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<DelegationReservation>;
  return (
    record.kind === 'delegation_reservation' &&
    typeof record.idempotency_key === 'string' &&
    typeof record.payload_hash === 'string' &&
    (record.status === 'in_flight' ||
      record.status === 'terminal' ||
      record.status === 'released') &&
    typeof record.owner_pid === 'number' &&
    typeof record.started_at === 'string'
  );
}

class DelegationReservationUnreadableError extends Error {
  readonly executionStarted = false;
  constructor(filePath: string) {
    super(
      `[DELEGATION_RESERVATION_UNREADABLE] reservation exists but cannot be read — refusing to execute | inspect or remove ${filePath} after confirming the earlier execution's outcome | evidence: ${filePath}`
    );
  }
}

/** Absent → null. Present but unreadable → throws: never treated as "never started". */
function readReservation(filePath: string): DelegationReservation | null {
  if (!safeExistsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = readJson<unknown>(filePath);
  } catch {
    throw new DelegationReservationUnreadableError(filePath);
  }
  if (!isReservation(parsed)) throw new DelegationReservationUnreadableError(filePath);
  return parsed;
}

function writeReservation(filePath: string, record: DelegationReservation): void {
  writeDelegationHostLeaf(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

function lockId(filePath: string): string {
  return `delegation-idempotency:${keyDigest(filePath)}`;
}

/** Read the stored reservation for a key in the current tenant/principal scope. */
export function loadDelegationReservation(idempotencyKey: string): DelegationReservation | null {
  const record = readReservation(
    reservationPath(idempotencyKey, scopeTenantSlug(), scopePrincipal())
  );
  return record && record.idempotency_key === idempotencyKey ? record : null;
}

interface InFlightEntry {
  payloadHash: string;
  promise: Promise<string>;
}

const inFlight = new Map<string, InFlightEntry>();
/**
 * Owner failures that released the key (proven pre-start). A joiner that sees
 * one did not get an execution to join: it competes for the key afresh
 * instead of inheriting the owner's own failure (e.g. the owner's abort).
 */
const releasedFailures = new WeakSet<object>();
/** Keys already governed by an enclosing idempotent layer in this async context. */
const activeKeys = new AsyncLocalStorage<ReadonlySet<string>>();

function replay(record: DelegationReservation): string {
  const result =
    record.result ??
    buildFailedDelegationResult(
      new Error('[DELEGATION_REPLAY] terminal reservation carries no stored result'),
      {}
    );
  if (result.status === 'completed') return result.output_text;
  throw new DelegationTerminalError(result, { executionStarted: true });
}

function interruptedResult(reason: string): DelegationResult {
  return buildFailedDelegationResult(
    Object.assign(
      new Error(
        `[DELEGATION_INTERRUPTED] ${reason}; execution was assumed started, outcome unknown and side effects may exist — not re-running`
      ),
      { executionStarted: true }
    )
  );
}

/** Same-host liveness probes spawn `ps`; reuse a verdict for one short poll window. */
const LIVENESS_CACHE_MS = 2000;
const livenessCache = new Map<string, { alive: boolean; at: number }>();

function recordedProcessAliveCached(pid: number, startMarker: string | undefined): boolean {
  const cacheKey = `${pid}\u0000${startMarker ?? ''}`;
  const cached = livenessCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LIVENESS_CACHE_MS) return cached.alive;
  const alive = isRecordedProcessAlive(pid, startMarker);
  livenessCache.set(cacheKey, { alive, at: Date.now() });
  return alive;
}

/**
 * Why an in-flight record's owner is gone, or undefined while it may still run.
 * May spawn a process probe: call it OUTSIDE the reservation lock.
 *
 * Follow-up (not handled): heartbeat expiry compares another host's
 * `heartbeat_at` with the local clock, so clock skew larger than the lease
 * can misjudge a live remote owner as gone (safe direction: interrupted, no
 * re-run).
 */
function ownerGoneReason(record: DelegationReservation): string | undefined {
  if (record.owner_instance === OWNER_INSTANCE) {
    // This module instance owns it but no longer tracks it in-process.
    return 'the owning execution was lost in this process';
  }
  if (record.owner_host === currentHost()) {
    return recordedProcessAliveCached(record.owner_pid, record.owner_start_marker)
      ? undefined
      : 'the owning process exited';
  }
  // Another host: local pid probes say nothing; only the heartbeat lease does.
  const heartbeat = Date.parse(record.heartbeat_at);
  return Number.isFinite(heartbeat) && Date.now() - heartbeat <= timing.leaseMs
    ? undefined
    : `the owner on ${record.owner_host} stopped heartbeating`;
}

type ReserveOutcome =
  | { kind: 'reserved'; record: DelegationReservation }
  | { kind: 'replay'; record: DelegationReservation }
  | { kind: 'wait' };

/** Same in-flight record (owner and reservation), ignoring heartbeat refreshes. */
function sameInFlightRecord(a: DelegationReservation, b: DelegationReservation): boolean {
  return (
    a.status === 'in_flight' &&
    b.status === 'in_flight' &&
    a.owner_instance === b.owner_instance &&
    a.reserved_at === b.reserved_at
  );
}

function reserve(
  filePath: string,
  idempotencyKey: string,
  payloadHash: string,
  principal: string | undefined
): ReserveOutcome {
  // Probe the owner's liveness before taking the lock: a `ps` spawn must
  // never run while other callers (and the owner's heartbeat) wait on it.
  const peeked = readReservation(filePath);
  const peekedGone =
    peeked?.status === 'in_flight' && peeked.payload_hash === payloadHash
      ? ownerGoneReason(peeked)
      : undefined;
  return withLockSync(lockId(filePath), () => {
    const existing = readReservation(filePath);
    if (existing && existing.status !== 'released') {
      if (existing.payload_hash !== payloadHash) {
        throw new DelegationIdempotencyConflictError(
          idempotencyKey,
          existing.payload_hash,
          payloadHash
        );
      }
      if (existing.status === 'terminal') return { kind: 'replay', record: existing };
      // Only act on the verdict probed for this very record; if it changed
      // between the peek and the lock, poll again rather than probe here.
      const gone = peeked && sameInFlightRecord(peeked, existing) ? peekedGone : undefined;
      if (!gone) return { kind: 'wait' };
      // In-flight is assumed started: settle as interrupted, never adopt.
      const settled: DelegationReservation = {
        ...existing,
        status: 'terminal',
        completed_at: nowIso(),
        result: interruptedResult(gone),
      };
      writeReservation(filePath, settled);
      return { kind: 'replay', record: settled };
    }
    // Absent, or released after a proven pre-start failure: reserve, with the
    // start assumed and persisted before execute() is ever called.
    const now = nowIso();
    const startMarker = selfStartMarker();
    const record: DelegationReservation = {
      kind: 'delegation_reservation',
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      status: 'in_flight',
      reserved_at: now,
      owner_pid: process.pid,
      owner_instance: OWNER_INSTANCE,
      owner_host: currentHost(),
      ...(startMarker ? { owner_start_marker: startMarker } : {}),
      heartbeat_at: now,
      ...(principal ? { principal } : {}),
      started_at: now,
    };
    writeReservation(filePath, record);
    return { kind: 'reserved', record };
  });
}

const UPDATE_ATTEMPTS = 3;
/** A heartbeat is best-effort: one attempt with a short lock wait, never retried. */
const HEARTBEAT_LOCK_TIMEOUT_MS = 1000;

type UpdateKind = 'heartbeat' | 'settle';

/**
 * Owner-side transition of its own in-flight record. Settling is retried; on
 * persistent failure the record stays `in_flight` with an assumed start,
 * which every later reader settles as interrupted — fail closed, never a
 * re-run. A heartbeat is a single short attempt.
 */
function update(
  filePath: string,
  kind: UpdateKind,
  mutate: (record: DelegationReservation) => DelegationReservation
): boolean {
  const attempts = kind === 'heartbeat' ? 1 : UPDATE_ATTEMPTS;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      let settledElsewhere: DelegationReservation | null | undefined;
      const written = withLockSync(
        lockId(filePath),
        () => {
          const current = readReservation(filePath);
          if (
            !current ||
            current.owner_instance !== OWNER_INSTANCE ||
            current.status !== 'in_flight'
          ) {
            settledElsewhere = current;
            return false;
          }
          writeReservation(filePath, mutate(current));
          return true;
        },
        kind === 'heartbeat' ? HEARTBEAT_LOCK_TIMEOUT_MS : undefined
      );
      if (!written && kind === 'settle') {
        logger.error(
          `[delegation-idempotency] owner outcome not recorded — the reservation was already settled by another caller (${
            settledElsewhere ? `status=${settledElsewhere.status}` : 'record missing'
          }), so replays of this key may disagree with this call's result | inspect the reservation and the delegation trace before reusing the key | evidence: ${filePath}`
        );
      }
      return written;
    } catch (error) {
      lastError = error;
    }
  }
  if (kind === 'heartbeat') {
    logger.warn(
      `[delegation-idempotency] heartbeat skipped — reservation lock busy or unwritable | the next heartbeat retries | evidence: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    );
    return false;
  }
  logger.error(
    `[delegation-idempotency] reservation transition failed after ${UPDATE_ATTEMPTS} attempts — the key stays in-flight and will replay as interrupted, never re-run | check runtime store permissions, then settle the record by hand | evidence: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`
  );
  return false;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error('aborted');
}

/** The abort reason as an object that can carry a start marker. */
function abortReasonError(signal: AbortSignal): Error {
  const reason = abortReason(signal);
  return reason instanceof Error
    ? reason
    : new Error(`[DELEGATION_CANCELLED] ${String(reason ?? 'aborted')}`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A joiner stops waiting on its own signal; the joined execution continues. */
function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

function waitTimeout(idempotencyKey: string): DelegationTerminalError {
  return new DelegationTerminalError(
    buildFailedDelegationResult(
      Object.assign(
        new Error(
          `[DELEGATION_IDEMPOTENCY_WAIT_TIMEOUT] key "${idempotencyKey}" is still in flight on its owner after ${timing.maxWaitMs}ms timed out waiting — not re-running`
        ),
        { executionStarted: true }
      )
    ),
    { executionStarted: true }
  );
}

export interface IdempotentDelegationInput {
  instruction: string;
  context?: string;
  options?: { idempotencyKey?: string; signal?: AbortSignal } & object;
  /** The non-idempotent delegation to run at most once per key. */
  execute: () => Promise<string>;
}

/**
 * Run `execute` at most once per `options.idempotencyKey`. Without a key this
 * is a transparent pass-through. Nested idempotent layers for the same key
 * (e.g. a role-aware wrapper around a failover chain) pass through as well.
 *
 * With a key, the returned text is the secret-masked stored text — the same
 * value every joiner and every later replay receives.
 */
export async function runIdempotentDelegation(input: IdempotentDelegationInput): Promise<string> {
  const idempotencyKey = input.options?.idempotencyKey?.trim();
  if (!idempotencyKey || activeKeys.getStore()?.has(idempotencyKey)) return input.execute();

  const payloadHash = computeDelegationPayloadHash(input);
  const tenantSlug = scopeTenantSlug();
  const principal = scopePrincipal();
  const filePath = reservationPath(idempotencyKey, tenantSlug, principal);
  const mapKey = `${tenantSlug ?? ''}\u0000${principal ?? ''}\u0000${idempotencyKey}`;
  const signal = input.options?.signal;
  const waitDeadline = Date.now() + timing.maxWaitMs;

  for (;;) {
    const joined = inFlight.get(mapKey);
    if (joined) {
      if (joined.payloadHash !== payloadHash) {
        throw new DelegationIdempotencyConflictError(
          idempotencyKey,
          joined.payloadHash,
          payloadHash
        );
      }
      try {
        return await raceSignal(joined.promise, signal);
      } catch (error) {
        if (!(error && typeof error === 'object' && releasedFailures.has(error))) throw error;
        // Nothing ran: drop the settled entry and compete for the key ourselves.
        if (inFlight.get(mapKey) === joined) inFlight.delete(mapKey);
        continue;
      }
    }
    const outcome = reserve(filePath, idempotencyKey, payloadHash, principal);
    if (outcome.kind === 'replay') return replay(outcome.record);
    if (outcome.kind === 'wait') {
      if (Date.now() >= waitDeadline) throw waitTimeout(idempotencyKey);
      await sleep(timing.pollMs, signal);
      continue;
    }
    const promise = executeReserved(filePath, idempotencyKey, input);
    inFlight.set(mapKey, { payloadHash, promise });
    try {
      return await promise;
    } finally {
      if (inFlight.get(mapKey)?.promise === promise) inFlight.delete(mapKey);
    }
  }
}

async function executeReserved(
  filePath: string,
  idempotencyKey: string,
  input: IdempotentDelegationInput
): Promise<string> {
  const keys = new Set(activeKeys.getStore() ?? []);
  keys.add(idempotencyKey);
  const heartbeat = setInterval(() => {
    update(filePath, 'heartbeat', (record) => ({ ...record, heartbeat_at: nowIso() }));
  }, timing.heartbeatMs);
  heartbeat.unref?.();
  const release = (error: unknown): never => {
    update(filePath, 'settle', (record) => ({ ...record, status: 'released' }));
    if (error && typeof error === 'object') releasedFailures.add(error);
    throw error;
  };
  try {
    // The owner's signal fired before dispatch: nothing ran, so release the
    // key instead of persisting a terminal cancellation every replay inherits.
    const signal = input.options?.signal;
    if (signal?.aborted) {
      release(markErrorExecutionStarted(abortReasonError(signal), false));
    }
    return await activeKeys.run(keys, () =>
      runWithDelegationExecutionTracker(async (tracker) => {
        try {
          const value = await input.execute();
          const result = buildCompletedDelegationResult(value, tracker.metadata);
          update(filePath, 'settle', (record) => ({
            ...record,
            status: 'terminal',
            completed_at: nowIso(),
            result,
          }));
          return result.output_text;
        } catch (error) {
          // Release only on a proof that nothing ran; everything else replays.
          const provenNotStarted =
            !tracker.started && delegationExecutionStartedFromError(error) === false;
          if (provenNotStarted) release(error);
          update(filePath, 'settle', (record) => ({
            ...record,
            status: 'terminal',
            completed_at: nowIso(),
            result: buildFailedDelegationResult(markErrorExecutionStarted(error), tracker.metadata),
          }));
          throw error;
        }
      })
    );
  } finally {
    clearInterval(heartbeat);
  }
}

/** Test seam: forget in-process in-flight joins (the durable store is untouched). */
export function resetDelegationIdempotencyForTests(): void {
  inFlight.clear();
  livenessCache.clear();
  timing = { ...DEFAULT_TIMING };
  hostOverride = undefined;
}

/** Test seam: shrink waits/leases and fake the host name. */
export function configureDelegationIdempotencyForTests(
  overrides: Partial<IdempotencyTiming> & { host?: string }
): void {
  const { host, ...rest } = overrides;
  timing = { ...timing, ...rest };
  if (host !== undefined) hostOverride = host;
}

/** Test seam: the identity stamped on reservations owned by this module instance. */
export function delegationIdempotencyOwnerForTests(): { instance: string; host: string } {
  return { instance: OWNER_INSTANCE, host: currentHost() };
}

/** Test seam: where the reservation for `idempotencyKey` lives in the current scope. */
export function delegationReservationPathForTests(idempotencyKey: string): string {
  return reservationPath(idempotencyKey, scopeTenantSlug(), scopePrincipal());
}
