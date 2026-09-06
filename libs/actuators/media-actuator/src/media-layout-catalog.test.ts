import { afterEach, describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';

import {
  loadBodyZoneLayouts,
  loadLayoutTemplateCatalog,
  loadLayoutTemplateCatalogFromPath,
  loadSlideLayoutPresetCatalog,
} from './media-layout-catalog.js';

const fixturePath = pathResolver.sharedTmp('media-layout-template-catalog-test.json');

afterEach(() => {
  safeRmSync(fixturePath, { force: true });
});

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
    expect(source).toContain('const catalog = loadSlideLayoutPresetCatalog(rootDir);');
    expect(source).not.toContain('fallbackOnInvalid: true');
    expect(source).not.toContain('_cachedBzl = loadJsonValue(p);');
    expect(source).not.toContain('_cachedLayoutTemplates = loadJsonValue(p);');

    const catalog = loadSlideLayoutPresetCatalog(pathResolver.rootDir());
    expect(catalog.version).toBe('1.1.0');
    expect(catalog.defaults['title-body']).toBeDefined();
    expect(catalog.presets['title-body']).toBeDefined();
    expect(catalog.body_zones.single_column).toBeDefined();
    expect(loadBodyZoneLayouts(pathResolver.rootDir()).body_zones.single_column).toBeDefined();
    expect(loadLayoutTemplateCatalog(pathResolver.rootDir()).templates).toBeDefined();
  });

  it('validates a confidential layout catalog through the shared path loader', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-layout-catalog.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain('layout-template-catalog.schema.json');
    expect(source).toContain('loadLayoutTemplateCatalogFromPath');

    safeWriteFile(
      fixturePath,
      JSON.stringify({
        version: '1.0.0',
        default: 'tenant-extracted',
        templates: {
          'tenant-extracted': { chrome: { title_x: 0.35 } },
        },
      })
    );

    expect(loadLayoutTemplateCatalogFromPath(fixturePath)).toEqual(
      expect.objectContaining({
        default: 'tenant-extracted',
        templates: expect.objectContaining({ 'tenant-extracted': expect.any(Object) }),
      })
    );
  });
});
