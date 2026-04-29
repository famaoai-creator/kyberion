import { describe, expect, it } from 'vitest';
import {
  getSurfaceProviderManifestCatalogEntry,
  listSurfaceProviderManifestCatalogEntries,
} from './surface-provider-manifest-catalog.js';

describe('surface-provider-manifest-catalog', () => {
  it('lists shipped provider manifest entries', () => {
    const ids = listSurfaceProviderManifestCatalogEntries().map((entry) => entry.id).sort();

    expect(ids).toEqual(['chronos', 'presence', 'slack']);
  });

  it('returns a manifest catalog entry for slack', () => {
    const entry = getSurfaceProviderManifestCatalogEntry('slack');

    expect(entry?.channel).toBe('slack');
    expect(entry?.manifest_path).toContain('surface-provider-manifests.json');
    expect(entry?.status).toBe('shipped');
  });
});
