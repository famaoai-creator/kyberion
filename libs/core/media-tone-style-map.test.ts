import { describe, expect, it } from 'vitest';
import { loadMediaToneStyleMapCatalog, resolveMediaToneStyle } from './media-tone-style-map.js';

describe('media-tone-style-map', () => {
  it('resolves tones from the knowledge catalog', () => {
    const catalog = loadMediaToneStyleMapCatalog();

    expect(catalog.tones.length).toBeGreaterThan(0);
    expect(resolveMediaToneStyle('success')).toBe('success');
    expect(resolveMediaToneStyle('warning')).toBe('warning');
    expect(resolveMediaToneStyle('unknown')).toBe('info');
  });
});
