/**
 * QM-02: one governed path for cron, process-watch, and surface wake
 * triggers.
 *
 * A trigger is accepted once, checked against the authority snapshot captured
 * at creation time, and recorded before delivery. A repeated idempotency key
 * therefore returns the original receipt without invoking the delivery
 * callback again.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { clamp, isRecord } from './foundation/text.js';
import {
  assertSafeRepositoryPath,
  safeAppendFileSync,
  safeCopyFileSync,
  safeExistsSync,
  safeMkdir,
  safeLstat,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import { readJsonLinesBackward, streamJsonLines } from './jsonl-read.js';
import { pathResolver } from './path-resolver.js';
import { loadAuthorityRoleIndex } from './organization/authority-role-registry.js';
import { auditChain } from './governance/audit-chain.js';
import { resolveAssumedRole, resolveRole } from './authority.js';
import { createLogger } from './logger.js';
import { releaseLock, withLock } from './foundation/lock-utils.js';
import {
  armWatch,
  type ManagedProcessWatchHandle,
  type ManagedProcessWatchOptions,
} from './managed-process.js';
import { withTriggerCorrelation } from './trigger-correlation.js';

const logger = createLogger('trigger-runner');

export type TriggerSource = 'cron' | 'watch' | 'wake';

export interface TriggerAuthoritySnapshot {
  authority_role: string;
  /** Monotonic authority level captured at trigger creation time. */
  level: number;
  tenant_slug?: string;
}

export interface TriggerRequest {
  idempotencyKey: string;
  source: TriggerSource;
  createdBy: TriggerAuthoritySnapshot;
  requestedAuthority?: TriggerAuthoritySnapshot;
  payload?: Record<string, unknown>;
}

export interface TriggerDeliveryInput extends TriggerRequest {
  deliveryId: string;
}

export interface TriggerReceipt {
  idempotencyKey: string;
  source: TriggerSource;
  status: 'delivered' | 'failed' | 'rejected' | 'duplicate';
  deliveryId?: string;
  reason?: string;
  recordedAt: string;
}

interface TriggerRecord extends TriggerReceipt {
  createdBy: TriggerAuthoritySnapshot;
  requestedAuthority?: TriggerAuthoritySnapshot;
  claimId?: string;
  claimOwnerPid?: number;
  claimExpiresAt?: string;
  attempt?: number;
}

export interface TriggerRunnerOptions {
  storePath?: string;
  now?: () => Date;
  /** Claim lease; clamped to [1s, TRIGGER_STORE_MAX_CLAIM_LEASE_MS]. */
  claimLeaseMs?: number;
  /** Write-time retention threshold (never an append cap). */
  maxStoreBytes?: number;
  /** Range-read chunk size for journal scans (test seam; default 256KB). */
  readChunkBytes?: number;
  /** Trusted resolver used by governed callers and deterministic tests. */
  authorityResolver?: (authority: TriggerAuthoritySnapshot) => TriggerAuthoritySnapshot;
}

const DEFAULT_STORE_PATH = 'active/shared/runtime/trigger-deliveries.jsonl';
const DEFAULT_CLAIM_LEASE_MS = 15 * 60 * 1000;
/**
 * Write-time retention threshold of the delivery journal: past it, an append
 * first rewrites the journal down to its dedupe window. It is not a cap — an
 * append never fails because of the journal's size (MSN-STORE-BOUNDS-20261101).
 */
export const TRIGGER_STORE_DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
/**
 * Growth warning level (ops-health trigger-store-growth). Retention keeps a
 * healthy journal under the threshold, so twice the threshold means receipts
 * inside the dedupe window alone keep it from shrinking. Warn only.
 */
export const TRIGGER_STORE_GROWTH_WARN_BYTES = 2 * TRIGGER_STORE_DEFAULT_MAX_BYTES;
const DEFAULT_MAX_STORE_BYTES = TRIGGER_STORE_DEFAULT_MAX_BYTES;
/**
 * Longest claim lease a runner grants. Bounding it bounds how far back a
 * non-abandoned claim can have been recorded (see {@link readCutoffMs}).
 */
export const TRIGGER_STORE_MAX_CLAIM_LEASE_MS = 24 * 60 * 60 * 1000;
/**
 * Dedupe window. Finished receipts younger than this are always kept (stable
 * keys such as mission admission, continuous owner, reflex or daemon-recovery
 * episodes must not re-deliver inside it); older ones are dropped at rotation.
 * Pending claims are dropped once their lease expired longer ago than this.
 */
const DEDUPE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Trigger authority is derived from canonical role scope classes. */
const TRIGGER_SCOPE_LEVELS: Readonly<Record<string, number>> = Object.freeze({
  communication_surface: 20,
  project_delivery: 30,
  quality_validation: 30,
  coordination_runtime: 40,
  operations_runtime: 40,
  mission_state: 50,
  // Audit is orthogonal to trigger execution power and must not elevate it.
  audit: 20,
  knowledge_core: 70,
  security_validation: 70,
  codebase_core: 80,
  design_system: 30,
  personal_identity: 90,
});

function normalizeAuthority(authority: TriggerAuthoritySnapshot): TriggerAuthoritySnapshot {
  const role = String(authority?.authority_role || '').trim();
  const level = Number(authority?.level);
  if (!role) throw new Error('Trigger authority_role is required.');
  if (!Number.isFinite(level) || level < 0) {
    throw new Error('Trigger authority level must be a finite non-negative number.');
  }
  return {
    authority_role: role,
    level,
    ...(authority.tenant_slug?.trim() ? { tenant_slug: authority.tenant_slug.trim() } : {}),
  };
}

