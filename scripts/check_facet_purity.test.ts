import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkFacetPurity, readFacetPurityTextFile } from './check_facet_purity.js';

describe('facet purity checker', () => {
  it('rejects a directory replacement before facet parsing', () => {
    expect(() => readFacetPurityTextFile(pathResolver.rootResolve('scripts'))).toThrow(
      'must be a regular file'
    );
  });

  it('uses the foundation text reader for facet documents', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/check_facet_purity.ts'), {
        encoding: 'utf8',
      }) || ''
    );
    expect(source).toContain("readTextFile } from '@agent/core/foundation'");
    expect(source).not.toContain('safeReadFile(');
  });

  it('keeps all governed facet documents free of cross-kind content', () => {
    expect(checkFacetPurity()).toEqual([]);
  });
});
