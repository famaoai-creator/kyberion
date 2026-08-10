import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeUnlinkSync, safeWriteFile } from '../secure-io.js';
import { acquireLock, releaseLock } from './lock-utils.js';

const lockRoot = pathResolver.rootResolve('active/shared/runtime/locks');
const createdLockIds: string[] = [];

function lockPath(resourceId: string): string {
  return path.join(lockRoot, `${resourceId}.lock`);
}

afterEach(() => {
  for (const resourceId of createdLockIds.splice(0)) {
    safeUnlinkSync(lockPath(resourceId));
  }
});

describe('lock utilities', () => {
  it('reclaims a malformed lock record instead of blocking forever', async () => {
    const resourceId = `lock-utils-malformed-${process.pid}-${Date.now()}`;
    createdLockIds.push(resourceId);
    safeMkdir(lockRoot, { recursive: true });
    safeWriteFile(lockPath(resourceId), '{not-json');

    await expect(acquireLock(resourceId, 500)).resolves.toBe(true);
    releaseLock(resourceId);
    expect(safeExistsSync(lockPath(resourceId))).toBe(false);
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
