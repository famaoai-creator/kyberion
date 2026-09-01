import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkUxContractDocs } from './check_ux_contract_docs.js';

describe('UX contract docs', () => {
  it('keeps the public front door in plain language', () => {
    expect(checkUxContractDocs()).toEqual([]);
  });

  it('uses the governed surface role catalog loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_ux_contract_docs.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadSurfaceRoleCatalog()');
    expect(source).not.toContain("pathResolver.knowledge('product/governance/surface-roles.json')");
    expect(source).not.toContain('readJson<');
  });
});
