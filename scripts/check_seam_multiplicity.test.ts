import { describe, expect, it } from 'vitest';
import { checkSeamMultiplicity } from './check_seam_multiplicity.js';

describe('seam multiplicity checker', () => {
  it('keeps seam keys and provider multiplicity valid', () => {
    const result = checkSeamMultiplicity();
    expect(result.findings).toEqual([]);
    expect(result.seamCount).toBeGreaterThan(0);
  });
});
