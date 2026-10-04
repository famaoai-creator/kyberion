/**
 * File-based inter-process locks (atomic publication, guarded stale reclaim).
 *
 * Residual window: every removal is identity-checked through a tomb rename,
 * and a publication whose temp sibling was swept as litter while the publisher
 * stalled (ENOENT from publish) is retried with a fresh temp. What remains is
 * a process stalled for longer than {@link LOCK_LIVE_GUARD_RECOVERY_AGE_MS}
 * (10 minutes) in the middle of a reclaim: its `.reclaim` guard and its tomb
 * are then treated as abandoned and swept, so a holder's record it had moved
 * to a tomb can be lost, or put back after another process already published.
 * A stall that long (suspended laptop, SIGSTOP, debugger) is accepted as out
 * of scope; the bounded ages keep normal crashes recoverable without operators.
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
 * PID-less) or an orphaned `.reclaim` cleanup guard is reclaimed. Records are
 * published atomically, so an unverifiable record only appears through the
 * wx-create fallback, a power loss or a hand edit; cleanup guards are held for
 * microseconds. Thirty seconds is far beyond either legitimate window.
 */
export const LOCK_RECOVERY_AGE_MS = 30_000;

/**
 * A cleanup guard whose recorded PID is alive is only reclaimed past this age
 * (the PID was reused by an unrelated process). Main-record removal is
 * identity-checked, so even a cleaner stalled this long cannot delete a newer
 * holder's record.
 */
export const LOCK_LIVE_GUARD_RECOVERY_AGE_MS = 10 * 60_000;

/** Upper bound on litter files removed per housekeeping sweep. */
const LOCK_SWEEP_LIMIT = 32;

function lockPath(resourceId: string): string {
  return path.join(LOCK_ROOT, `${resourceId}.lock`);
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

/**
 * A cleanup guard may be removed: its cleaner is gone, it is unverifiable and
 * old, or its PID is alive (reused) yet older than LOCK_LIVE_GUARD_RECOVERY_AGE_MS.
 * An unreadable guard is never removed.
 */
function guardReclaimable(view: LockRecordView): boolean {
  if (view.unreadable) return false;
  return (
    view.state === 'dead' ||
    (view.state === 'unknown' && aged(view)) ||
    (view.state === 'live' && agedPast(view, LOCK_LIVE_GUARD_RECOVERY_AGE_MS))
  );
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
      `Lock record ${file} could not be restored — ${errorCode(error) ?? String(error)} | the displaced record is kept for inspection and swept after ${LOCK_RECOVERY_AGE_MS}ms | evidence: ${tomb}`
    );
    return false;
  }
}

type RemovalOutcome = 'removed' | 'gone' | 'changed';

/**
 * Remove `file` only while it is still the record `expected` describes. With a
 * rename-capable IO the record is first moved to a unique tomb, so of several
 * concurrent cleaners only one obtains a given inode; the tomb is then
 * verified (same identity, still removable). A record that differs — a new
 * holder published, or another cleaner replaced an orphaned guard — is put
 * back exclusively and the removal is aborted.
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
 * (a tomb whose cleaner is still alive is kept until the live-guard age).
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
      litter =
        age >= LOCK_LIVE_GUARD_RECOVERY_AGE_MS ||
        (age >= LOCK_RECOVERY_AGE_MS && !pidAlive(Number(tomb[1])));
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
 * Stale cleanup is serialized through an exclusive `.reclaim` guard and the
 * lock record is re-verified under it. Every removal (main record, orphaned
 * guard, own guard) is identity-checked through a tomb rename, so a stalled
 * cleaner can never delete a record it did not inspect. A missing main record
 * is never unlinked, EPERM and unreadable records count as live, and
 * unverifiable records/guards are only reclaimed once older than
 * LOCK_RECOVERY_AGE_MS. `pending` names a record that is waiting for that age.
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
    if (guardReclaimable(holder)) {
      removeIfUnchanged(io, guard, holder, guardReclaimable);
      sweepLockLitter(io, path.dirname(lockFile));
      return { retry: true };
    }
    return { retry: false, ...(holder.state === 'live' ? {} : { pending: guard }) };
  }
  try {
    sweepLockLitter(io, path.dirname(lockFile));
    const current = inspectRecord(lockFile);
    if (current.state === 'missing') return { retry: true };
    if (!lockReclaimable(current))
      return { retry: false, ...(current.state === 'unknown' ? { pending: lockFile } : {}) };
    // A cleaner that stalled long enough to lose its guard must not proceed.
    if (inspectRecord(guard).identity !== myIdentity) return { retry: false };
    return { retry: removeIfUnchanged(io, lockFile, current, lockReclaimable) !== 'changed' };
  } finally {
    const own = inspectRecord(guard);
    // Unknown cleanup ownership is never deleted here; it ages out instead.
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
        ...(view.ageMs !== undefined ? { ageMs: view.ageMs } : {}),
      };
    }
    if (kind === 'lock_record' && (view.state === 'live' || view.state === 'dead')) continue;
    const limit =
      kind === 'cleanup_guard' && view.state === 'live'
        ? LOCK_LIVE_GUARD_RECOVERY_AGE_MS
        : LOCK_RECOVERY_AGE_MS;
    if (kind === 'cleanup_guard' && view.state === 'live' && !agedPast(view, limit)) continue;
    return {
      path: file,
      kind,
      state: view.state,
      ...(view.ageMs !== undefined
        ? { ageMs: view.ageMs, reclaimInMs: Math.max(0, limit - view.ageMs) }
        : {}),
    };
  }
  return undefined;
}

function recoveryHint(pending: string): string {
  return `unverifiable lock record ${pending} is reclaimed automatically once older than ${LOCK_RECOVERY_AGE_MS}ms`;
}

function warnPendingRecovery(resourceId: string, pending: string): void {
  logger.warn(
    `Lock ${resourceId} not acquired — ${recoveryHint(pending)} | retry later, or inspect with inspectLockRecovery('${resourceId}') if it persists | evidence: ${pending}`
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
