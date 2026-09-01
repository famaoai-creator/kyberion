#!/usr/bin/env node

import {
  createChronosWebThemePack,
  createCompanionWebThemePack,
  createConciergeWebThemePack,
  webThemePackToCssVars,
  type WebThemePack,
} from '@agent/core/web-design-system';
import { pathResolver } from '@agent/core/path-resolver';
import { readJson } from '@agent/core/foundation';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Palette = Record<string, string>;

type ContrastPair = {
  background: string;
  foreground: string;
  minRatio: number;
  label: string;
};

function parseJson<T>(filePath: string): T {
  return readJson<T>(filePath);
}

function normalizeHex(value: string): string | null {
  const normalized = String(value || '').trim();
  const hex = normalized.startsWith('#') ? normalized.slice(1) : normalized;
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    return hex
      .split('')
      .map((part) => `${part}${part}`)
      .join('')
      .toUpperCase();
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) return hex.toUpperCase();
  return null;
}

function parseRgba(value: string): [number, number, number, number] | null {
  const normalized = String(value || '').trim();
  const hex = normalizeHex(normalized);
  if (hex) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
      1,
    ];
  }
  const match = normalized.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)/i);
  if (!match) return null;
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
    match[4] !== undefined ? Number(match[4]) : 1,
  ];
}

