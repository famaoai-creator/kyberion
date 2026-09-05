import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('max file lines checker boundary', () => {
  it('uses the foundation text reader for source files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_max_file_lines.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });
});
