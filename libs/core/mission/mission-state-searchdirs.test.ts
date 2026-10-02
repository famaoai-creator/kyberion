import { afterEach, describe, expect, it, vi } from 'vitest';

const FORBIDDEN_SENTINEL = 'forbidden-tier-root';

vi.mock('../secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../secure-io.js')>();
  return {
    ...actual,
    safeLstat: (p: string) => {
      if (String(p).includes(FORBIDDEN_SENTINEL)) {
        throw new Error('[ROLE_VIOLATION] Role is NOT authorized to lstat path (test double)');
      }
      return actual.safeLstat(p);
    },
  };
});

import { pathResolver } from '../path-resolver.js';
import { listMissionsInSearchDirs } from './mission-state.js';
import { safeMkdir, safeRmSync, safeWriteFile } from '../secure-io.js';

const rootDir = pathResolver.sharedTmp('mission-state-searchdirs-test');
const goodDir = `${rootDir}/missions/public`;
const forbiddenDir = `${rootDir}/${FORBIDDEN_SENTINEL}`;

afterEach(() => {
  safeRmSync(rootDir, { recursive: true, force: true });
});

describe('listMissionsInSearchDirs tier isolation', () => {
  it('skips a search dir the role cannot stat instead of failing the sweep', () => {
    safeMkdir(`${goodDir}/MSN-VISIBLE-001`, { recursive: true });
    safeWriteFile(`${goodDir}/MSN-VISIBLE-001/mission-state.json`, '{}');
    // If the role-blocked lstat did NOT throw, this dir would be scanned and
    // the mission listed — the assertion below proves the throw path ran.
    safeMkdir(forbiddenDir, { recursive: true });
    safeWriteFile(`${forbiddenDir}/mission-state.json`, '{}');

    const missions = listMissionsInSearchDirs({
      directories: [forbiddenDir, goodDir],
    });

    expect(missions.map((m) => m.missionId)).toEqual(['MSN-VISIBLE-001']);
  });
});
