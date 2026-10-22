/**
 * The teardown helper is the thing standing between the test suite and a
 * mission tree that silently fills with fixture directories, so its own
 * guarantees are worth pinning: it reclaims the tenant parent, it stops at
 * the tier root, and it never throws on a path that is not there.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { missionDir, tenantMissionDir, rootDir } from '../path-resolver.js';
import { safeExistsSync, safeMkdir, safeWriteFile } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { removeMissionFixture, removeMissionFixtures } from './mission-fixture.js';

/** Seeding the governed mission tree needs the authority that owns it. */
function seed(fn: () => void): void {
  withExecutionContext('mission_controller', fn, 'worker');
}

const SUITE = `MSN-FIXTURE-HELPER-${process.pid}`;
const TENANT = `fixture-tenant-${process.pid}`;

afterEach(() => {
  removeMissionFixtures([
    { missionId: SUITE, tier: 'public' },
    { missionId: SUITE, tier: 'confidential' },
    { missionId: SUITE, tier: 'confidential', tenantSlug: TENANT },
  ]);
});

describe('removeMissionFixture', () => {
  it('removes a mission directory and everything inside it', () => {
    const dir = missionDir(SUITE, 'public');
    seed(() => {
      safeMkdir(path.join(dir, 'coordination'), { recursive: true });
      safeWriteFile(path.join(dir, 'coordination', 'events.jsonl'), '{}\n');
    });
    expect(safeExistsSync(dir)).toBe(true);

    removeMissionFixture({ missionId: SUITE, tier: 'public' });

    expect(safeExistsSync(dir)).toBe(false);
  });

  it('reclaims the tenant directory the fixture brought into being', () => {
    const dir = tenantMissionDir(SUITE, TENANT, 'confidential');
    seed(() => safeMkdir(dir, { recursive: true }));
    const tenantDir = path.dirname(dir);
    expect(safeExistsSync(tenantDir)).toBe(true);

    removeMissionFixture({ missionId: SUITE, tier: 'confidential', tenantSlug: TENANT });

    expect(safeExistsSync(tenantDir)).toBe(false);
  });

  it('never ascends past the mission tier root', () => {
    const dir = missionDir(SUITE, 'confidential');
    seed(() => safeMkdir(dir, { recursive: true }));

    removeMissionFixture({ missionId: SUITE, tier: 'confidential' });

    expect(safeExistsSync(path.join(rootDir(), 'active', 'missions'))).toBe(true);
    expect(safeExistsSync(path.join(rootDir(), 'active'))).toBe(true);
  });

  it('is a no-op for a fixture that was never created', () => {
    expect(() =>
      removeMissionFixture({ missionId: `${SUITE}-ABSENT`, tier: 'public' })
    ).not.toThrow();
  });

  it('is safe to call twice', () => {
    const dir = missionDir(SUITE, 'public');
    seed(() => safeMkdir(dir, { recursive: true }));

    removeMissionFixture({ missionId: SUITE, tier: 'public' });
    expect(() => removeMissionFixture({ missionId: SUITE, tier: 'public' })).not.toThrow();
    expect(safeExistsSync(dir)).toBe(false);
  });
});
