import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('design token generator boundary', () => {
  it('uses the foundation text reader for generated source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/generate_design_tokens.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
    expect(source).toContain('defineGenerator');
  });
});
