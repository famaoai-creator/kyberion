import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safePublishExclusiveFileSync,
  safeReadFile,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import {
  acquireLock,
  inspectLockRecovery,
  LOCK_RECOVERY_AGE_MS,
  releaseLock,
  withLockSync,
} from './lock-utils.js';

const lockRoot = pathResolver.rootResolve('active/shared/runtime/locks');
const createdLockIds: string[] = [];

function lockPath(resourceId: string): string {
  return path.join(lockRoot, `${resourceId}.lock`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const resourceId of createdLockIds.splice(0)) {
    safeUnlinkSync(lockPath(resourceId));
  }
});

describe('lock utilities', () => {
  it.each([
    ['writer-lease-path:abc', 'writer-lease-path%3Aabc'],
    ['../nested\\key', '..%2Fnested%5Ckey'],
    ['CON', '%43ON'],
    ['nul.txt', '%6Eul.txt'],
  ])('acquires and releases a portable lock for %s', async (key, filename) => {
    createdLockIds.push(filename);
    await expect(acquireLock(key, 1)).resolves.toBe(true);
    expect(safeExistsSync(lockPath(filename))).toBe(true);
    await expect(acquireLock(key, 1)).resolves.toBe(false);
    expect(JSON.parse(String(safeReadFile(lockPath(filename))))).toMatchObject({
      pid: process.pid,
      id: key,
    });
    releaseLock(key);
    expect(safeExistsSync(lockPath(filename))).toBe(false);
    expect(withLockSync(key, () => 'locked')).toBe('locked');
    expect(safeExistsSync(lockPath(filename))).toBe(false);
  });

  it('keeps escaped resource IDs distinct from literal percent sequences', async () => {
    const key = `lock-utils:${process.pid}`;
    const escapedKey = `lock-utils%3A${process.pid}`;
    createdLockIds.push(`lock-utils%3A${process.pid}`, `lock-utils%253A${process.pid}`);
    await expect(acquireLock(key, 1)).resolves.toBe(true);
    await expect(acquireLock(escapedKey, 1)).resolves.toBe(true);
    expect(safeExistsSync(path.join(lockRoot, `lock-utils%3A${process.pid}.lock`))).toBe(true);
    expect(safeExistsSync(path.join(lockRoot, `lock-utils%253A${process.pid}.lock`))).toBe(true);
    releaseLock(key);
    releaseLock(escapedKey);
  });

  it('reclaims an old malformed record once it exceeds the recovery age', async () => {
    const resourceId = `lock-utils-malformed-old-${process.pid}-${Date.now()}`;
    createdLockIds.push(resourceId);
    safeMkdir(lockRoot, { recursive: true });
    safeWriteFile(lockPath(resourceId), '{not-json');
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + LOCK_RECOVERY_AGE_MS + 1_000);

    await expect(acquireLock(resourceId, 500)).resolves.toBe(true);
    releaseLock(resourceId);
    expect(safeExistsSync(lockPath(resourceId))).toBe(false);
  });

  it('keeps a fresh (possibly mid-write) malformed record and reports it without throwing', async () => {
    const resourceId = `lock-utils-malformed-fresh-${process.pid}-${Date.now()}`;
    createdLockIds.push(resourceId);
    safeMkdir(lockRoot, { recursive: true });
    safeWriteFile(lockPath(resourceId), '');

    await expect(acquireLock(resourceId, 1)).resolves.toBe(false);
    releaseLock(resourceId);
    expect(safeExistsSync(lockPath(resourceId))).toBe(true);
    const recovery = inspectLockRecovery(resourceId);
    expect(recovery).toMatchObject({ kind: 'lock_record', state: 'unknown' });
    expect(recovery?.reclaimInMs).toBeGreaterThan(0);
  });

  it('publishes lock records atomically without leaving temp siblings', async () => {
    const resourceId = `lock-utils-atomic-${process.pid}-${Date.now()}`;
    createdLockIds.push(resourceId);

    await expect(acquireLock(resourceId, 1)).resolves.toBe(true);
    expect(() => safePublishExclusiveFileSync(lockPath(resourceId), '{}')).toThrow(
      expect.objectContaining({ code: 'EEXIST' })
    );
    expect(safeReaddir(lockRoot).filter((name) => name.startsWith(`${resourceId}.lock.`))).toEqual(
      []
    );
    releaseLock(resourceId);
  });

  it('attempts acquisition at least once even with a non-blocking timeout', async () => {
    // EV-02 regression: the retry loop was `while (elapsed < timeoutMs)`, so a
    // caller expressing "do not wait" (withTriggerLeaderLease passes 1ms) could
    // spend its whole budget in the preamble and return false without touching
    // the lock file. The caller reads false as "another leader holds this", so a
    // scheduler tick was dropped on a busy machine with nothing holding it.
    const resourceId = `lock-utils-nonblocking-${process.pid}-${Date.now()}`;
    createdLockIds.push(resourceId);

    await expect(acquireLock(resourceId, 1)).resolves.toBe(true);
    releaseLock(resourceId);
  });

  it('still reports contention when the lock is genuinely held', async () => {
    const resourceId = `lock-utils-held-${process.pid}-${Date.now()}`;
    createdLockIds.push(resourceId);
    safeMkdir(lockRoot, { recursive: true });
    // A live holder (this process) is not stale, so it must not be purged.
    safeWriteFile(
      lockPath(resourceId),
      JSON.stringify({ pid: process.pid, ts: new Date().toISOString() })
    );

    await expect(acquireLock(resourceId, 1)).resolves.toBe(false);
  });

  it('reclaims a lock whose owner process no longer exists', async () => {
    const resourceId = `lock-utils-dead-pid-${process.pid}-${Date.now()}`;
    createdLockIds.push(resourceId);
    safeMkdir(lockRoot, { recursive: true });
    safeWriteFile(
      lockPath(resourceId),
      JSON.stringify({ pid: 2 ** 31 - 1, ts: new Date().toISOString() })
    );

    await expect(acquireLock(resourceId, 500)).resolves.toBe(true);
    releaseLock(resourceId);
    expect(safeExistsSync(lockPath(resourceId))).toBe(false);
  });
});
