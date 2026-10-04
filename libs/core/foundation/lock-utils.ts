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

export function registerLockIo(io: LockIo): void {
  lockIo = io;
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
 * Tries to acquire a lock for a specific resource.
 * @param resourceId - Name of the resource (e.g., 'registry-json')
 * @param timeoutMs - Max time to wait for the lock (default: 5000ms)
 * @returns boolean - true if lock acquired, false otherwise
 */
export async function acquireLock(resourceId: string, timeoutMs = 5000): Promise<boolean> {
  const lockFile = path.join(LOCK_ROOT, `${resourceId}.lock`);
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
  let recoveryBlocked: string | undefined;
  let stalePurges = 0;
  const MAX_STALE_PURGES = 3;
  for (;;) {
    try {
      io.createExclusive(
        lockFile,
        JSON.stringify({
          pid: process.pid,
          ts: nowIso(),
          id: resourceId,
        })
      );
      return true;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;

      // Lock held by another process, check if it's stale
      const recovery = reclaimStaleLock(lockFile);
      recoveryBlocked = recovery.blocked;
      if (recovery.retry && stalePurges < MAX_STALE_PURGES) {
        stalePurges++;
        logger.warn(`⚠️ [LockUtils] Found stale lock for ${resourceId}. Purging...`);
        continue; // Retry immediately after guarded cleanup or disappearance
      }
      // The lock is really held: honour the caller's waiting budget.
      if (Date.now() - startTime >= timeoutMs) {
        if (recoveryBlocked) throw recoveryError(resourceId, recoveryBlocked);
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
  const lockFile = path.join(LOCK_ROOT, `${resourceId}.lock`);
  const io = requireLockIo();
  if (io.exists(lockFile)) {
    try {
      const content = io.loadJson<{ pid?: number }>(lockFile);
      if (content.pid === process.pid) {
        io.unlink(lockFile);
      }
    } catch (_) {
      // An incomplete record may belong to a live publisher. Never delete
      // ownership we cannot verify; operator recovery must inspect it first.
    }
  }
}

type LockOwnerState = 'live' | 'dead' | 'missing' | 'unknown';

function lockOwnerState(lockFile: string): LockOwnerState {
  let content: { pid?: number };
  try {
    content = requireLockIo().loadJson<{ pid?: number }>(lockFile);
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'unknown';
  }
  if (typeof content?.pid !== 'number' || !Number.isInteger(content.pid) || content.pid <= 0)
    return 'unknown';
  try {
    process.kill(content.pid, 0);
    return 'live';
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'dead';
    if (code === 'EPERM') return 'live';
    return 'unknown';
  }
}

function recoveryError(resourceId: string, lockFile: string): Error {
  return new Error(
    `[LOCK_RECOVERY_REQUIRED] Cannot verify lock ownership for ${resourceId}: ${lockFile}. Inspect the lock and its owner; after confirming no holder remains, remove the orphaned record explicitly. No uncertain lock was deleted.`
  );
}

/** Only stale cleanup is serialized. An orphaned cleanup guard deliberately
 * requires operator inspection: recursively stealing it recreates the race.
 * A missing main record is never unlinked, since a new owner may publish next. */
function reclaimStaleLock(lockFile: string): { retry: boolean; blocked?: string } {
  const initial = lockOwnerState(lockFile);
  if (initial === 'missing') return { retry: true };
  if (initial !== 'dead')
    return { retry: false, ...(initial === 'unknown' ? { blocked: lockFile } : {}) };
  const io = requireLockIo();
  const guard = lockFile + '.reclaim';
  try {
    io.createExclusive(guard, JSON.stringify({ pid: process.pid, ts: nowIso() }));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
    return { retry: false, ...(lockOwnerState(guard) === 'live' ? {} : { blocked: guard }) };
  }
  try {
    const current = lockOwnerState(lockFile);
    if (current === 'missing') return { retry: true };
    if (current !== 'dead')
      return { retry: false, ...(current === 'unknown' ? { blocked: lockFile } : {}) };
    io.unlink(lockFile);
    return { retry: true };
  } finally {
    try {
      const owner = io.loadJson<{ pid?: number }>(guard);
      if (owner.pid === process.pid) io.unlink(guard);
    } catch {
      /* Unknown cleanup ownership is never deleted. */
    }
  }
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
  const lockFile = path.join(LOCK_ROOT, `${resourceId}.lock`);
  const startTime = Date.now();
  let recoveryBlocked: string | undefined;
  const io = requireLockIo();
  if (!io.exists(LOCK_ROOT)) io.mkdir(LOCK_ROOT);

  while (Date.now() - startTime < timeoutMs) {
    try {
      io.createExclusive(
        lockFile,
        JSON.stringify({ pid: process.pid, ts: nowIso(), id: resourceId })
      );
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      const recovery = reclaimStaleLock(lockFile);
      recoveryBlocked = recovery.blocked;
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

  if (recoveryBlocked) throw recoveryError(resourceId, recoveryBlocked);
  throw new Error(
    `[LOCK_TIMEOUT] Failed to acquire lock for resource: ${resourceId} within ${timeoutMs}ms`
  );
}
