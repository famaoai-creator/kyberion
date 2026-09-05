import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('documentation links checker boundary', () => {
  it('uses the foundation text reader for markdown sources', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_documentation_links.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });
});