type CanonicalAuthorityRole = { role?: string; scope_classes?: string[] };

function readCanonicalAuthorityRole(role: string): CanonicalAuthorityRole | null {
  try {
    const record = loadAuthorityRoleIndex()[role];
    if (record) return { role, ...record };
  } catch {
    // Fail closed below when the role directory and snapshot are invalid.
  }
  return null;
}

function governedTriggerLevel(role: string): number | undefined {
  const record = readCanonicalAuthorityRole(role);
  if (!record) return undefined;
  const levels = (record.scope_classes || [])
    .map((scope) => TRIGGER_SCOPE_LEVELS[scope])
    .filter((level): level is number => level !== undefined);
  return levels.length > 0 ? Math.max(...levels) : undefined;
}

function assertCanonicalAuthorityRole(role: string): void {
  if (!readCanonicalAuthorityRole(role)) {
    throw new Error(`[POLICY_VIOLATION] Unknown trigger authority role: ${role}`);
  }
}

/**
 * The execution role a trigger is bound to: an in-process
 * withExecutionContext* assumption first (RA-01, scoped per async context),
 * then MISSION_ROLE, then the general role resolution.
 */
function resolveActiveTriggerRole(): string | undefined {
  return resolveAssumedRole() || getRegisteredEnvText('MISSION_ROLE')?.trim() || resolveRole();
}

function resolveGovernedAuthority(authority: TriggerAuthoritySnapshot): TriggerAuthoritySnapshot {
  const normalized = normalizeAuthority(authority);
  assertCanonicalAuthorityRole(normalized.authority_role);
  const governedLevel = governedTriggerLevel(normalized.authority_role);
  if (governedLevel === undefined) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority role has no governed level: ${normalized.authority_role}`
    );
  }
  if (normalized.level !== governedLevel) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority level does not match role registry: role=${normalized.authority_role} expected=${governedLevel} received=${normalized.level}`
    );
  }
  const activeRole = resolveActiveTriggerRole();
  if (activeRole && activeRole !== normalized.authority_role) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority is not bound to the active execution role: active=${activeRole} requested=${normalized.authority_role}`
    );
  }
  if (!activeRole) {
    throw new Error('[AUTHORITY_UNBOUND] Trigger execution requires an active MISSION_ROLE.');
  }
  return normalized;
}

/**
 * EV-02: the authority snapshot of the currently active execution role.
 *
 * Callers that run under a varying role (a provider session booted by whichever
 * role asked for it) cannot hardcode `{authority_role, level}` — and a hardcoded
 * level that drifts from the role registry is rejected outright. Derive both
 * from the registry instead, so the snapshot is true by construction.
 *
 * Throws when no role is bound, because an unattributable trigger must not run.
 */
export function resolveCurrentTriggerAuthority(tenantSlug?: string): TriggerAuthoritySnapshot {
  const activeRole = resolveActiveTriggerRole();
  if (!activeRole) {
    throw new Error('[AUTHORITY_UNBOUND] Trigger execution requires an active MISSION_ROLE.');
  }
  assertCanonicalAuthorityRole(activeRole);
  const level = governedTriggerLevel(activeRole);
  if (level === undefined) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority role has no governed level: ${activeRole}`
    );
  }
  // The `as` cast is gone deliberately: it was hiding a misspelled property
  // (`tenantSlug` instead of the declared `tenant_slug`), so the tenant scope
  // silently never reached the snapshot. Let the object be checked structurally.
  return {
    authority_role: activeRole,
    level,
    ...(tenantSlug?.trim() ? { tenant_slug: tenantSlug.trim() } : {}),
  };
}

