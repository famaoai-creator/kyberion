import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeReadFile } from './secure-io.js';
import { loadMediaToneStyleMapCatalog, resolveMediaToneStyle } from './media-tone-style-map.js';

describe('media-tone-style-map', () => {
  it('uses the canonical catalog without a duplicated fallback map', () => {
    const source = safeReadFile(pathResolver.rootResolve('libs/core/media-tone-style-map.ts'), {
      encoding: 'utf8',
    }) as string;
    expect(source).not.toContain('FALLBACK_MAP');
    expect(source).not.toContain('fallback:');
  });

  it('resolves tones from the knowledge catalog', () => {
    const catalog = loadMediaToneStyleMapCatalog();

    expect(catalog.tones.length).toBeGreaterThan(0);
    expect(resolveMediaToneStyle('success')).toBe('success');
    expect(resolveMediaToneStyle('warning')).toBe('warning');
    expect(resolveMediaToneStyle('unknown')).toBe('info');
  });
});
