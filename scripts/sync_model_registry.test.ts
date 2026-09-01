import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('sync_model_registry', () => {
  it('uses the canonical model registry loader for bootstrap input', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/sync_model_registry.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadModelRegistry()');
    expect(source).toContain('defineGenerator');
    expect(source).toContain('runSyncModelRegistry');
    expect(source).not.toContain('readJson<');
  });
});