/** Reject a trigger whose requested authority exceeds its creator snapshot. */
export function assertNoEscalation(
  createdBy: TriggerAuthoritySnapshot,
  requestedAuthority: TriggerAuthoritySnapshot = createdBy
): void {
  const creator = normalizeAuthority(createdBy);
  const requested = normalizeAuthority(requestedAuthority);
  for (const authority of [creator, requested]) {
    assertCanonicalAuthorityRole(authority.authority_role);
    const governedLevel = governedTriggerLevel(authority.authority_role);
    if (governedLevel === undefined || authority.level !== governedLevel) {
      throw new Error(
        `[POLICY_VIOLATION] Trigger authority level does not match role registry: role=${authority.authority_role} expected=${governedLevel ?? 'registered level'} received=${authority.level}`
      );
    }
  }
  if (requested.level > creator.level) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger authority escalation denied: creator=${creator.authority_role}:${creator.level} requested=${requested.authority_role}:${requested.level}`
    );
  }
  if (
    creator.tenant_slug &&
    requested.tenant_slug &&
    creator.tenant_slug !== requested.tenant_slug
  ) {
    throw new Error(
      `[POLICY_VIOLATION] Trigger tenant scope escalation denied: creator=${creator.tenant_slug} requested=${requested.tenant_slug}`
    );
  }
}

function persistedRequiredString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function persistedAuthority(value: unknown): TriggerAuthoritySnapshot | null {
  if (!isRecord(value)) return null;
  const authorityRole = persistedRequiredString(value.authority_role);
  const level = value.level;
  if (authorityRole === null || typeof level !== 'number' || !Number.isFinite(level) || level < 0) {
    return null;
  }
  if (value.tenant_slug !== undefined && typeof value.tenant_slug !== 'string') return null;
  return {
    authority_role: authorityRole,
    level,
    ...(typeof value.tenant_slug === 'string' && value.tenant_slug.trim()
      ? { tenant_slug: value.tenant_slug }
      : {}),
  };
}

/** Normalize one persisted receipt before it participates in idempotency state. */
export function normalizeTriggerRecord(value: unknown): TriggerRecord | null {
  if (!isRecord(value)) return null;
  const idempotencyKey = persistedRequiredString(value.idempotencyKey);
  const recordedAt = persistedRequiredString(value.recordedAt);
  const source = value.source;
  const status = value.status;
  const createdBy = persistedAuthority(value.createdBy);
  if (
    idempotencyKey === null ||
    recordedAt === null ||
    !Number.isFinite(Date.parse(recordedAt)) ||
    (source !== 'cron' && source !== 'watch' && source !== 'wake') ||
    (status !== 'delivered' &&
      status !== 'failed' &&
      status !== 'rejected' &&
      status !== 'duplicate') ||
    createdBy === null
  ) {
    return null;
  }

  const requestedAuthority =
    value.requestedAuthority === undefined
      ? undefined
      : persistedAuthority(value.requestedAuthority);
  if (value.requestedAuthority !== undefined && requestedAuthority === null) return null;

  for (const field of ['deliveryId', 'reason', 'claimId', 'claimExpiresAt'] as const) {
    if (value[field] !== undefined && typeof value[field] !== 'string') return null;
  }
  const claimExpiresAt = value.claimExpiresAt;
  if (typeof claimExpiresAt === 'string' && !Number.isFinite(Date.parse(claimExpiresAt))) {
    return null;
  }
  for (const field of ['claimOwnerPid', 'attempt'] as const) {
    if (
      value[field] !== undefined &&
      (typeof value[field] !== 'number' || !Number.isInteger(value[field]) || value[field] < 0)
    ) {
      return null;
    }
  }

  return {
    idempotencyKey,
    source,
    status,
    createdBy,
    ...(requestedAuthority ? { requestedAuthority } : {}),
    ...(typeof value.deliveryId === 'string' ? { deliveryId: value.deliveryId } : {}),
    ...(typeof value.reason === 'string' ? { reason: value.reason } : {}),
    recordedAt,
    ...(typeof value.claimId === 'string' ? { claimId: value.claimId } : {}),
    ...(typeof value.claimOwnerPid === 'number' ? { claimOwnerPid: value.claimOwnerPid } : {}),
    ...(typeof claimExpiresAt === 'string' ? { claimExpiresAt } : {}),
    ...(typeof value.attempt === 'number' ? { attempt: value.attempt } : {}),
  };
}

/**
 * Oldest `recordedAt` a dedupe read must reach. Retention keeps finished
 * receipts younger than {@link DEDUPE_RETENTION_MS} and pending claims whose
 * lease expired less than that long ago; a claim records `recordedAt` one lease
 * before `claimExpiresAt`, and leases are capped at
 * {@link TRIGGER_STORE_MAX_CLAIM_LEASE_MS}, so every record retention keeps was
 * recorded after this cutoff.
 */
function readCutoffMs(now: Date): number {
  return now.getTime() - DEDUPE_RETENTION_MS - TRIGGER_STORE_MAX_CLAIM_LEASE_MS;
}

function journalReadOptions(chunkBytes: number | undefined) {
  return {
    chunkBytes,
    // A torn or malformed line must not hide the rest of the journal.
    onMalformed: 'skip' as const,
    map: (value: unknown) => normalizeTriggerRecord(value),
  };
}

/**
 * Newest-first scan of the dedupe window. Size-independent: it range-reads
 * backwards and stops at the first finished receipt recorded before
 * {@link readCutoffMs} (the journal is appended in time order). Pending claims
 * never stop the scan — one recorded before the cutoff (a legacy long lease)
 * is still yielded if the scan reaches it.
 */
function* scanDedupeWindowBackward(
  storePath: string,
  now: Date,
  chunkBytes?: number
): Generator<TriggerRecord> {
  if (!safeExistsSync(storePath)) return;
  assertTriggerStoreFile(storePath);
  const cutoff = readCutoffMs(now);
  for (const record of readJsonLinesBackward<TriggerRecord | null>(
    storePath,
    journalReadOptions(chunkBytes)
  )) {
    if (!record) continue;
    if (!isInFlight(record) && recordTimeMs(record) < cutoff) return;
    yield record;
  }
}

/** Every record of the dedupe window, oldest first. */
function readRecords(storePath: string, now: Date, chunkBytes?: number): TriggerRecord[] {
  return [...scanDedupeWindowBackward(storePath, now, chunkBytes)].reverse();
}

/** Latest record for one key inside the dedupe window; stops as soon as it is found. */
function findLatestRecord(
  storePath: string,
  idempotencyKey: string,
  now: Date,
  chunkBytes?: number
): TriggerRecord | undefined {
  for (const record of scanDedupeWindowBackward(storePath, now, chunkBytes)) {
    if (record.idempotencyKey === idempotencyKey) return record;
  }
  return undefined;
}

/**
 * Latest record per key that retention keeps (finished receipts younger than
 * the dedupe window, pending claims not yet abandoned), in order of last
 * appearance. Streams the whole journal forward in constant read memory, so
 * the rewrite is right regardless of size or record order; memory is bounded
 * by the keys inside the window. Also returns the total record count.
 */
function collectDedupeWindow(
  storePath: string,
  now: Date,
  chunkBytes?: number
): { records: number; latest: TriggerRecord[] } {
  if (!safeExistsSync(storePath)) return { records: 0, latest: [] };
  assertTriggerStoreFile(storePath);
  const cutoff = now.getTime() - DEDUPE_RETENTION_MS;
  const latest = new Map<string, TriggerRecord>();
  let records = 0;
  for (const record of streamJsonLines<TriggerRecord | null>(
    storePath,
    journalReadOptions(chunkBytes)
  )) {
    if (!record) continue;
    records++;
    latest.delete(record.idempotencyKey);
    const kept = isInFlight(record)
      ? !isAbandonedClaim(record, cutoff)
      : recordTimeMs(record) >= cutoff;
    if (kept) latest.set(record.idempotencyKey, record);
  }
  return { records, latest: [...latest.values()] };
}

function assertTriggerStoreFile(storePath: string): void {
  if (safeExistsSync(storePath) && !safeLstat(storePath).isFile()) {
    throw new Error('[TRIGGER_STORE_INVALID] delivery store must be a regular file: ' + storePath);
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

/** Janitor-compatible segment name, so the catalog ttl_days segment sweep expires it. */
function rotatedSegmentPath(storePath: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/gu, '').replace('T', '-').slice(0, 15);
  for (let i = 0; ; i++) {
    const candidate = storePath.replace(/(\.jsonl)?$/u, `-${stamp}${i > 0 ? `-${i}` : ''}.jsonl`);
    if (!safeExistsSync(candidate)) return candidate;
  }
}

function isInFlight(record: TriggerRecord): boolean {
  return record.reason === 'delivery_pending';
}

/**
 * Keys that can never re-match once their minute passed: cron ticks
 * (`cron:<id>:<YYYY-MM-DDTHH:MM>`, `gen:<id>:<minute>`) and any other key that
 * ends in a minute stamp. Only these may be trimmed under byte pressure.
 */
const MINUTE_SCOPED_KEY = /:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;

function isMinuteScoped(record: TriggerRecord): boolean {
  return record.source === 'cron' || MINUTE_SCOPED_KEY.test(record.idempotencyKey);
}

function recordTimeMs(record: TriggerRecord): number {
  const ms = Date.parse(record.recordedAt);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * A pending claim whose lease ran out more than the dedupe window ago belongs
 * to a process that is long dead; run() would already re-claim it, so keeping
 * it only grows the journal.
 */
function isAbandonedClaim(record: TriggerRecord, cutoffMs: number): boolean {
  const expiresMs = record.claimExpiresAt ? Date.parse(record.claimExpiresAt) : NaN;
  return (Number.isFinite(expiresMs) ? expiresMs : recordTimeMs(record)) < cutoffMs;
}

/**
 * Retention compaction, age-based. Latest record per key alone never shrinks
 * this journal (cron keys are minted per minute), so:
 * - finished receipts are kept while younger than the dedupe window and
 *   dropped after it — a stable key (reflex, mission admission, continuous
 *   owner, daemon-recovery episode, wake/watch) is never dropped early;
 * - in-flight claims are kept until their lease expired more than the
 *   dedupe window ago (a dead claimant's record is then dropped);
 * - only when the retained set is still above `targetBytes` are the oldest
 *   minute-scoped (cron) receipts trimmed first.
 * Stable keys alone outgrowing the budget only warn
 * ([TRIGGER_STORE_WINDOW_FULL]); appends never fail on size. Dropped history
 * stays in the rotated segment.
 */
function retainTriggerDedupeWindow(
  records: TriggerRecord[],
  targetBytes: number,
  now: Date
): string[] {
  const latest = new Map<string, TriggerRecord>();
  for (const record of records) {
    latest.delete(record.idempotencyKey);
    latest.set(record.idempotencyKey, record);
  }
  const cutoff = now.getTime() - DEDUPE_RETENTION_MS;
  const ordered = [...latest.values()].filter((record) =>
    isInFlight(record) ? !isAbandonedClaim(record, cutoff) : recordTimeMs(record) >= cutoff
  );
  const sizeOf = (record: TriggerRecord) => Buffer.byteLength(JSON.stringify(record), 'utf8') + 1;
  let bytes = ordered.reduce((sum, record) => sum + sizeOf(record), 0);
  const drop = new Set<TriggerRecord>();
  if (bytes > targetBytes) {
    const trimmable = ordered
      .filter((record) => !isInFlight(record) && isMinuteScoped(record))
      .sort((a, b) => recordTimeMs(a) - recordTimeMs(b));
    for (const record of trimmable) {
      if (bytes <= targetBytes) break;
      drop.add(record);
      bytes -= sizeOf(record);
    }
  }
  return ordered.filter((record) => !drop.has(record)).map((record) => JSON.stringify(record));
}

/** After a window-full attempt, re-parse only once the journal grew this much... */
export const TRIGGER_STORE_WINDOW_FULL_REGROWTH_BYTES = 256 * 1024;
/** ...or this long passed (also the warning rate limit). */
export const TRIGGER_STORE_WINDOW_FULL_RETRY_MS = 60 * 60 * 1000;
/** Operator escape hatch named by the window-full diagnostic and the ops-health finding. */
export const TRIGGER_STORE_ROTATE_COMMAND = 'pnpm kyberion scheduler trigger-store rotate';

/** Per-journal memory of the last window-full compaction attempt (this process). */
const windowFullAttempts = new Map<string, { sizeBytes: number; atMs: number }>();
const windowFullWarnedAt = new Map<string, number>();

/** Test seam: forget window-full attempts and warning timestamps. */
export function resetTriggerStoreWindowFullState(): void {
  windowFullAttempts.clear();
  windowFullWarnedAt.clear();
}

function shouldAttemptCompaction(storePath: string, sizeBytes: number, now: Date): boolean {
  const last = windowFullAttempts.get(storePath);
  if (!last) return true;
  return (
    // Shrank since the last attempt (e.g. an operator rotation in another process).
    sizeBytes < last.sizeBytes ||
    sizeBytes >= last.sizeBytes + TRIGGER_STORE_WINDOW_FULL_REGROWTH_BYTES ||
    now.getTime() - last.atMs >= TRIGGER_STORE_WINDOW_FULL_RETRY_MS
  );
}

/**
 * Rotate inline: the janitor that would rotate this journal runs from chronos,
 * so waiting for it is self-defeating when the journal is what stops chronos.
 * The full journal is copied to a janitor-named segment first, then the live
 * file is atomically replaced with the dedupe window, so a crash in between
 * loses nothing. Every appender holds the store lock, so no append races the
 * rewrite (the shared park/publish rewrite in append-only-store.ts exists for
 * lock-free appenders, and leaves the live file absent mid-rewrite).
 */
function compactRecords(
  storePath: string,
  maxStoreBytes: number,
  now: Date,
  chunkBytes?: number
): void {
  const retained = retainTriggerDedupeWindow(
    collectDedupeWindow(storePath, now, chunkBytes).latest,
    Math.floor(maxStoreBytes / 2),
    now
  );
  const retainedBytes = retained.reduce(
    (sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1,
    0
  );
  const sizeBytes = storeSize(storePath);
  const windowFull = retainedBytes > Math.floor((maxStoreBytes * 3) / 4);
  if (windowFull) {
    // Stable keys inside the dedupe window alone fill the budget. Growth only
    // warns: appends and dedupe keep working at any size. The warning is
    // rate-limited and the next attempt waits for real regrowth or an hour, so
    // a stuck journal is not re-parsed and re-logged on every append.
    const warnedAt = windowFullWarnedAt.get(storePath);
    if (warnedAt === undefined || now.getTime() - warnedAt >= TRIGGER_STORE_WINDOW_FULL_RETRY_MS) {
      windowFullWarnedAt.set(storePath, now.getTime());
      logger.warn(
        `[TRIGGER_STORE_WINDOW_FULL] delivery journal cannot shrink below its ${maxStoreBytes}-byte retention threshold — ${retainedBytes} bytes of receipts are inside the ${DEDUPE_RETENTION_MS / 86_400_000}-day dedupe window | next: find the key prefix minting stable keys at this rate (they should be per episode, not per tick); appends and dedupe continue at any size — to shed in-window stable keys: ${TRIGGER_STORE_ROTATE_COMMAND} | evidence: ${storePath} (${sizeBytes} bytes)`
      );
    }
    if (sizeBytes - retainedBytes < Math.floor(maxStoreBytes / 4)) {
      // Rotating now would copy a segment and free almost nothing.
      windowFullAttempts.set(storePath, { sizeBytes, atMs: now.getTime() });
      return;
    }
  }
  safeCopyFileSync(storePath, rotatedSegmentPath(storePath, now));
  safeWriteFile(storePath, retained.length > 0 ? `${retained.join('\n')}\n` : '');
  if (windowFull) {
    windowFullAttempts.set(storePath, { sizeBytes: storeSize(storePath), atMs: now.getTime() });
  } else {
    windowFullAttempts.delete(storePath);
  }
}

function storeSize(storePath: string): number {
  if (!safeExistsSync(storePath)) return 0;
  try {
    return safeStat(storePath).size;
  } catch {
    return 0;
  }
}

/**
 * Append one receipt. Write-time retention runs first once the journal is past
 * `maxStoreBytes`; its failure is housekeeping and only warns. There is no size
 * cap: a journal of any size accepts the append.
 */
function appendRecord(
  storePath: string,
  record: TriggerRecord,
  maxStoreBytes: number,
  now: Date = new Date(),
  chunkBytes?: number
): void {
  safeMkdir(path.dirname(pathResolver.rootResolve(storePath)));
  assertTriggerStoreFile(storePath);
  const serialized = `${JSON.stringify(record)}\n`;
  const lineBytes = Buffer.byteLength(serialized, 'utf8');
  const size = storeSize(storePath);
  if (size + lineBytes > maxStoreBytes && shouldAttemptCompaction(storePath, size, now)) {
    try {
      compactRecords(storePath, maxStoreBytes, now, chunkBytes);
    } catch (error) {
      // Rotation is housekeeping; the receipt append below is the contract.
      logger.warn(
        `[TRIGGER_STORE_ROTATE_FAILED] delivery journal rotation failed — ${
          error instanceof Error ? error.message : String(error)
        } | next: appends continue; the next append past the threshold or the storage janitor retries (pnpm pipeline --input pipelines/storage-janitor.json) | evidence: ${storePath} (${size} bytes)`
      );
    }
  }
  safeAppendFileSync(storePath, serialized);
}

/** Post-delivery receipts must not turn a completed side effect into a crash. */
function appendOutcomeRecord(
  storePath: string,
  record: TriggerRecord,
  maxStoreBytes: number,
  now: Date,
  chunkBytes?: number
): void {
  try {
    appendRecord(storePath, record, maxStoreBytes, now, chunkBytes);
  } catch (error) {
    logger.warn(
      `[TRIGGER_RECEIPT_APPEND_FAILED] ${record.status} receipt for ${record.idempotencyKey} not persisted — ${
        error instanceof Error ? error.message : String(error)
      } | next: check the journal's filesystem and permissions (size never refuses an append); the in-flight claim expires after its lease and may re-deliver | evidence: ${storePath}`
    );
  }
}

