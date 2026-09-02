import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import { loadSlideLayoutPresetCatalog } from './media-layout-catalog.js';

describe('media slide layout catalog boundary', () => {
  it('validates the merged preset envelope through the governed catalog boundary', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-layout-catalog.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain("id: 'slide-layout-presets'");
    expect(source).toContain('knowledge/product/schemas/slide-layout-presets.schema.json');
    expect(source).toContain('return catalog.validate(merged, directoryPath);');

    const catalog = loadSlideLayoutPresetCatalog(pathResolver.rootDir());
    expect(catalog.version).toBe('1.1.0');
    expect(catalog.defaults['title-body']).toBeDefined();
    expect(catalog.presets['title-body']).toBeDefined();
    expect(catalog.body_zones.single_column).toBeDefined();
  });
});
