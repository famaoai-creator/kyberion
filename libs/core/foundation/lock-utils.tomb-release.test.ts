import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
// Real secure-io lock IO (no audit-chain mock): the hard-link rules apply.
import { safeExistsSync, safeLinkExclusiveSync, safeRmSync } from '../secure-io.js';
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
    safeRmSync(tomb, { force: true });
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
});
