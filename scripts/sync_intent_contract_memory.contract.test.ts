import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('sync_intent_contract_memory catalog boundary', () => {
  it('uses the governed catalog boundary for memory files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/sync_intent_contract_memory.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('defineCatalog<MemoryFile>');
    expect(source).not.toContain('compileSchemaFromPath');
    expect(source).not.toContain('createAjv()');
    expect(source).not.toContain('readFoundationJson');
  });
});
