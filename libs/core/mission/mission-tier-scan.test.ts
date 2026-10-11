import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as pathResolver from '../path-resolver.js';
import { missionTierScanDirs } from '../owner-scope.js';
import { listMissionsInSearchDirs } from './mission-state.js';

/**
 * Real-io, real-policy coverage of the bound-partition probe: a tenant-bound
 * process may not enumerate a protected mission tier root, so every
 * enumerator routes through `missionTierScanDirs` (own partition only).
 * Fixtures write via raw fs — the io gate would deny a bound process writing
 * another tenant's partition, which is the point being tested.
 */
const TENANT = 'tgs-acme';
const OTHER = 'tgs-beta';
const MISSION = 'MSN-TGS-SCAN';

function fixtureDir(tenant: string): string {
  return pathResolver.rootResolve(`active/missions/confidential/${tenant}/${MISSION}`);
}

function writeMission(tenant: string): void {
  const dir = fixtureDir(tenant);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'mission-state.json'),
    JSON.stringify({ mission_id: MISSION, tier: 'confidential', tenant_slug: tenant })
  );
}

function cleanup(): void {
  for (const tenant of [TENANT, OTHER]) {
    fs.rmSync(pathResolver.rootResolve(`active/missions/confidential/${tenant}`), {
      recursive: true,
      force: true,
    });
  }
}

describe('missionTierScanDirs (bound-partition scan roots)', () => {
  const savedTenant = process.env.KYBERION_TENANT;

  beforeEach(() => {
    delete process.env.KYBERION_TENANT;
    cleanup();
    writeMission(TENANT);
    writeMission(OTHER);
  });

  afterEach(() => {
    cleanup();
    if (savedTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = savedTenant;
  });

  it('returns the tier root for an unbound process', () => {
    const root = pathResolver.rootResolve('active/missions/confidential');
    expect(missionTierScanDirs(root)).toEqual([root]);
  });

  it('narrows to the bound partition on protected tier roots', () => {
    process.env.KYBERION_TENANT = TENANT;
    const root = pathResolver.rootResolve('active/missions/confidential');
    expect(missionTierScanDirs(root)).toEqual([path.join(root, TENANT)]);
  });

  it('keeps public tier roots fully enumerable under a bound identity', () => {
    process.env.KYBERION_TENANT = TENANT;
    const root = pathResolver.rootResolve('active/missions/public');
    expect(missionTierScanDirs(root)).toEqual([root]);
  });

  it('listMissionsInSearchDirs sees only the bound partition under a bound identity', () => {
    process.env.KYBERION_TENANT = TENANT;
    const root = pathResolver.rootResolve('active/missions/confidential');
    const found = listMissionsInSearchDirs({ directories: [root] }).map((m) => m.missionPath);
    expect(found).toContain(fixtureDir(TENANT));
    expect(found).not.toContain(fixtureDir(OTHER));
  });

  it('listMissionsInSearchDirs enumerates all partitions when unbound', () => {
    const root = pathResolver.rootResolve('active/missions/confidential');
    const found = listMissionsInSearchDirs({ directories: [root] }).map((m) => m.missionPath);
    expect(found).toContain(fixtureDir(TENANT));
    expect(found).toContain(fixtureDir(OTHER));
  });
});
