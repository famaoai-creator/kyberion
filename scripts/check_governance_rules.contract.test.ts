import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('governance rules snapshot loader boundary', () => {
  it('uses the governed voice engine snapshot catalog', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_governance_rules.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('defineCatalog<{');
    expect(source).toContain('voiceEngineRegistrySnapshotCatalog.load()');
    expect(source).toContain("id: 'voice-engine-registry-snapshot'");
    expect(source).toContain('loadSurfaceManifest(');
  });
});
