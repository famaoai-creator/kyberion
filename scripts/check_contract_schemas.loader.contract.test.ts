import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('contract schema checker loader boundary', () => {
  it('uses foundation schema compilers without owning a legacy Ajv instance', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_contract_schemas.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('compileSchema(pathResolver.rootResolve(check.schemaPath))');
    expect(source).toContain('compileSchema(');
    expect(source).not.toContain('compileSchemaFromPath');
    expect(source).not.toContain('createAjv()');
    expect(source).not.toContain('addFormatsModule');
  });
});
