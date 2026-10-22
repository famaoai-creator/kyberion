import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { findMissionResidue } from './purge_mission_residue.js';

const root = pathResolver.sharedTmp(`mission-residue-test-${process.pid}`);

afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('mission residue partitions', () => {
  it('keeps empty tier namespaces without hiding orphan mission directories', () => {
    for (const tier of ['public', 'confidential', 'personal']) {
      safeMkdir(path.join(root, tier), { recursive: true });
    }
    safeMkdir(path.join(root, 'confidential', 'tenant-a'), { recursive: true });
    safeMkdir(path.join(root, 'personal', 'shared'), { recursive: true });
    expect(findMissionResidue(root)).toEqual([]);

    const orphan = path.join(root, 'public', 'MSN-ORPHAN');
    const legacy = path.join(root, 'MSN-LEGACY-ORPHAN');
    safeMkdir(orphan, { recursive: true });
    safeMkdir(legacy, { recursive: true });
    expect(findMissionResidue(root).sort()).toEqual([orphan, legacy].sort());
  });

  it('keeps files in unregistered slug-shaped directories visible as residue', () => {
    const orphan = path.join(root, 'confidential', 'fixture-data');
    safeMkdir(orphan, { recursive: true });
    safeWriteFile(path.join(orphan, 'orphan.json'), '{}');
    expect(findMissionResidue(root)).toEqual([orphan]);
  });

  it('preserves a tenant namespace even when its only mission is an orphan', () => {
    const orphan = path.join(root, 'confidential', 'tenant-a', 'MSN-ORPHAN');
    safeMkdir(orphan, { recursive: true });
    expect(findMissionResidue(root)).toEqual([orphan]);
  });

  it('preserves registered tenant missions while finding adjacent residue', () => {
    const registered = path.join(root, 'confidential', 'tenant-a', 'MSN-REAL');
    const orphan = path.join(root, 'confidential', 'tenant-a', 'MSN-ORPHAN');
    safeMkdir(registered, { recursive: true });
    safeMkdir(orphan, { recursive: true });
    safeWriteFile(path.join(registered, 'mission-state.json'), '{}');
    expect(findMissionResidue(root)).toEqual([orphan]);
  });
});
