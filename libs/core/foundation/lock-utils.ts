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

function lockPath(resourceId: string): string {
  return path.join(LOCK_ROOT, `${resourceId}.lock`);
}

function ownerRecord(resourceId: string): string {
  return JSON.stringify({ pid: process.pid, ts: nowIso(), id: resourceId });
}

/** Publish a complete record exclusively; never a partial file at the lock path. */
function publish(io: LockIo, filePath: string, content: string): void {
  if (io.publishExclusive) io.publishExclusive(filePath, content);
  else io.createExclusive(filePath, content);
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
}

function inspectRecord(file: string): LockRecordView {
  const io = requireLockIo();
  let content: { pid?: unknown; ts?: unknown };
  let statAge: number | undefined;
  try {
    statAge = io.ageMs?.(file);
  } catch {
    statAge = undefined;
  }
  try {
    content = io.loadJson<{ pid?: unknown; ts?: unknown }>(file);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unknown', ageMs: statAge };
  }
  const tsMs = typeof content?.ts === 'string' ? Date.parse(content.ts) : NaN;
  const recordAge = Number.isFinite(tsMs) ? Date.now() - tsMs : undefined;
  const ageMs =
    statAge === undefined
      ? recordAge
      : recordAge === undefined
        ? statAge
        : Math.max(statAge, recordAge);
  const pid = content?.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0)
    return { state: 'unknown', ageMs };
  try {
    process.kill(pid, 0);
    return { state: 'live', ageMs };
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return { state: 'dead', ageMs };
    if (code === 'EPERM') return { state: 'live', ageMs };
    return { state: 'unknown', ageMs };
  }
}

function aged(view: LockRecordView): boolean {
  return view.ageMs !== undefined && view.ageMs >= LOCK_RECOVERY_AGE_MS;
}

/** A main lock record may be removed: its owner is gone, or it is unverifiable and old. */
function lockReclaimable(view: LockRecordView): boolean {
  return view.state === 'dead' || (view.state === 'unknown' && aged(view));
}

/** A cleanup guard may be removed: its cleaner is gone, or it is unverifiable or
 * PID-reused (live) yet older than any real cleanup could take. */
function guardReclaimable(view: LockRecordView): boolean {
  return (
    view.state === 'dead' || ((view.state === 'unknown' || view.state === 'live') && aged(view))
  );
}

let tombCounter = 0;

/**
 * Remove an orphaned cleanup guard. With a rename-capable IO the guard is
 * first moved to a unique tomb, so of several concurrent reclaimers only one
 * obtains a given inode; the tomb is then re-verified, and a guard that turns
 * out to be fresh (another cleaner replaced the orphan in between) is put back
 * with exclusive publication.
 */
function reclaimOrphanedGuard(io: LockIo, guard: string): void {
  if (!io.rename) {
    if (guardReclaimable(inspectRecord(guard))) io.unlink(guard);
    return;
  }
  const tomb = `${guard}.stale-${process.pid}-${++tombCounter}`;
  try {
    io.rename(guard, tomb);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return; // another reclaimer won
    throw error;
  }
  try {
    const claimed = inspectRecord(tomb);
    if (!guardReclaimable(claimed) && claimed.state === 'live') {
      const owner = io.loadJson<Record<string, unknown>>(tomb);
      try {
        publish(io, guard, JSON.stringify(owner));
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
    }
  } finally {
    io.unlink(tomb);
  }
}

/**
 * Stale cleanup is serialized through an exclusive `.reclaim` guard and the
 * lock record is re-verified under it. A missing main record is never
 * unlinked (a new owner may publish next), EPERM counts as a live owner, and
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
  try {
    publish(io, guard, JSON.stringify({ pid: process.pid, ts: nowIso() }));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    const holder = inspectRecord(guard);
    if (holder.state === 'missing') return { retry: true };
    if (guardReclaimable(holder)) {
      reclaimOrphanedGuard(io, guard);
      return { retry: true };
    }
    return { retry: false, ...(holder.state === 'live' ? {} : { pending: guard }) };
  }
  try {
    const current = inspectRecord(lockFile);
    if (current.state === 'missing') return { retry: true };
    if (!lockReclaimable(current))
      return { retry: false, ...(current.state === 'unknown' ? { pending: lockFile } : {}) };
    io.unlink(lockFile);
    return { retry: true };
  } finally {
    try {
      const owner = io.loadJson<{ pid?: number }>(guard);
      if (owner.pid === process.pid) io.unlink(guard);
    } catch {
      /* Unknown cleanup ownership is never deleted here; it ages out instead. */
    }
  }
}

export interface LockRecoveryState {
  /** Record that cannot be verified yet (lock record or `.reclaim` guard). */
  path: string;
  kind: 'lock_record' | 'cleanup_guard';
  state: LockOwnerState;
  ageMs?: number;
  /** ms until automatic reclaim; undefined when the age is unknown. */
  reclaimInMs?: number;
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
    const verifiable =
      view.state === 'missing' || (kind === 'lock_record' && view.state === 'live');
    if (verifiable || (kind === 'lock_record' && view.state === 'dead')) continue;
    if (kind === 'cleanup_guard' && view.state === 'live' && !aged(view)) continue;
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
