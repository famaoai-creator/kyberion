import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  getSurfaceProviderManifestCatalogEntry,
  listSurfaceProviderManifestCatalogEntries,
} from './surface-provider-manifest-catalog.js';
import { safeExistsSync, safeReadFile, safeReaddir } from './secure-io.js';

function readJson(filePath: string) {
  return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
}

describe('surface-provider-manifest-catalog', () => {
  it('lists shipped provider manifest entries', () => {
    const ids = listSurfaceProviderManifestCatalogEntries().map((entry) => entry.id).sort();

    expect(ids).toEqual(['chronos', 'discord', 'imessage', 'presence', 'slack', 'telegram']);
  });

  it('keeps the canonical directory in sync with the snapshot', () => {
    const rootDir = process.cwd();
    const dir = path.join(rootDir, 'knowledge/public/governance/surface-provider-manifest-catalogs');
    const snapshot = readJson(path.join(rootDir, 'knowledge/public/governance/surface-provider-manifest-catalog.json'));
    const snapshotIds = (snapshot.entries || []).map((entry: { id?: string }) => entry.id).sort();

    expect(safeExistsSync(dir)).toBe(true);
    const directoryIds = safeReaddir(dir)
      .filter((entry) => entry.endsWith('.json'))
      .sort()
      .map((entry) => {
        const payload = readJson(path.join(dir, entry));
        const ids = (payload.entries || []).map((item: { id?: string }) => item.id).filter(Boolean);
        expect(ids).toHaveLength(1);
        expect(entry.replace(/\.json$/i, '')).toBe(ids[0]);
        return ids[0];
      });

    expect(directoryIds).toEqual(snapshotIds);
  });

  it('returns a manifest catalog entry for slack', () => {
    const entry = getSurfaceProviderManifestCatalogEntry('slack');

    expect(entry?.channel).toBe('slack');
    expect(entry?.manifest_path).toContain('surface-provider-manifests.json');
    expect(entry?.status).toBe('shipped');
  });

  it('returns a manifest catalog entry for imessage', () => {
    const entry = getSurfaceProviderManifestCatalogEntry('imessage');

    expect(entry?.channel).toBe('imessage');
    expect(entry?.manifest_path).toContain('surface-provider-manifests.json');
    expect(entry?.status).toBe('shipped');
  });

  it('returns a manifest catalog entry for discord', () => {
    const entry = getSurfaceProviderManifestCatalogEntry('discord');

    expect(entry?.channel).toBe('discord');
    expect(entry?.manifest_path).toContain('surface-provider-manifests.json');
    expect(entry?.status).toBe('shipped');
  });

  it('returns a manifest catalog entry for telegram', () => {
    const entry = getSurfaceProviderManifestCatalogEntry('telegram');

    expect(entry?.channel).toBe('telegram');
    expect(entry?.manifest_path).toContain('surface-provider-manifests.json');
    expect(entry?.status).toBe('shipped');
  });
});
