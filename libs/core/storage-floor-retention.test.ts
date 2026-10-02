import { describe, expect, it } from 'vitest';
import {
  STORAGE_FLOOR_RETENTION_PREFIXES,
  loadRetentionCatalog,
  retentionEntryForPath,
  storageFloorRetentionRules,
} from './storage-retention-catalog.js';
import { STORAGE_FLOOR_ROOTS } from './storage-layout.js';

/**
 * Every storage-layout floor must be declared in the retention catalog, and
 * only the consumable floors may produce deletion rules — deliverables on the
 * artifact floor are review_required, never silently expired.
 */
describe('storage floor retention', () => {
  const catalog = loadRetentionCatalog();

  it('declares a retention entry for every storage-layout floor root', () => {
    for (const root of Object.values(STORAGE_FLOOR_ROOTS)) {
      expect(retentionEntryForPath(catalog, root)?.path, `${root} is undeclared`).toBe(root);
    }
  });

  it('sweeps every non-tmp floor root through the floor retention prefixes', () => {
    const floorRoots = Object.values(STORAGE_FLOOR_ROOTS).filter(
      (root) => root !== 'active/shared/tmp'
    );
    expect([...STORAGE_FLOOR_RETENTION_PREFIXES].sort()).toEqual([...floorRoots].sort());
  });

  it('expires staging and cache partitions but never the artifact floor', () => {
    const dirs = storageFloorRetentionRules(catalog).map((rule) => rule.repoRelativeDir);
    expect(dirs).toContain('active/shared/staging');
    for (const partition of ['system', 'public', 'confidential', 'personal']) {
      expect(dirs).toContain(`active/shared/cache/${partition}`);
    }
    // Legacy root-level cache files (knowledge-index ki-*.json) are LRU-managed
    // by their owner; mtime would evict an index that is read every day.
    expect(dirs).not.toContain('active/shared/cache');
    expect(
      retentionEntryForPath(catalog, 'active/shared/cache/ki-abc.json')?.ttl_days
    ).toBeUndefined();
    expect(dirs).not.toContain('active/shared/artifacts');
    expect(
      retentionEntryForPath(catalog, 'active/shared/artifacts/system/report/x.md')?.action
    ).toBe('review_required');
  });
});
