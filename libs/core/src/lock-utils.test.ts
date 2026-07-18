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
