import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import { loadThemeCatalog } from './media-design-protocol.js';

describe('media theme catalog boundary', () => {
  it('validates each scope and the final theme merge', () => {
    const source = String(
      safeReadFile(
        pathResolver.rootResolve('libs/actuators/media-actuator/src/media-design-protocol.ts'),
        { encoding: 'utf8' }
      )
    );

    expect(source).toContain("'media-themes-public'");
    expect(source).toContain("'media-themes-runtime'");
    expect(source).toContain("'media-themes-personal'");
    expect(source).toContain("id: 'media-themes'");
    expect(source).toContain('knowledge/product/schemas/media-themes.schema.json');
    expect(source).toContain("'media theme scope merge'");

    const catalog = loadThemeCatalog(pathResolver.rootDir());
    expect(catalog.default_theme).toBe('kyberion-standard');
    expect(catalog.themes['kyberion-standard']).toBeDefined();
  });
});
