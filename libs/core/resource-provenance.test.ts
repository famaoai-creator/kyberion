import { describe, expect, it } from 'vitest';
import { applyNarrowOnlyFilter } from './resource-provenance.js';
import { resolveFacets } from './facet-registry.js';

describe('PI-09 resource provenance', () => {
  it('supports exact removal and retain markers without widening', () => {
    expect(applyNarrowOnlyFilter(['a', 'b', 'c'], ['-b'])).toEqual({
      values: ['a', 'c'],
      removed: ['b'],
    });
    expect(applyNarrowOnlyFilter(['a', 'b', 'c'], ['+a', '!c'])).toEqual({
      values: ['a', 'b'],
      removed: ['c'],
    });
    expect(applyNarrowOnlyFilter(['a', 'b', 'c'], ['a', 'c'])).toEqual({
      values: ['a', 'c'],
      removed: [],
    });
  });

  it('rejects an overlay that introduces or re-adds a resource', () => {
    expect(() => applyNarrowOnlyFilter(['a'], ['+b'])).toThrow('RESOURCE_FILTER_WIDENED');
    expect(() => applyNarrowOnlyFilter(['a'], ['-b'])).toThrow('RESOURCE_FILTER_WIDENED');
  });

  it('attaches provenance to resolved facets', () => {
    const resolved = resolveFacets({ instructions: ['default'] }, { tier: 'public' });
    expect(resolved.instructions[0]?.provenance).toMatchObject({
      source: 'facet-registry',
      scope: 'repository',
      origin: 'builtin',
      trust: 'trusted',
    });
  });
});
