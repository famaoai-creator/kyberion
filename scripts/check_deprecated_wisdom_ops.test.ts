import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';

describe('deprecated Wisdom op checker output boundary', () => {
  it('keeps findings behind the shared printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_deprecated_wisdom_ops.ts'))
    );

    expect(source).toContain('context.print');
    expect(source).not.toContain('console.warn');
  });
});