function blendOver(
  foreground: [number, number, number, number],
  background: [number, number, number, number]
): [number, number, number] {
  const alpha = foreground[3] + background[3] * (1 - foreground[3]);
  if (alpha === 0) return [0, 0, 0];
  const r =
    (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha;
  const g =
    (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha;
  const b =
    (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha;
  return [r, g, b];
}

function opaqueRgb(value: string, base?: string): [number, number, number] {
  const rgba = parseRgba(value);
  if (!rgba) throw new Error(`Unsupported color value: ${value}`);
  if (rgba[3] >= 1) return [rgba[0], rgba[1], rgba[2]];
  const baseRgba = (base ? parseRgba(base) : [255, 255, 255, 1]) as
    [number, number, number, number] | null;
  if (!baseRgba) throw new Error(`Unsupported base color value: ${base}`);
  return blendOver(rgba, baseRgba);
}

function relativeLuminance(value: string, base?: string): number {
  const rgb = opaqueRgb(value, base);
  const [r, g, b] = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string, base?: string): number {
  const [l1, l2] = [relativeLuminance(a, base), relativeLuminance(b, base)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

function checkPalette(
  name: string,
  palette: Palette,
  pairs: ContrastPair[],
  backgrounds: Record<string, string> = {}
): string[] {
  const violations: string[] = [];
  for (const pair of pairs) {
    const background = palette[pair.background];
    const foreground = palette[pair.foreground];
    if (!background || !foreground) {
      violations.push(
        `[${name}] missing pair ${pair.label} (${pair.background} × ${pair.foreground})`
      );
      continue;
    }
    const ratio = contrastRatio(foreground, background, backgrounds[pair.background] ?? '#ffffff');
    if (ratio < pair.minRatio) {
      violations.push(
        `[${name}] ${pair.label} contrast ${ratio.toFixed(2)} < ${pair.minRatio} (${pair.background} × ${pair.foreground})`
      );
    }
  }
  return violations;
}

/**
 * The static token files below are hand-authored, so they were the only thing
 * this check covered. But every web surface renders from `--kb-*` vars that are
 * DERIVED from a theme pack at runtime, and that derivation is where the
 * readability regressions actually happen: `--kb-panel-bg` used to be
 * `primary @ 0.82` for every theme, which made light themes paint dark text on
 * a dark panel (contrast 1.0) while the static files stayed innocent. Check the
 * derived output too, for every pack a surface can serve.
 */
function checkDerivedWebThemePacks(): string[] {
  const packs: Array<[string, WebThemePack]> = [
    ['web.chronos-dark', createChronosWebThemePack('dark')],
    ['web.chronos-light', createChronosWebThemePack('light')],
    ['web.concierge', createConciergeWebThemePack()],
    ['web.companion', createCompanionWebThemePack()],
  ];

  const pairs: ContrastPair[] = [
    { label: 'body text', background: 'bg_main', foreground: 'text_primary', minRatio: 4.5 },
    { label: 'secondary text', background: 'bg_main', foreground: 'text_secondary', minRatio: 4.5 },
    { label: 'panel text', background: 'panel_bg', foreground: 'text_primary', minRatio: 4.5 },
    {
      label: 'panel secondary',
      background: 'panel_bg',
      foreground: 'text_secondary',
      minRatio: 4.5,
    },
  ];

  const violations: string[] = [];
  for (const [name, pack] of packs) {
    const cssVars = webThemePackToCssVars(pack);
    const palette: Palette = {
      bg_main: cssVars['--kb-bg-main'],
      panel_bg: cssVars['--kb-panel-bg'],
      text_primary: cssVars['--kb-text-primary'],
      text_secondary: cssVars['--kb-text-secondary'],
    };
    // A translucent panel resolves against the page background, so blend it
    // there rather than against the checker's default white.
    violations.push(
      ...checkPalette(name, palette, pairs, {
        bg_main: cssVars['--kb-bg-main'],
        panel_bg: cssVars['--kb-bg-main'],
      })
    );
    // `--kb-border` is consumed everywhere as `1px solid var(--kb-border)`, so
    // emitting a full `border` shorthand here silently invalidates it.
    if (/\bsolid\b/.test(cssVars['--kb-border'] || '')) {
      violations.push(
        `[${name}] --kb-border must be a color, not a border shorthand (got "${cssVars['--kb-border']}")`
      );
    }
  }
  return violations;
}

export function checkDesignContrast(): string[] {
  const brandTokens = parseJson<{ tokens: { colors: { light: Palette; dark: Palette } } }>(
    pathResolver.rootResolve('knowledge/public/design-patterns/brand-tokens/kyberion.json')
  );
  const themes = parseJson<{ default_theme: string; themes: Record<string, { colors: Palette }> }>(
    pathResolver.rootResolve('knowledge/public/design-patterns/media-templates/themes.json')
  );

  const pairs: ContrastPair[] = [
    { label: 'body text', background: 'bg_main', foreground: 'text_primary', minRatio: 4.5 },
    { label: 'secondary text', background: 'bg_main', foreground: 'text_secondary', minRatio: 4.5 },
    { label: 'panel text', background: 'panel_bg', foreground: 'text_primary', minRatio: 4.5 },
    {
      label: 'panel secondary',
      background: 'panel_bg',
      foreground: 'text_secondary',
      minRatio: 4.5,
    },
  ];

  const violations = [
    ...checkPalette('brand.light', brandTokens.tokens.colors.light, pairs, {
      bg_main: brandTokens.tokens.colors.light.bg_main,
      panel_bg: brandTokens.tokens.colors.light.bg_main,
    }),
    ...checkPalette('brand.dark', brandTokens.tokens.colors.dark, pairs, {
      bg_main: brandTokens.tokens.colors.dark.bg_main,
      panel_bg: brandTokens.tokens.colors.dark.bg_main,
    }),
    ...Object.entries(themes.themes).flatMap(([themeId, theme]) => {
      const colors = theme.colors;
      const pairsForTheme: ContrastPair[] = [
        { label: 'theme body', background: 'background', foreground: 'text', minRatio: 4.5 },
        // accent-colored text must be readable: accent_text when provided,
        // otherwise the raw accent is assumed to be used for text.
        {
          label: 'theme accent text',
          background: 'background',
          foreground: colors.accent_text ? 'accent_text' : 'accent',
          minRatio: colors.accent_text ? 4.5 : 3,
        },
        ...(colors.surface
          ? [
              {
                label: 'theme surface body',
                background: 'surface',
                foreground: 'text',
                minRatio: 4.5,
              },
            ]
          : []),
        ...(colors.muted_text
          ? [
              {
                label: 'theme muted text',
                background: 'background',
                foreground: 'muted_text',
                minRatio: 4.5,
              },
            ]
          : []),
      ];
      return checkPalette(`theme.${themeId}`, colors, pairsForTheme);
    }),
    ...checkDerivedWebThemePacks(),
  ];

  return violations;
}

export const runCheckDesignContrast = defineScript({
  name: 'check:design-contrast',
  flags: [],
  run(context) {
    const violations = checkDesignContrast();
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['violations detected:', ...violations.map((violation) => `- ${violation}`)].join('\n')
      );
    }
    context.print('[check:design-contrast] OK');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_design_contrast.ts') ||
  isDirectScript(import.meta.url, 'check_design_contrast.js')
)
  void runCheckDesignContrast();
