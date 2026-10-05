/**
 * File-based inter-process locks (atomic publication, guarded stale reclaim).
 *
 * Main records with dead owners, or old malformed records, recover automatically.
 * An extant cleanup guard is never taken over: compare-then-rename is not an
 * atomic conditional removal, and moving a replacement live guard even briefly
 * can admit two cleaners and then two main-lock holders. A cleaner that dies
 * before releasing its guard therefore requires resource-scoped quiescent
 * operator recovery. No measured frequency is claimed for this exception.
 * All competing processes must use this protocol and the same PID/filesystem
 * namespace. Live cleaner tombs are never swept, even after a long suspension.
 */
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import { nowIso } from './time.js';
import { pathResolver } from '../path-resolver.js';
import { isVitestProcess } from './env.js';

const logger = createLogger('lock-utils');

export interface LockIo {
  exists(filePath: string): boolean;
  mkdir(dirPath: string): void;
  createExclusive(filePath: string, content: string): void;
  unlink(filePath: string): void;
  loadJson<T>(filePath: string): T;
  /** Atomic exclusive publication (temp file + link): EEXIST if present, never partial. */
  publishExclusive?(filePath: string, content: string): void;
  /** ms since last modification, undefined when missing. */
  ageMs?(filePath: string): number | undefined;
  /** Rename; must throw ENOENT when the source is gone. */
  rename?(fromPath: string, toPath: string): void;
  /** Hard-link `fromPath` to `toPath`; EEXIST when the target exists, never overwrites. */
  linkExclusive?(fromPath: string, toPath: string): void;
  /** Directory listing (names), used for best-effort housekeeping of lock litter. */
  readdir?(dirPath: string): string[];
}

let lockIo: LockIo | undefined;

function testLockIo(): LockIo | undefined {
  if (!isVitestProcess()) return undefined;
  return (
    globalThis as typeof globalThis & {
      __kyberionVitestIo?: { lockIo?: LockIo };
    }
  ).__kyberionVitestIo?.lockIo;
}

/** Registers the lock IO; returns the previous registration so tests can restore it. */
export function registerLockIo(io: LockIo | undefined): LockIo | undefined {
  const previous = lockIo;
  lockIo = io;
  return previous;
}

function requireLockIo(): LockIo {
  lockIo ||= testLockIo();
  if (!lockIo) throw new Error('secure_lock_io_not_registered');
  return lockIo;
}

/**
 * Lock Utilities for Autonomous Resource Arbitration.
 * Provides file-based mutex/locking with retry support.
 */

const LOCK_ROOT = path.join(pathResolver.rootDir(), 'active/shared/runtime/locks');

/**
 * Age after which an unverifiable lock record (empty, partial, malformed or
 * PID-less) main record is reclaimed. Cleanup guards are never age-reclaimed.
 * Production publishes atomically. The legacy wx fallback cannot protect a
 * partial publisher suspended beyond this age; custom IO must publish atomically
 * when it requires the same mutual-exclusion guarantee.
 */
export const LOCK_RECOVERY_AGE_MS = 30_000;

/**
 * Diagnostic threshold for a long-held cleanup guard. Retained for API
 * compatibility; this age never authorizes taking over a live or unknown guard.
 */
export const LOCK_LIVE_GUARD_RECOVERY_AGE_MS = 10 * 60_000;

/** Upper bound on litter files removed per housekeeping sweep. */
const LOCK_SWEEP_LIMIT = 32;

function lockPath(resourceId: string): string {
  // Resource IDs are logical keys, not paths. Escape '%' as well so keys such
  // as 'path:abc' and 'path%3Aabc' cannot accidentally share a mutex.
  let filename = encodeURIComponent(resourceId);
  // Windows reserves device names even when they have a file extension.
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
    filename = `%${filename.charCodeAt(0).toString(16).toUpperCase()}${filename.slice(1)}`;
  }
  return path.join(LOCK_ROOT, `${filename}.lock`);
}

function ownerRecord(resourceId: string): string {
  return JSON.stringify({ pid: process.pid, ts: nowIso(), id: resourceId });
}

/** Publication attempts when the temp sibling vanished mid-publish (ENOENT). */
const PUBLISH_ENOENT_ATTEMPTS = 3;

