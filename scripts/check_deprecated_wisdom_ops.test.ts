import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';
import { readDeprecatedWisdomTextFile } from './check_deprecated_wisdom_ops.js';

describe('deprecated Wisdom op checker output boundary', () => {
  it('rejects a directory replacement before catalog parsing', () => {
    expect(() => readDeprecatedWisdomTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('keeps findings behind the shared printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_deprecated_wisdom_ops.ts'))
    );

    expect(source).toContain('context.print');
    expect(source).not.toContain('console.warn');
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });
});
