import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('capability seams generator boundary', () => {
  it('uses the foundation text reader for declaration source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_capability_seams.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
    expect(source).toContain('defineGenerator');
  });
});
