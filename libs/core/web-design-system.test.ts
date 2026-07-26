import path from 'node:path';
import AjvModule from 'ajv';
import * as addFormatsModule from 'ajv-formats';
import { compileSchemaFromPath, safeReadFile } from '@agent/core';
import { describe, expect, it } from 'vitest';

import {
  composeWebDesignSystem,
  createChronosWebThemePack,
  createCompanionWebThemePack,
  createConciergeWebThemePack,
  DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK,
  DEFAULT_CHRONOS_WEB_THEME_PACK,
  isDarkWebTheme,
  webThemePackToCssVars,
} from './web-design-system.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const addFormats = (addFormatsModule as any).default ?? addFormatsModule;

describe('web design system pack', () => {
  it('validates the example web design system pack', () => {
    const root = process.cwd();
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = compileSchemaFromPath(
      ajv,
      path.resolve(root, 'knowledge/product/schemas/web-design-system-pack.schema.json')
    );
    const example = JSON.parse(
      safeReadFile(
        path.resolve(root, 'knowledge/product/schemas/web-design-system-pack.example.json'),
        {
          encoding: 'utf8',
        }
      ) as string
    );

    expect(validate(example)).toBe(true);
  });

  it('composes the default chronos web theme and design system into css vars', () => {
    const resolved = composeWebDesignSystem(
      DEFAULT_CHRONOS_WEB_THEME_PACK,
      DEFAULT_CHRONOS_WEB_DESIGN_SYSTEM_PACK
    );

    expect(resolved.section_order[0]).toBe('hero');
    expect(resolved.section_patterns.some((entry) => entry.section_id === 'design-system')).toBe(
      true
    );
    expect(resolved.css_vars['--kb-bg-main']).toBe('#020617');
    expect(resolved.css_vars['--kb-panel-bg']).toContain('rgba(');
    expect(resolved.css_vars['--kb-container-max-width']).toBe('1440px');
    expect(resolved.css_vars['--kb-grid-columns']).toBe('12');
  });

  it('derives css vars directly from a theme pack', () => {
    const cssVars = webThemePackToCssVars(DEFAULT_CHRONOS_WEB_THEME_PACK);

    expect(cssVars['--kb-accent']).toBe('#00F2FF');
    expect(cssVars['--kb-font-sans']).toBe("Inter, 'Noto Sans JP', sans-serif");
  });

  it('classifies dark and light theme packs by ink-vs-page luminance', () => {
    expect(isDarkWebTheme(createChronosWebThemePack('dark'))).toBe(true);
    expect(isDarkWebTheme(createChronosWebThemePack('light'))).toBe(false);
    expect(isDarkWebTheme(createConciergeWebThemePack())).toBe(false);
    expect(isDarkWebTheme(createCompanionWebThemePack())).toBe(false);
  });

  it('veils light-theme panels with ink instead of painting them dark', () => {
    // Regression: --kb-panel-bg was `primary @ 0.82` for every theme. On light
    // packs `primary` IS the ink color, so panels rendered near-opaque dark
    // while --kb-text-primary stayed dark — headings measured 1.0:1 in the
    // browser. check:design-contrast now enforces the ratio; this pins the
    // shape of the derivation so the two can't drift apart silently.
    const dark = webThemePackToCssVars(createChronosWebThemePack('dark'));
    expect(dark['--kb-panel-bg']).toBe('rgba(10, 25, 47, 0.82)');

    for (const pack of [
      createChronosWebThemePack('light'),
      createConciergeWebThemePack(),
      createCompanionWebThemePack(),
    ]) {
      const cssVars = webThemePackToCssVars(pack);
      const alpha = Number(/rgba\([^)]*,\s*([0-9.]+)\)$/.exec(cssVars['--kb-panel-bg'])?.[1]);
      expect(alpha).toBeLessThanOrEqual(0.1);
    }
  });

  it('emits --kb-border as a color so `1px solid var(--kb-border)` stays valid', () => {
    // Every consumer in the tree (operator-surface inline styles, the static
    // design-tokens.css files, .kyberion-glass) writes the `1px solid` part
    // itself. Emitting the shorthand here invalidated those declarations.
    for (const pack of [
      createChronosWebThemePack('dark'),
      createChronosWebThemePack('light'),
      createConciergeWebThemePack(),
      createCompanionWebThemePack(),
    ]) {
      expect(webThemePackToCssVars(pack)['--kb-border']).toMatch(/^rgba\(/);
    }
  });
});
