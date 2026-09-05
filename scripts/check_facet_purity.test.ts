import { describe, expect, it } from 'vitest';
import { pathResolver, safeReadFile } from '@agent/core';
import { checkFacetPurity } from './check_facet_purity.js';

describe('facet purity checker', () => {
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
