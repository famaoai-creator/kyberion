import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('sync_service_endpoints catalog boundary', () => {
  it('uses defineCatalog instead of an ad hoc Ajv reader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/sync_service_endpoints.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('defineCatalog<ServiceEndpointPayload>');
    expect(source).not.toContain('createAjv()');
    expect(source).not.toContain('readJson<');
  });
});
