import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('sync_specialist_catalog catalog boundary', () => {
  it('uses the governed catalog reader instead of an ad hoc Ajv reader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/sync_specialist_catalog.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('defineCatalog<SpecialistCatalogPayload>');
    expect(source).not.toContain('createAjv()');
    expect(source).not.toContain('readJson<');
  });
});
