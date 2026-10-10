import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
// Real secure-io lock IO (no audit-chain mock): the hard-link rules apply.
import {
  safeExistsSync,
  safeLinkExclusiveSync,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '../secure-io.js';
import { acquireLock, releaseLock } from './lock-utils.js';

const RUN = `${process.pid}-${Date.now()}`;
const id = `vitest-lock-tomb-release-${RUN}`;
const lockFile = path.join(
  pathResolver.rootDir(),
  'active/shared/runtime/locks',
  `${encodeURIComponent(id)}.lock`
);
const tomb = `${lockFile}.stale-99999-${Date.now()}-1`;

describe('lock release while a recovery tomb links the record', () => {
  afterEach(() => {
    safeRmSync(lockFile, { force: true });
    for (const name of safeReaddir(path.dirname(lockFile))) {
      if (name.startsWith(`${path.basename(lockFile)}.stale-`))
        safeRmSync(path.join(path.dirname(lockFile), name), { force: true });
    }
  });

  it('releases the owner record although secure-io refuses its base-side read', async () => {
    expect(await acquireLock(id, 300)).toBe(true);
    // The put-back window: <file> and <file>.stale-* are links of one inode.
    safeLinkExclusiveSync(lockFile, tomb);
    releaseLock(id);
    expect(safeExistsSync(lockFile)).toBe(false);
    // A contender can take the lock right away.
    expect(await acquireLock(id, 300)).toBe(true);
    releaseLock(id);
  });

  it('ignores leftover tombs that are not the own inode of the record', async () => {
    expect(await acquireLock(id, 300)).toBe(true);
    // Leftover tombs from older recoveries: other inodes, dead owners.
    for (let n = 100; n < 110; n += 1) {
      safeWriteFile(
        `${lockFile}.stale-1-${Date.now()}-${n}`,
        JSON.stringify({ pid: 999999, ts: new Date(0).toISOString(), id })
      );
    }
    safeLinkExclusiveSync(lockFile, tomb);
    releaseLock(id);
    expect(safeExistsSync(lockFile)).toBe(false);
    expect(await acquireLock(id, 300)).toBe(true);
    releaseLock(id);
  });
});