/**
 * Publish a complete record exclusively; never a partial file at the lock path.
 * ENOENT means nothing was published — the publication temp was swept as
 * litter while this process stalled past LOCK_RECOVERY_AGE_MS — so it is
 * retried with a fresh temp (bounded) instead of failing the lock.
 */
function publish(io: LockIo, filePath: string, content: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      if (io.publishExclusive) io.publishExclusive(filePath, content);
      else io.createExclusive(filePath, content);
      return;
    } catch (error: unknown) {
      if (errorCode(error) !== 'ENOENT' || attempt >= PUBLISH_ENOENT_ATTEMPTS) throw error;
      logger.debug(`lock publication ${filePath} lost its temp (ENOENT); retrying (${attempt})`);
    }
  }
}

/**
 * Tries to acquire a lock for a specific resource.
 * @param resourceId - Name of the resource (e.g., 'registry-json')
 * @param timeoutMs - Max time to wait for the lock (default: 5000ms)
 * @returns boolean - true if lock acquired, false otherwise. Never throws for
 * lock recovery state; see {@link inspectLockRecovery}.
 */
export async function acquireLock(resourceId: string, timeoutMs = 5000): Promise<boolean> {
  const lockFile = lockPath(resourceId);
  const startTime = Date.now();

  const io = requireLockIo();
  if (!io.exists(LOCK_ROOT)) io.mkdir(LOCK_ROOT);

  // EV-02: always attempt acquisition at least once.
  //
  // This was `while (elapsed < timeoutMs)`, which meant a caller using a
  // deliberately non-blocking timeout — `withTriggerLeaderLease` passes 1ms to
  // express "do not wait for another leader" — could spend its whole budget in
  // the safeExistsSync/safeMkdir preamble above and return false without ever
  // touching the lock file. The caller then reads that as "another leader owns
  // this tick" and skips, so on a busy machine a scheduler tick was dropped
  // while nothing was actually holding the lease. Returning false must mean "the
  // lock is genuinely held", never "we ran out of time before trying".
  let pending: string | undefined;
  let stalePurges = 0;
  const MAX_STALE_PURGES = 3;
  for (;;) {
    try {
      publish(io, lockFile, ownerRecord(resourceId));
      return true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;

      // Lock held by another process, check if it's stale
      const recovery = reclaimStaleLock(lockFile);
      pending = recovery.pending;
      if (recovery.retry && stalePurges < MAX_STALE_PURGES) {
        stalePurges++;
        logger.warn(`⚠️ [LockUtils] Found stale lock for ${resourceId}. Purging...`);
        continue; // Retry immediately after guarded cleanup or disappearance
      }
      // The lock is really held: honour the caller's waiting budget.
      if (Date.now() - startTime >= timeoutMs) {
        if (pending) warnPendingRecovery(resourceId, pending);
        return false;
      }
      // Wait a bit before retrying (exponential backoff or simple delay)
      await new Promise((res) => setTimeout(res, 100 + Math.random() * 200));
    }
  }
}

/**
 * Releases a previously acquired lock.
 */
export function releaseLock(resourceId: string): void {
  const lockFile = lockPath(resourceId);
  const io = requireLockIo();
  if (io.exists(lockFile)) {
    try {
      const content = io.loadJson<{ pid?: number }>(lockFile);
      if (content.pid === process.pid) {
        io.unlink(lockFile);
      }
    } catch (_) {
      // An unverifiable record is never force-released here; the age-bounded
      // reclaim in acquireLock/withLockSync recovers it once it is provably old.
    }
  }
}

type LockOwnerState = 'live' | 'dead' | 'missing' | 'unknown';

interface LockRecordView {
  state: LockOwnerState;
  /** Best-known age in ms (file mtime, or the record's own `ts`), if any. */
  ageMs?: number;
  /**
   * Identity of a parsed record (pid, ts, id, nonce); undefined when the
   * record is missing or unparseable. Removal compares it before deleting.
   */
  identity?: string;
  /** The record exists but could not be read (EACCES, EMFILE, EIO, policy denial). */
  unreadable?: boolean;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** Only content problems make a record 'unknown'; I/O failures do not. */
function isMalformedRecordError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : '';
  return /dangerous JSON key|must be valid JSON/.test(message);
}

function recordIdentity(content: Record<string, unknown>): string {
  return JSON.stringify([content.pid, content.ts, content.id, content.nonce]);
}