function recordTriggerAudit(record: TriggerRecord): void {
  try {
    auditChain.record({
      agentId: record.createdBy.authority_role,
      action: `trigger.${record.status}`,
      operation: `${record.source}:${record.idempotencyKey}`,
      result:
        record.status === 'delivered'
          ? 'completed'
          : record.status === 'rejected'
            ? 'denied'
            : record.status === 'failed'
              ? 'error'
              : 'allowed',
      reason: record.reason,
      correlationId: record.idempotencyKey,
      tenantSlug: record.createdBy.tenant_slug,
      metadata: {
        requested_authority: record.requestedAuthority,
        delivery_id: record.deliveryId,
      },
    });
  } catch (error) {
    // Audit availability must not rewrite a completed side effect as failed.
    logger.error(
      `[TRIGGER_AUDIT_FAILED] ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function receiptFrom(record: TriggerRecord, status: TriggerReceipt['status']): TriggerReceipt {
  return {
    idempotencyKey: record.idempotencyKey,
    source: record.source,
    status,
    ...(record.deliveryId ? { deliveryId: record.deliveryId } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
    recordedAt: record.recordedAt,
  };
}

/** Inter-process lock guarding one delivery journal (shared by runners and rotation). */
function triggerStoreLockId(storePath: string): string {
  return `trigger-store-${createHash('sha256')
    .update(pathResolver.rootResolve(storePath))
    .digest('hex')
    .slice(0, 32)}`;
}

/** Default number of stable keys an operator rotation keeps. */
export const TRIGGER_STORE_ROTATE_DEFAULT_KEEP_STABLE = 2000;
/**
 * Cron receipts this recent survive an operator rotation, so a schedule whose
 * minute is still current cannot fire twice.
 */
const ROTATE_RECENT_CRON_MS = 10 * 60 * 1000;

export interface TriggerStoreRotationOptions {
  storePath?: string;
  /** Newest stable (non-cron) keys to keep; default TRIGGER_STORE_ROTATE_DEFAULT_KEEP_STABLE. */
  keepStable?: number;
  now?: Date;
}

export interface TriggerStoreRotationPlan {
  store_path: string;
  size_bytes: number;
  /** Records in the journal. */
  records: number;
  /** Keys retention still holds (finished inside the dedupe window, or claims not abandoned). */
  keys: number;
  keep_stable: number;
  kept: { in_flight: number; stable: number; recent_cron: number };
  dropped_keys: number;
  /** Stable keys younger than the 7-day dedupe window that the rotation drops (may re-deliver once). */
  dropped_stable_in_window: number;
  /** Up to 5 key prefixes (text before the first ':') of those keys, most frequent first. */
  dropped_stable_in_window_prefixes: Array<{ prefix: string; count: number }>;
  kept_bytes: number;
}

export interface TriggerStoreRotationResult extends TriggerStoreRotationPlan {
  segment_path: string;
}

function resolveStorePath(storePath?: string): string {
  return assertSafeRepositoryPath(pathResolver.rootResolve(storePath || DEFAULT_STORE_PATH), {
    allowMissingLeaf: true,
  });
}

function selectRotationKeep(
  storePath: string,
  keepStable: number,
  now: Date
): { plan: TriggerStoreRotationPlan; lines: string[] } {
  // Streams the journal; keys retention already drops (finished receipts older
  // than the dedupe window, abandoned claims) are not candidates.
  const { records, latest: all } = collectDedupeWindow(storePath, now);
  const cutoff = now.getTime() - DEDUPE_RETENTION_MS;
  const inFlight = all.filter((r) => isInFlight(r) && !isAbandonedClaim(r, cutoff));
  const finished = all.filter((r) => !isInFlight(r));
  const recentCron = finished.filter(
    (r) => isMinuteScoped(r) && recordTimeMs(r) >= now.getTime() - ROTATE_RECENT_CRON_MS
  );
  const stable = finished
    .filter((r) => !isMinuteScoped(r))
    .sort((a, b) => recordTimeMs(b) - recordTimeMs(a))
    .slice(0, keepStable);
  const keep = new Set<TriggerRecord>([...inFlight, ...recentCron, ...stable]);
  const lines = all.filter((r) => keep.has(r)).map((r) => JSON.stringify(r));
  const droppedInWindow = finished.filter(
    (r) => !isMinuteScoped(r) && !keep.has(r) && recordTimeMs(r) >= cutoff
  );
  const prefixCounts = new Map<string, number>();
  for (const record of droppedInWindow) {
    const prefix = record.idempotencyKey.split(':')[0] || record.idempotencyKey;
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const prefixes = [...prefixCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([prefix, count]) => ({ prefix, count }));
  return {
    plan: {
      store_path: path.relative(pathResolver.rootDir(), storePath).split(path.sep).join('/'),
      size_bytes: storeSize(storePath),
      records,
      keys: all.length,
      keep_stable: keepStable,
      kept: { in_flight: inFlight.length, stable: stable.length, recent_cron: recentCron.length },
      dropped_keys: all.length - keep.size,
      dropped_stable_in_window: droppedInWindow.length,
      dropped_stable_in_window_prefixes: prefixes,
      kept_bytes: lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0),
    },
    lines,
  };
}

function normalizeKeepStable(value: number | undefined): number {
  const keep = value ?? TRIGGER_STORE_ROTATE_DEFAULT_KEEP_STABLE;
  if (!Number.isInteger(keep) || keep < 0) {
    throw new Error(`[TRIGGER_STORE_ROTATE] keep-stable must be a non-negative integer: ${value}`);
  }
  return keep;
}

/** What an operator rotation would keep and drop. Read-only. */
export function planTriggerStoreRotation(
  options: TriggerStoreRotationOptions = {}
): TriggerStoreRotationPlan {
  return selectRotationKeep(
    resolveStorePath(options.storePath),
    normalizeKeepStable(options.keepStable),
    options.now ?? new Date()
  ).plan;
}

/**
 * Operator escape hatch for a journal whose dedupe window alone keeps it
 * above its retention threshold ([TRIGGER_STORE_WINDOW_FULL]). Size never
 * stops appends, so this is about shedding growth, not unblocking. Under the
 * store lock, copy the full journal to a segment and rewrite it with the in-flight
 * claims, the newest `keepStable` stable keys and cron receipts of the last
 * 10 minutes. Dropped stable keys may re-deliver once. `wrap` runs around the
 * write inside the lock (the CLI consumes its approval there) and the caller
 * records the audit entry.
 */
export async function rotateTriggerStore(
  options: TriggerStoreRotationOptions = {},
  wrap: <T>(effect: () => T) => T = (effect) => effect()
): Promise<TriggerStoreRotationResult> {
  const storePath = resolveStorePath(options.storePath);
  const keepStable = normalizeKeepStable(options.keepStable);
  const now = options.now ?? new Date();
  return withLock(triggerStoreLockId(storePath), async () =>
    wrap(() => {
      assertTriggerStoreFile(storePath);
      if (!safeExistsSync(storePath)) {
        throw new Error(`[TRIGGER_STORE_ROTATE] no delivery journal at ${storePath}`);
      }
      const { plan, lines } = selectRotationKeep(storePath, keepStable, now);
      const segment = rotatedSegmentPath(storePath, now);
      safeCopyFileSync(storePath, segment);
      safeWriteFile(storePath, lines.length > 0 ? `${lines.join('\n')}\n` : '');
      windowFullAttempts.delete(storePath);
      return {
        ...plan,
        segment_path: path.relative(pathResolver.rootDir(), segment).split(path.sep).join('/'),
      };
    })
  );
}

export class TriggerRunner {
  private readonly storePath: string;
  private readonly now: () => Date;
  private readonly claimLeaseMs: number;
  private readonly maxStoreBytes: number;
  private readonly readChunkBytes: number | undefined;
  private readonly authorityResolver: (
    authority: TriggerAuthoritySnapshot
  ) => TriggerAuthoritySnapshot;
  private readonly lockId: string;

  constructor(options: TriggerRunnerOptions = {}) {
    this.storePath = assertSafeRepositoryPath(
      pathResolver.rootResolve(options.storePath || DEFAULT_STORE_PATH),
      { allowMissingLeaf: true }
    );
    this.now = options.now || (() => new Date());
    this.claimLeaseMs = clamp(
      options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
      1000,
      TRIGGER_STORE_MAX_CLAIM_LEASE_MS
    );
    this.maxStoreBytes = Math.max(64 * 1024, options.maxStoreBytes ?? DEFAULT_MAX_STORE_BYTES);
    this.readChunkBytes = options.readChunkBytes;
    this.authorityResolver = options.authorityResolver || resolveGovernedAuthority;
    this.lockId = triggerStoreLockId(this.storePath);
  }

  records(): TriggerReceipt[] {
    return readRecords(this.storePath, this.now(), this.readChunkBytes).map((record) =>
      receiptFrom(record, record.status)
    );
  }

  async run(
    request: TriggerRequest,
    deliver: (input: TriggerDeliveryInput) => string | void | Promise<string | void>
  ): Promise<TriggerReceipt> {
    const idempotencyKey = String(request.idempotencyKey || '').trim();
    if (!idempotencyKey) throw new Error('Trigger idempotencyKey is required.');
    if (!request.source) throw new Error('Trigger source is required.');
    const claim = await withLock(this.lockId, async () => {
      let existing: TriggerRecord | undefined;
      try {
        existing = findLatestRecord(
          this.storePath,
          idempotencyKey,
          this.now(),
          this.readChunkBytes
        );
      } catch (error) {
        // Fail closed for this one trigger (at-most-once), never for the caller:
        // an unreadable journal must not crash the scheduler that hosts it.
        const reason = `trigger_store_unreadable: ${error instanceof Error ? error.message : String(error)}`;
        logger.warn(
          `[TRIGGER_STORE_UNREADABLE] trigger ${idempotencyKey} not delivered — ${reason} | next: inspect the delivery journal (its size never fails a read — look for a non-file path or an I/O error); the next tick retries | evidence: ${this.storePath}`
        );
        return {
          receipt: {
            idempotencyKey,
            source: request.source,
            status: 'failed' as const,
            reason,
            recordedAt: this.now().toISOString(),
          },
        };
      }
      if (existing) {
        const pendingUntil = existing.claimExpiresAt ? Date.parse(existing.claimExpiresAt) : 0;
        const pending = existing.reason === 'delivery_pending';
        const terminal = existing.status === 'delivered' || existing.status === 'rejected';
        const ownerAlive = pending && isProcessAlive(existing.claimOwnerPid);
        if (terminal || (pending && (pendingUntil > this.now().getTime() || ownerAlive))) {
          return { receipt: receiptFrom(existing, 'duplicate') };
        }
      }

      const rawCreatedBy = normalizeAuthority(request.createdBy);
      const rawRequestedAuthority = normalizeAuthority(request.requestedAuthority || rawCreatedBy);
      let createdBy = rawCreatedBy;
      let requestedAuthority = rawRequestedAuthority;
      let base: TriggerRecord = {
        idempotencyKey,
        source: request.source,
        status: 'rejected',
        createdBy,
        requestedAuthority,
        recordedAt: this.now().toISOString(),
      };

      try {
        createdBy = this.authorityResolver(rawCreatedBy);
        requestedAuthority = this.authorityResolver(rawRequestedAuthority);
        assertNoEscalation(createdBy, requestedAuthority);
        base = { ...base, createdBy, requestedAuthority };
      } catch (error) {
        const rejected: TriggerRecord = {
          ...base,
          status: 'rejected',
          reason: error instanceof Error ? error.message : String(error),
        };
        appendOutcomeRecord(
          this.storePath,
          rejected,
          this.maxStoreBytes,
          this.now(),
          this.readChunkBytes
        );
        recordTriggerAudit(rejected);
        return { receipt: receiptFrom(rejected, 'rejected') };
      }

      const claimed: TriggerRecord = {
        ...base,
        status: 'failed',
        reason: 'delivery_pending',
        deliveryId: idempotencyKey,
        claimId: randomUUID(),
        claimOwnerPid: process.pid,
        claimExpiresAt: new Date(this.now().getTime() + this.claimLeaseMs).toISOString(),
        attempt: ((existing?.attempt as number | undefined) || 0) + 1,
      };
      try {
        appendRecord(this.storePath, claimed, this.maxStoreBytes, this.now(), this.readChunkBytes);
      } catch (error) {
        // No claim record means no idempotency guard: fail closed, do not deliver.
        const reason = `trigger_store_unwritable: ${error instanceof Error ? error.message : String(error)}`;
        logger.warn(
          `[TRIGGER_STORE_UNWRITABLE] trigger ${idempotencyKey} not delivered — ${reason} | next: check the journal's filesystem and permissions (its size never refuses an append); the next tick retries | evidence: ${this.storePath}`
        );
        return { receipt: receiptFrom({ ...claimed, reason }, 'failed') };
      }
      return { claimed };
    });

    if ('receipt' in claim) return claim.receipt;
    const { claimed } = claim;

    try {
      // EV-09: everything this delivery causes runs inside the correlation
      // scope, so worker events and operator notifications can attribute
      // themselves to this firing without a threaded parameter.
      const deliveryId =
        (await withTriggerCorrelation(
          { deliveryId: idempotencyKey, source: request.source, idempotencyKey },
          () =>
            deliver({
              ...request,
              idempotencyKey,
              createdBy: claimed.createdBy,
              requestedAuthority: claimed.requestedAuthority,
              deliveryId: idempotencyKey,
            })
        )) || idempotencyKey;
      const delivered: TriggerRecord = {
        ...claimed,
        status: 'delivered',
        deliveryId,
        reason: undefined,
        recordedAt: this.now().toISOString(),
      };
      await withLock(this.lockId, async () => {
        appendOutcomeRecord(
          this.storePath,
          delivered,
          this.maxStoreBytes,
          this.now(),
          this.readChunkBytes
        );
      });
      recordTriggerAudit(delivered);
      return receiptFrom(delivered, 'delivered');
    } catch (error) {
      const failed: TriggerRecord = {
        ...claimed,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        recordedAt: this.now().toISOString(),
      };
      await withLock(this.lockId, async () => {
        appendOutcomeRecord(
          this.storePath,
          failed,
          this.maxStoreBytes,
          this.now(),
          this.readChunkBytes
        );
      });
      recordTriggerAudit(failed);
      return receiptFrom(failed, 'failed');
    }
  }
}

