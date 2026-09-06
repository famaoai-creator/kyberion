import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { readCapabilitySeamsTextFile } from './check_capability_seams_ast.js';

describe('capability seams AST checker boundary', () => {
  it('rejects a directory replacement before seam parsing', () => {
    expect(() => readCapabilitySeamsTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation text reader for source and graph files', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_capability_seams_ast.ts'), {
        encoding: 'utf8',
      }) || ''
    );

    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });
});
