import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkEsmIntegrity } from './check_esm_integrity.js';

describe('ESM integrity checker', () => {
  it('uses the governed package manifest loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_esm_integrity.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('readSafeJsonFile');
    expect(source).not.toContain('readJson<{');
  });

  it('keeps the governed source tree ESM-compatible', () => {
    expect(checkEsmIntegrity()).toEqual([]);
  }, 60_000);
});