function inspectRecord(file: string): LockRecordView {
  const io = requireLockIo();
  let content: Record<string, unknown> | null;
  let statAge: number | undefined;
  try {
    statAge = io.ageMs?.(file);
  } catch {
    statAge = undefined;
  }
  try {
    content = io.loadJson<Record<string, unknown> | null>(file);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return { state: 'missing' };
    if (isMalformedRecordError(error)) return { state: 'unknown', ageMs: statAge };
    // An unreadable record is never reclaimed: treat its owner as live.
    logger.warn(
      `Lock record ${file} unreadable — ${errorCode(error) ?? (error as Error)?.message ?? String(error)} | treated as held and never reclaimed; check permissions, fd limits or policy | evidence: ${file}`
    );
    return { state: 'live', ageMs: statAge, unreadable: true };
  }
  if (content === null || typeof content !== 'object' || Array.isArray(content))
    return { state: 'unknown', ageMs: statAge };
  const identity = recordIdentity(content);
  const tsMs = typeof content.ts === 'string' ? Date.parse(content.ts) : NaN;
  const recordAge = Number.isFinite(tsMs) ? Date.now() - tsMs : undefined;
  const ageMs =
    statAge === undefined
      ? recordAge
      : recordAge === undefined
        ? statAge
        : Math.max(statAge, recordAge);
  const pid = content.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
    return { state: 'unknown', ageMs, identity };
  try {
    process.kill(pid, 0);
    return { state: 'live', ageMs, identity };
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ESRCH') return { state: 'dead', ageMs, identity };
    if (code !== 'EPERM')
      logger.warn(
        `Lock owner probe for ${file} failed — ${code ?? String(error)} | owner treated as live | evidence: pid ${pid}`
      );
    return { state: 'live', ageMs, identity };
  }
}

function agedPast(view: LockRecordView, limitMs: number): boolean {
  return view.ageMs !== undefined && view.ageMs >= limitMs;
}

function aged(view: LockRecordView): boolean {
  return agedPast(view, LOCK_RECOVERY_AGE_MS);
}

/** A main lock record may be removed: its owner is gone, or it is unverifiable and old. */
function lockReclaimable(view: LockRecordView): boolean {
  return view.state === 'dead' || (view.state === 'unknown' && aged(view));
}

let tombCounter = 0;

/** Tomb names embed the cleaner PID and creation time so housekeeping can age them. */
function tombPath(file: string): string {
  return `${file}.stale-${process.pid}-${Date.now()}-${++tombCounter}`;
}

function bestEffortUnlink(io: LockIo, file: string): void {
  try {
    io.unlink(file);
  } catch (error: unknown) {
    logger.debug(`lock litter ${file} not removed: ${errorCode(error) ?? String(error)}`);
  }
}

/** Put a displaced record back at `file` exclusively (link, else publish); never overwrite. */
function putBack(io: LockIo, tomb: string, file: string): boolean {
  try {
    if (io.linkExclusive) io.linkExclusive(tomb, file);
    else publish(io, file, JSON.stringify(io.loadJson<unknown>(tomb)));
    return true;
  } catch (error: unknown) {
    logger.warn(
      `Lock record ${file} could not be restored — ${errorCode(error) ?? String(error)} | the displaced record is kept for inspection; live-cleaner records are never swept | evidence: ${tomb}`
    );
    return false;
  }
}

type RemovalOutcome = 'removed' | 'gone' | 'changed';

/**
 * Remove `file` only while it is still the record `expected` describes. With a
 * rename-capable IO the record is first moved to a unique tomb. Concurrent
 * main cleaners are excluded by the unreclaimed guard; the tomb is then
 * verified (same identity, still removable). This is not an atomic conditional
 * removal and must never be used to take over another guard. An unexpected
 * identity change is restored exclusively and the removal is aborted.
 */
function removeIfUnchanged(
  io: LockIo,
  file: string,
  expected: LockRecordView,
  removable: (view: LockRecordView) => boolean
): RemovalOutcome {
  if (!io.rename) {
    const again = inspectRecord(file);
    if (again.state === 'missing') return 'gone';
    if (again.identity !== expected.identity || !removable(again)) return 'changed';
    io.unlink(file);
    return 'removed';
  }
  const tomb = tombPath(file);
  try {
    io.rename(file, tomb);
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return 'gone'; // another cleaner won
    throw error;
  }
  const claimed = inspectRecord(tomb);
  if (claimed.state === 'missing') return 'gone';
  if (claimed.identity === expected.identity && removable(claimed)) {
    bestEffortUnlink(io, tomb);
    return 'removed';
  }
  if (putBack(io, tomb, file)) bestEffortUnlink(io, tomb);
  return 'changed';
}

