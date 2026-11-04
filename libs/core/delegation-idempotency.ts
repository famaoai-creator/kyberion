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
 * - the reservation is released only when the failure provably happened
 *   before execution started — an unknown start state is treated as started,
 *   because side effects may exist.
 *
 * Reservations are durable state under
 * `active/shared/runtime/delegation-idempotency/` (tenant scopes nest under
 * `tenants/<slug>/` via `physicalScopedPath`), written through secure-io.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { logger } from './core.js';
import { currentResourceAccessScope } from './foundation/resource-access-scope.js';
import { withLockSync } from './foundation/lock-utils.js';
import { nowIso } from './foundation/time.js';
import { resolvePolicyIdentityContext } from './identity-context-bridge.js';
import { pathResolver } from './path-resolver.js';
import { physicalScopedPath } from './physical-namespace.js';
import { assertSafeRepositoryPath, safeExistsSync } from './secure-io.js';
import { readJson } from './foundation/json.js';
import { isPidAlive } from './workforce/workspace-process-identity.js';
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

/** Reservation store root, relative to `active/shared/` (runtime state floor). */
export const DELEGATION_IDEMPOTENCY_STORE_SUBPATH = 'runtime/delegation-idempotency';

const POLL_INTERVAL_MS = 250;
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

export interface DelegationReservation {
  kind: 'delegation_reservation';
  idempotency_key: string;
  payload_hash: string;
  status: 'in_flight' | 'terminal' | 'released';
  reserved_at: string;
  owner_pid: number;
  owner_instance: string;
  started_at?: string;
  completed_at?: string;
  result?: DelegationResult;
}

function scopeTenantSlug(): string | undefined {
  return currentResourceAccessScope()?.tenantSlug ?? resolvePolicyIdentityContext().tenantSlug;
}

function keyDigest(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 40);
}

function reservationPath(idempotencyKey: string, tenantSlug: string | undefined): string {
  const relative = physicalScopedPath(
    DELEGATION_IDEMPOTENCY_STORE_SUBPATH,
    tenantSlug ? { tenant_slug: tenantSlug } : {},
    `${keyDigest(idempotencyKey)}.json`
  );
  return assertSafeRepositoryPath(pathResolver.shared(relative), { allowMissingLeaf: true });
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
    typeof record.owner_pid === 'number'
  );
}

function readReservation(filePath: string): DelegationReservation | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    const parsed = readJson<unknown>(filePath);
    if (isReservation(parsed)) return parsed;
  } catch {
    // fall through: an unreadable reservation is reported and treated as absent
  }
  logger.warn(
    `[delegation-idempotency] reservation unreadable — treating as absent | inspect or remove the file | evidence: ${filePath}`
  );
  return null;
}

