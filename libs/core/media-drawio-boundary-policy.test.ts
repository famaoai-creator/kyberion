import { describe, expect, it } from 'vitest';
import {
  loadMediaDrawioBoundaryPolicyCatalog,
  resolveDrawioBoundaryIconCandidates,
  resolveDrawioBoundaryPaletteOverride,
} from './media-drawio-boundary-policy.js';

describe('media-drawio-boundary-policy', () => {
  it('resolves boundary palettes and icon candidates from knowledge', () => {
    const catalog = loadMediaDrawioBoundaryPolicyCatalog();

    expect(catalog.palette_overrides.length).toBeGreaterThan(0);
    expect(resolveDrawioBoundaryPaletteOverride({ boundary: 'lane', tier: 'web' })).toEqual({
      fill: '#FFF7ED',
      stroke: '#EA580C',
    });
    expect(resolveDrawioBoundaryPaletteOverride({ boundary: 'subnet', name: 'public-subnet' })).toEqual({
      fill: '#ECFDF5',
      stroke: '#059669',
    });
    expect(resolveDrawioBoundaryIconCandidates({
      boundary: 'subnet',
      type: 'aws_subnet',
      name: 'public-subnet',
    })[0]).toContain('Public-subnet_32');
  });
});
