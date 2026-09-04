import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('design contrast checker', () => {
  it('uses the governed themes JSON loader', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_design_contrast.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('readSafeJsonFile');
    expect(source).not.toContain('return readJson<T>(filePath)');
  });
});
