import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';

describe('Apple FM check output boundary', () => {
  it('routes probe output through the shared script context', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_apple_fm.ts'), {
        encoding: 'utf8',
      })
    );
    expect(source).toContain('run: (context) => main(context.print)');
    expect(source).toContain("flags: ['quiet']");
    expect(source).not.toContain('console.log');
  });
});
