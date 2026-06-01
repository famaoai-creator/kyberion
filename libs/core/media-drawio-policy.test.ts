import { describe, expect, it } from 'vitest';
import {
  loadMediaDrawioPolicyCatalog,
  resolveMediaDrawioBoundaryPalette,
  resolveMediaDrawioNodeSize,
} from './media-drawio-policy.js';

describe('media-drawio-policy', () => {
  it('resolves boundary palettes and node sizes from the catalog', () => {
    const catalog = loadMediaDrawioPolicyCatalog();

    expect(catalog.boundary_palettes.length).toBeGreaterThan(0);
    expect(resolveMediaDrawioBoundaryPalette({
      boundary: 'account',
      type: 'aws_account',
      fallbackFill: '#000000',
      fallbackStroke: '#ffffff',
    })).toEqual({ fill: '#F8FAFC', stroke: '#0F172A' });
    expect(resolveMediaDrawioNodeSize({ type: 'terraform_module' })).toEqual({ width: 196, height: 112 });
    expect(resolveMediaDrawioNodeSize({ tier: 'security' })).toEqual({ width: 80, height: 80 });
  });
});