export function createTriggerRunner(options: TriggerRunnerOptions = {}): TriggerRunner {
  return new TriggerRunner(options);
}

function triggerLeaderLockId(leaderId: string): string {
  return `trigger-leader-${leaderId.replace(/[^a-zA-Z0-9_-]/gu, '_')}`;
}

/** Run one scheduler tick under an inter-process leader lease. */
export async function withTriggerLeaderLease<T>(
  leaderId: string,
  fn: () => Promise<T>
): Promise<T | undefined> {
  try {
    return await withLock(triggerLeaderLockId(leaderId), fn, 1);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('[LOCK_TIMEOUT]')) return undefined;
    throw error;
  }
}

/**
 * Release the leader lease on daemon shutdown when a tick was abandoned
 * mid-flight. A no-op unless this process owns the lease (releaseLock is
 * pid-checked), so it never steals another leader's lease.
 */
export function releaseTriggerLeaderLease(leaderId: string): void {
  releaseLock(triggerLeaderLockId(leaderId));
}

export interface TriggerWatchOptions extends Omit<ManagedProcessWatchOptions, 'onEvent'> {
  runner?: TriggerRunner;
  idempotencyPrefix: string;
  createdBy: TriggerAuthoritySnapshot;
  requestedAuthority?: TriggerAuthoritySnapshot;
  deliver: (input: TriggerDeliveryInput) => string | void | Promise<string | void>;
}

/** Bridge managed-process watch events into the same trigger runner. */
export function armTriggerWatch(
  resourceId: string,
  options: TriggerWatchOptions
): ManagedProcessWatchHandle {
  const runner = options.runner || createTriggerRunner();
  const {
    runner: _runner,
    idempotencyPrefix,
    createdBy,
    requestedAuthority,
    deliver,
    ...watch
  } = options;
  return armWatch(resourceId, {
    ...watch,
    onEvent: async (event) => {
      const key = `${idempotencyPrefix}:${event.kind}:${event.at}`;
      await runner.run(
        {
          idempotencyKey: key,
          source: 'watch',
          createdBy,
          requestedAuthority,
          payload: {
            resource_id: event.resourceId,
            event: event.kind,
            tail: event.tail,
          },
        },
        deliver
      );
    },
  });
}

/** Explicit surface wake entry point; it intentionally shares TriggerRunner. */
export function runWakeTrigger(
  runner: TriggerRunner,
  request: Omit<TriggerRequest, 'source'>,
  deliver: (input: TriggerDeliveryInput) => string | void | Promise<string | void>
): Promise<TriggerReceipt> {
  return runner.run({ ...request, source: 'wake' }, deliver);
}
