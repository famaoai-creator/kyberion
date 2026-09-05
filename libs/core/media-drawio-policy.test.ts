import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import {
  loadMediaDrawioPolicyCatalog,
  resolveMediaDrawioBoundaryPalette,
  resolveMediaDrawioNodeSize,
} from './media-drawio-policy.js';

describe('media-drawio-policy', () => {
  it('uses the canonical catalog without a duplicated fallback definition', () => {
    const source = safeReadFile(pathResolver.rootResolve('libs/core/media-drawio-policy.ts'), {
      encoding: 'utf8',
    }) as string;
    expect(source).not.toContain('FALLBACK_');
    expect(source).not.toContain('fallback:');
    expect(source).not.toContain('recordConfigFallback');
  });

  it('resolves boundary palettes and node sizes from the catalog', () => {
    const catalog = loadMediaDrawioPolicyCatalog();

    expect(catalog.boundary_palettes.length).toBeGreaterThan(0);
    expect(
      resolveMediaDrawioBoundaryPalette({
        boundary: 'account',
        type: 'aws_account',
        fallbackFill: '#000000',
        fallbackStroke: '#ffffff',
      })
    ).toEqual({ fill: '#F8FAFC', stroke: '#0F172A' });
    expect(resolveMediaDrawioNodeSize({ type: 'terraform_module' })).toEqual({
      width: 196,
      height: 112,
    });
    expect(resolveMediaDrawioNodeSize({ tier: 'security' })).toEqual({ width: 80, height: 80 });
  });
});
