import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('generate_pii_rules catalog boundary', () => {
  it('reuses the fail-closed PII rules loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_pii_rules.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('loadPiiRules()');
    expect(source).not.toContain('readJson<');
    expect(source).not.toContain('createAjv');
  });
});