function writeReservation(filePath: string, record: DelegationReservation): void {
  writeDelegationHostLeaf(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

/** Read the stored reservation for a key in the current tenant scope. */
export function loadDelegationReservation(idempotencyKey: string): DelegationReservation | null {
  const record = readReservation(reservationPath(idempotencyKey, scopeTenantSlug()));
  return record && record.idempotency_key === idempotencyKey ? record : null;
}

interface InFlightEntry {
  payloadHash: string;
  promise: Promise<string>;
}

const inFlight = new Map<string, InFlightEntry>();
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

function interruptedResult(): DelegationResult {
  return buildFailedDelegationResult(
    Object.assign(
      new Error(
        '[DELEGATION_INTERRUPTED] the owning process exited after execution started; outcome unknown and side effects may exist — not re-running'
      ),
      { executionStarted: true }
    )
  );
}

type ReserveOutcome =
  | { kind: 'reserved'; record: DelegationReservation }
  | { kind: 'replay'; record: DelegationReservation }
  | { kind: 'wait' };

function reserve(filePath: string, idempotencyKey: string, payloadHash: string): ReserveOutcome {
  return withLockSync(`delegation-idempotency:${keyDigest(filePath)}`, () => {
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
      // An in-process execution is joined through `inFlight` before we get
      // here, so an in-flight record owned by this pid is stale (a recycled
      // pid, or a dropped in-process entry). Only another live pid is waited on.
      const ownerAlive = existing.owner_pid !== process.pid && isPidAlive(existing.owner_pid);
      if (ownerAlive) return { kind: 'wait' };
      if (existing.started_at) {
        // The owner died mid-execution: record the unknown outcome, never re-run.
        const settled: DelegationReservation = {
          ...existing,
          status: 'terminal',
          completed_at: nowIso(),
          result: interruptedResult(),
        };
        writeReservation(filePath, settled);
        return { kind: 'replay', record: settled };
      }
      // A dead owner that never started: adopt the reservation below.
    }
    const record: DelegationReservation = {
      kind: 'delegation_reservation',
      idempotency_key: idempotencyKey,
      payload_hash: payloadHash,
      status: 'in_flight',
      reserved_at: nowIso(),
      owner_pid: process.pid,
      owner_instance: OWNER_INSTANCE,
    };
    writeReservation(filePath, record);
    return { kind: 'reserved', record };
  });
}

function update(
  filePath: string,
  mutate: (record: DelegationReservation) => DelegationReservation
): void {
  try {
    withLockSync(`delegation-idempotency:${keyDigest(filePath)}`, () => {
      const current = readReservation(filePath);
      if (!current || current.owner_instance !== OWNER_INSTANCE) return;
      writeReservation(filePath, mutate(current));
    });
  } catch (error) {
    logger.warn(
      `[delegation-idempotency] reservation update failed — a replay may not see this outcome | check runtime store permissions | evidence: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
 */
export async function runIdempotentDelegation(input: IdempotentDelegationInput): Promise<string> {
  const idempotencyKey = input.options?.idempotencyKey?.trim();
  if (!idempotencyKey || activeKeys.getStore()?.has(idempotencyKey)) return input.execute();

  const payloadHash = computeDelegationPayloadHash(input);
  const tenantSlug = scopeTenantSlug();
  const filePath = reservationPath(idempotencyKey, tenantSlug);
  const mapKey = `${tenantSlug ?? ''}\u0000${idempotencyKey}`;
  const signal = input.options?.signal;

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
      return joined.promise;
    }
    const outcome = reserve(filePath, idempotencyKey, payloadHash);
    if (outcome.kind === 'replay') return replay(outcome.record);
    if (outcome.kind === 'wait') {
      await sleep(POLL_INTERVAL_MS, signal);
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
  let startedPersisted = false;
  return activeKeys.run(keys, () =>
    runWithDelegationExecutionTracker(
      async (tracker) => {
        try {
          const value = await input.execute();
          update(filePath, (record) => ({
            ...record,
            status: 'terminal',
            ...(record.started_at ? {} : { started_at: nowIso() }),
            completed_at: nowIso(),
            result: buildCompletedDelegationResult(value, tracker.metadata),
          }));
          return value;
        } catch (error) {
          const started = tracker.started || delegationExecutionStartedFromError(error) !== false;
          if (!started) {
            // Provably pre-start (auth, missing binary, …): free the key so a
            // retry with the same payload may execute.
            update(filePath, (record) => ({ ...record, status: 'released' }));
          } else {
            update(filePath, (record) => ({
              ...record,
              status: 'terminal',
              ...(record.started_at ? {} : { started_at: nowIso() }),
              completed_at: nowIso(),
              result: buildFailedDelegationResult(
                markErrorExecutionStarted(error),
                tracker.metadata
              ),
            }));
          }
          throw error;
        }
      },
      () => {
        if (startedPersisted) return;
        startedPersisted = true;
        update(filePath, (record) => ({ ...record, started_at: nowIso() }));
      }
    )
  );
}

/** Test seam: forget in-process in-flight joins (the durable store is untouched). */
export function resetDelegationIdempotencyForTests(): void {
  inFlight.clear();
}
