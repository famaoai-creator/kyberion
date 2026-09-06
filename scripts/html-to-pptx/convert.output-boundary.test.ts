import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('html-to-pptx CLI output boundary', () => {
  it('routes conversion output through the shared harness printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/html-to-pptx/convert.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('run: ({ argv, print }) => main(argv, print)');
  });
});
