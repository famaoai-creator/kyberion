import { describe, expect, it } from 'vitest';

import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

import {
  loadThemeCatalog,
  resolveThemeColorRole,
  resolveThemeHexColor,
  themeToDocxStyleHints,
  themeToPptxPalette,
} from './media-design-protocol.js';

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

    const theme = catalog.themes['kyberion-standard'];
    const palette = themeToPptxPalette(theme);
    expect(palette).toEqual(
      expect.objectContaining({ dk1: expect.any(String), accent1: expect.any(String) })
    );
    expect(themeToDocxStyleHints(theme).headingFont).toEqual(expect.any(String));
    expect(resolveThemeColorRole(palette, palette.accent1, 'accent')).toBe(palette.accent1);
    expect(resolveThemeHexColor(theme.colors, 'primary')).toEqual(expect.stringMatching(/^#/));
  });
});
