import { describe, expect, it } from 'vitest';

import baseThemeCatalog from '../../knowledge/public/design-patterns/media-templates/themes.json';
import importedThemeCatalog from '../../knowledge/public/design-patterns/media-templates/themes/design-md-imports.json';
import defaultTheme from '../../knowledge/public/design-patterns/media-templates/themes/default-theme.json';
import baseDesignSystemCatalog from '../../knowledge/public/design-patterns/media-templates/media-design-systems.json';
import importedDesignSystemCatalog from '../../knowledge/public/design-patterns/media-templates/media-design-systems/design-md-imports.json';
import defaultDesignSystem from '../../knowledge/public/design-patterns/media-templates/media-design-systems/default-system.json';

type ThemeEntry = {
  name?: string;
  colors?: Record<string, string>;
  fonts?: Record<string, string>;
  assets?: Record<string, string>;
};

function expectThemeShape(themeId: string, theme: ThemeEntry): void {
  expect(theme, `missing theme entry for ${themeId}`).toBeTruthy();
  expect(theme.name, `missing name for ${themeId}`).toBeTruthy();
  expect(theme.colors, `missing colors for ${themeId}`).toBeTruthy();
  expect(theme.fonts, `missing fonts for ${themeId}`).toBeTruthy();

  const colors = theme.colors || {};
  for (const key of ['primary', 'secondary', 'accent', 'background', 'text']) {
    expect(colors[key], `missing ${key} color for ${themeId}`).toBeTruthy();
  }

  const fonts = theme.fonts || {};
  for (const key of ['heading', 'body']) {
    expect(fonts[key], `missing ${key} font for ${themeId}`).toBeTruthy();
  }
}

function collectThemeIds(catalog: { themes?: Record<string, ThemeEntry> }): Set<string> {
  return new Set(Object.keys(catalog.themes || {}));
}

describe('theme registry', () => {
  it('keeps the native theme catalog complete enough for renderer use', () => {
    const themes = baseThemeCatalog.themes || {};
    expect(defaultTheme.default_theme).toBe('kyberion-standard');
    expect(themes[defaultTheme.default_theme]).toBeTruthy();

    for (const [themeId, theme] of Object.entries(themes)) {
      expectThemeShape(themeId, theme);
    }
  });

  it('keeps imported DESIGN.md themes complete enough for renderer use', () => {
    const themes = importedThemeCatalog.themes || {};
    expect(themes['designmd-claude']).toBeTruthy();

    for (const [themeId, theme] of Object.entries(themes)) {
      expectThemeShape(themeId, theme);
    }
  });

  it('keeps design-system theme references aligned with known themes', () => {
    const knownThemes = new Set([
      ...collectThemeIds(baseThemeCatalog),
      ...collectThemeIds(importedThemeCatalog),
    ]);

    const assertThemeReference = (scope: string, themeId: string | undefined) => {
      if (!themeId) return;
      expect(knownThemes.has(themeId), `${scope} references unknown theme ${themeId}`).toBe(true);
    };

    expect(defaultDesignSystem.default_system).toBe('executive-standard');
    expect(baseDesignSystemCatalog.systems?.[defaultDesignSystem.default_system]).toBeTruthy();

    for (const [systemId, system] of Object.entries(baseDesignSystemCatalog.systems || {})) {
      assertThemeReference(`media-design-systems:${systemId}`, (system as { theme?: string }).theme);
      const tenantOverrides = (system as { tenant_overrides?: Record<string, { theme?: string }> }).tenant_overrides || {};
      for (const [tenantId, tenantOverride] of Object.entries(tenantOverrides)) {
        assertThemeReference(`media-design-systems:${systemId}:tenant:${tenantId}`, tenantOverride.theme);
      }
    }

    for (const [systemId, system] of Object.entries(importedDesignSystemCatalog.systems || {})) {
      assertThemeReference(`media-design-systems/imports:${systemId}`, (system as { theme?: string }).theme);
    }
  });
});
