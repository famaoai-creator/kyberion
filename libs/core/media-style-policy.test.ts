import { describe, expect, it } from 'vitest';
import {
  loadMediaStylePolicyCatalog,
  resolveBorderKeySides,
  resolveSignalToneRank,
} from './media-style-policy.js';

describe('media-style-policy', () => {
  it('resolves tone ranks and border key sides', () => {
    const catalog = loadMediaStylePolicyCatalog();

    expect(catalog.border_key_sides.length).toBe(4);
    expect(resolveSignalToneRank('danger')).toBe(0);
    expect(resolveSignalToneRank('success')).toBe(3);
    expect(resolveBorderKeySides('TL')).toEqual(['top', 'left']);
  });
});
