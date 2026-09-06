import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readCatalogTextFile } from './check_catalog_integrity.js';

describe('catalog integrity schema loader boundary', () => {
  it('uses foundation schema compilation and leaves ref registration to it', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_catalog_integrity.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('compileSchema(pathResolver.rootResolve(check.schemaPath))');
    expect(source).toContain('compileSchema, readTextFile');
    expect(source).not.toContain('safeReadFile(');
    expect(source).not.toContain('createAjv');
    expect(source).not.toContain('ajv.compile');
    expect(source).not.toContain('ajv.addSchema');
    expect(source).not.toContain("from 'ajv-formats'");
    expect(source).not.toContain('console.warn');
  });

  it('rejects a directory replacement before catalog text parsing', () => {
    expect(() => readCatalogTextFile(pathResolver.rootDir(), 'fixture')).toThrow(
      'fixture must be a regular file'
    );
  });
});
