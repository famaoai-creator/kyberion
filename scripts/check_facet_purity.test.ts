import { describe, expect, it } from 'vitest';
import { checkFacetPurity } from './check_facet_purity.js';

describe('facet purity checker', () => {
  it('keeps all governed facet documents free of cross-kind content', () => {
    expect(checkFacetPurity()).toEqual([]);
  });
});
