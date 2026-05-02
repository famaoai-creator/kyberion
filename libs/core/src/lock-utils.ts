import * as path from 'node:path';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { safeCreateExclusiveFileSync, safeExistsSync, safeMkdir, safeReadFile, safeUnlinkSync } from '../secure-io.js';

/**
 * Lock Utilities for Autonomous Resource Arbitration.
 * Provides file-based mutex/locking with retry support.
 */

const LOCK_ROOT = pathResolver.rootResolve('active/shared/runtime/locks');

/**
 * Tries to acquire a lock for a specific resource.
 * @param resourceId - Name of the resource (e.g., 'registry-json')
 * @param timeoutMs - Max time to wait for the lock (default: 5000ms)
 * @returns boolean - true if lock acquired, false otherwise
 */
export async function acquireLock(resourceId: string, timeoutMs = 5000): Promise<boolean> {
  const lockFile = path.join(LOCK_ROOT, `${resourceId}.lock`);
  const startTime = Date.now();

  if (!safeExistsSync(LOCK_ROOT)) safeMkdir(LOCK_ROOT, { recursive: true });

  while (Date.now() - startTime < timeoutMs) {
    try {
      safeCreateExclusiveFileSync(
        lockFile,
        JSON.stringify({
          pid: process.pid,
          ts: new Date().toISOString(),
          id: resourceId,
        }),
      );
      return true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock held by another process, check if it's stale
        if (_isLockStale(lockFile)) {
          logger.warn(`⚠️ [LockUtils] Found stale lock for ${resourceId}. Purging...`);
          safeUnlinkSync(lockFile);
          continue; // Retry immediately
        }
        // Wait a bit before retrying (exponential backoff or simple delay)
        await new Promise(res => setTimeout(res, 100 + Math.random() * 200));
      } else {
        throw err;
      }
    }
  }

  return false;
}

/**
 * Releases a previously acquired lock.
 */
export function releaseLock(resourceId: string): void {
  const lockFile = path.join(LOCK_ROOT, `${resourceId}.lock`);
  if (safeExistsSync(lockFile)) {
    try {
      const content = JSON.parse(safeReadFile(lockFile, { encoding: 'utf8' }) as string);
      if (content.pid === process.pid) {
        safeUnlinkSync(lockFile);
      }
    } catch (_) {
      // Force release if corrupted
      safeUnlinkSync(lockFile);
    }
  }
}

/**
 * Checks if a lock file is stale (process no longer exists).
 */
function _isLockStale(lockFile: string): boolean {
  try {
    const content = JSON.parse(safeReadFile(lockFile, { encoding: 'utf8' }) as string);
    // Check if PID is still running (signal 0 doesn't kill but checks existence)
    process.kill(content.pid, 0);
    return false; // Still running
  } catch (err: any) {
    // ESRCH means process not found
    return err.code === 'ESRCH';
  }
}

/**
 * Executes a function with an exclusive lock.
 */
export async function withLock<T>(resourceId: string, fn: () => Promise<T>, timeoutMs = 5000): Promise<T> {
  const acquired = await acquireLock(resourceId, timeoutMs);
  if (!acquired) {
    throw new Error(`[LOCK_TIMEOUT] Failed to acquire lock for resource: ${resourceId} within ${timeoutMs}ms`);
  }
  try {
    return await fn();
  } finally {
    releaseLock(resourceId);
  }
}