const TOMB_PATTERN = /\.stale-(\d+)-(\d+)-\d+$/;
const PUBLISH_TEMP_PATTERN = /\.lock(?:\.reclaim)?\.\d+\.[0-9a-f]{12}\.tmp$/;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCode(error) !== 'ESRCH';
  }
}

/**
 * Best-effort, bounded removal of lock litter in the locks directory:
 * publication temp siblings and recovery tombs older than LOCK_RECOVERY_AGE_MS
 * (a tomb whose cleaner is still alive or cannot be verified is always kept).
 */
function sweepLockLitter(io: LockIo, dir: string): void {
  if (!io.readdir) return;
  let names: string[];
  try {
    names = io.readdir(dir);
  } catch {
    return;
  }
  let removed = 0;
  for (const name of names) {
    if (removed >= LOCK_SWEEP_LIMIT) break;
    const file = path.join(dir, name);
    const tomb = TOMB_PATTERN.exec(name);
    let litter = false;
    if (tomb) {
      const age = Date.now() - Number(tomb[2]);
      litter = age >= LOCK_RECOVERY_AGE_MS && !pidAlive(Number(tomb[1]));
    } else if (PUBLISH_TEMP_PATTERN.test(name)) {
      let age: number | undefined;
      try {
        age = io.ageMs?.(file);
      } catch {
        age = undefined;
      }
      litter = age !== undefined && age >= LOCK_RECOVERY_AGE_MS;
    }
    if (!litter) continue;
    bestEffortUnlink(io, file);
    removed++;
  }
}

/**
 * Serialize stale main cleanup through an exclusive, non-reclaimable guard.
 * A missing main record is never removed. EPERM/unreadable records stay held.
 * Only the guard owner can release it; an interrupted cleaner requires
 * quiescent recovery rather than unsafe recursive guard reclamation.
 */
function reclaimStaleLock(lockFile: string): { retry: boolean; pending?: string } {
  const initial = inspectRecord(lockFile);
  if (initial.state === 'missing') return { retry: true };
  if (!lockReclaimable(initial))
    return { retry: false, ...(initial.state === 'unknown' ? { pending: lockFile } : {}) };
  const io = requireLockIo();
  const guard = lockFile + '.reclaim';
  const mine = {
    pid: process.pid,
    ts: nowIso(),
    nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  };
  const myIdentity = recordIdentity(mine);
  try {
    publish(io, guard, JSON.stringify(mine));
  } catch (error: unknown) {
    if (errorCode(error) !== 'EEXIST') throw error;
    const holder = inspectRecord(guard);
    if (holder.state === 'missing') return { retry: true };
    // Never displace an extant guard, even when its earlier owner was dead.
    // Another cleaner may have replaced it since inspection; rename/restore
    // would expose an unsafe gap before identity verification.
    return { retry: false, pending: guard };
  }
  try {
    sweepLockLitter(io, path.dirname(lockFile));
    const current = inspectRecord(lockFile);
    if (current.state === 'missing') return { retry: true };
    if (!lockReclaimable(current))
      return { retry: false, ...(current.state === 'unknown' ? { pending: lockFile } : {}) };
    // Unexpected ownership change (for example external mutation) fails closed.
    if (inspectRecord(guard).identity !== myIdentity) return { retry: false };
    return { retry: removeIfUnchanged(io, lockFile, current, lockReclaimable) !== 'changed' };
  } finally {
    const own = inspectRecord(guard);
    // Unknown cleanup ownership is retained for quiescent operator recovery.
    if (own.identity === myIdentity)
      removeIfUnchanged(io, guard, own, (view) => view.identity === myIdentity);
  }
}

export interface LockRecoveryState {
  /** Record that cannot be verified yet (lock record or `.reclaim` guard). */
  path: string;
  kind: 'lock_record' | 'cleanup_guard';
  state: LockOwnerState;
  ageMs?: number;
  /** A cleanup guard needs quiescent operator recovery if its owner cannot finish. */
  manualRecoveryRequired?: boolean;
  /** ms until automatic reclaim; undefined when the age is unknown or never reclaimed. */
  reclaimInMs?: number;
  /** The record exists but cannot be read; it is never reclaimed automatically. */
  unreadable?: boolean;
}

/**
 * Report unverifiable lock state for operators/diagnostics without mutating
 * anything. Returns undefined when the lock is free or verifiably owned.
 */
export function inspectLockRecovery(resourceId: string): LockRecoveryState | undefined {
  const lockFile = lockPath(resourceId);
  const candidates: Array<[string, LockRecoveryState['kind']]> = [
    [lockFile, 'lock_record'],
    [lockFile + '.reclaim', 'cleanup_guard'],
  ];
  for (const [file, kind] of candidates) {
    const view = inspectRecord(file);
    if (view.state === 'missing') continue;
    if (view.unreadable) {
      // Never reclaimed automatically: report without a reclaim estimate.
      return {
        path: file,
        kind,
        state: view.state,
        unreadable: true,
        ...(kind === 'cleanup_guard' ? { manualRecoveryRequired: true } : {}),
        ...(view.ageMs !== undefined ? { ageMs: view.ageMs } : {}),
      };
    }
    if (kind === 'lock_record' && (view.state === 'live' || view.state === 'dead')) continue;
    if (kind === 'cleanup_guard') {
      if (view.state === 'live' && !agedPast(view, LOCK_LIVE_GUARD_RECOVERY_AGE_MS)) continue;
      return {
        path: file,
        kind,
        state: view.state,
        manualRecoveryRequired: true,
        ...(view.ageMs !== undefined ? { ageMs: view.ageMs } : {}),
      };
    }
    return {
      path: file,
      kind,
      state: view.state,
      ...(view.ageMs !== undefined
        ? { ageMs: view.ageMs, reclaimInMs: Math.max(0, LOCK_RECOVERY_AGE_MS - view.ageMs) }
        : {}),
    };
  }
  return undefined;
}

function recoveryHint(pending: string): string {
  if (pending.endsWith('.reclaim'))
    return `cleanup guard ${pending} is never reclaimed automatically; let its owner finish, or confirm all processes that can use this resource are stopped before inspecting/removing the orphan guard and restarting those processes`;
  return `unverifiable lock record ${pending} is reclaimed automatically once older than ${LOCK_RECOVERY_AGE_MS}ms`;
}

function warnPendingRecovery(resourceId: string, pending: string): void {
  logger.warn(
    `Lock ${resourceId} not acquired — ${recoveryHint(pending)} | inspect with inspectLockRecovery('${resourceId}') if it persists | evidence: ${pending}`
  );
}

/**
 * Executes a function with an exclusive lock.
 */
export async function withLock<T>(
  resourceId: string,
  fn: () => Promise<T>,
  timeoutMs = 5000
): Promise<T> {
  const acquired = await acquireLock(resourceId, timeoutMs);
  if (!acquired) {
    throw new Error(
      `[LOCK_TIMEOUT] Failed to acquire lock for resource: ${resourceId} within ${timeoutMs}ms`
    );
  }
  try {
    return await fn();
  } finally {
    releaseLock(resourceId);
  }
}

/**
 * Synchronous counterpart for small synchronous persistence primitives.
 *
 * Some governed stores intentionally expose a synchronous API because they
 * are called from event/trace callbacks. They still need an inter-process
 * fence; a plain read-rewrite sequence is not sufficient. Atomics.wait keeps
 * the bounded retry deterministic without using direct filesystem I/O.
 */
export function withLockSync<T>(resourceId: string, fn: () => T, timeoutMs = 5000): T {
  const lockFile = lockPath(resourceId);
  const startTime = Date.now();
  let pending: string | undefined;
  const io = requireLockIo();
  if (!io.exists(LOCK_ROOT)) io.mkdir(LOCK_ROOT);

  while (Date.now() - startTime < timeoutMs) {
    try {
      publish(io, lockFile, ownerRecord(resourceId));
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      const recovery = reclaimStaleLock(lockFile);
      pending = recovery.pending;
      if (recovery.retry) continue;
      const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
      Atomics.wait(waitBuffer, 0, 0, 50);
      continue;
    }
    try {
      return fn();
    } finally {
      releaseLock(resourceId);
    }
  }

  throw new Error(
    `[LOCK_TIMEOUT] Failed to acquire lock for resource: ${resourceId} within ${timeoutMs}ms` +
      (pending ? ` (${recoveryHint(pending)})` : '')
  );
}
