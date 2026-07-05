import * as path from 'node:path';
import { pathResolver, safeReadFile } from '@agent/core';

export interface KyberionDesignTokens {
  version: string;
  brand_name: string;
  tokens: {
    colors: {
      light: KyberionColorTokens;
      dark: KyberionColorTokens;
    };
    fonts: KyberionFontTokens;
  };
}

export interface KyberionColorTokens {
  bg_main: string;
  panel_bg: string;
  primary: string;
  secondary: string;
  accent: string;
  warning: string;
  text_primary: string;
  text_secondary: string;
}

export interface KyberionFontTokens {
  sans: string;
  mono: string;
}

export interface KyberionThemeEntry {
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
  };
  fonts: {
    heading: string;
    body: string;
  };
  assets?: {
    logo_url?: string;
  };
}

const BRAND_TOKENS_PATH = pathResolver.rootResolve(
  'knowledge/public/design-patterns/brand-tokens/kyberion.json'
);

export function readKyberionDesignTokens(): KyberionDesignTokens {
  return JSON.parse(safeReadFile(BRAND_TOKENS_PATH, { encoding: 'utf8' }) as string) as KyberionDesignTokens;
}

export function renderKyberionDesignTokenBlock(tokens: KyberionDesignTokens): string {
  const light = tokens.tokens.colors.light;
  const dark = tokens.tokens.colors.dark;
  const fonts = tokens.tokens.fonts;
  return [
    ':root {',
    `  --background: ${light.bg_main};`,
    `  --foreground: ${light.text_primary};`,
    `  --kb-bg-main: ${light.bg_main};`,
    `  --kb-panel-bg: ${light.panel_bg};`,
    `  --kb-primary: ${light.primary};`,
    `  --kb-secondary: ${light.secondary};`,
    `  --kb-accent: ${light.accent};`,
    `  --kb-warning: ${light.warning};`,
    `  --kb-text-primary: ${light.text_primary};`,
    `  --kb-text-secondary: ${light.text_secondary};`,
    `  --kb-font-sans: ${fonts.sans};`,
    `  --kb-font-mono: ${fonts.mono};`,
    '  --kb-blur: blur(12px);',
    '  --kb-border: 1px solid rgba(148, 163, 184, 0.1);',
    '  --kb-glow-cyan: 0 0 15px rgba(0, 242, 255, 0.4);',
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root {',
    `    --background: ${dark.bg_main};`,
    `    --foreground: ${dark.text_primary};`,
    `    --kb-bg-main: ${dark.bg_main};`,
    `    --kb-panel-bg: ${dark.panel_bg};`,
    `    --kb-primary: ${dark.primary};`,
    `    --kb-secondary: ${dark.secondary};`,
    `    --kb-accent: ${dark.accent};`,
    `    --kb-warning: ${dark.warning};`,
    `    --kb-text-primary: ${dark.text_primary};`,
    `    --kb-text-secondary: ${dark.text_secondary};`,
    '  }',
    '}',
  ].join('\n');
}

export function renderKyberionTailwindColorsBlock(): string {
  return [
    '        kyberion: {',
    '          bg_main: "var(--kb-bg-main)",',
    '          panel_bg: "var(--kb-panel-bg)",',
    '          primary: "var(--kb-primary)",',
    '          secondary: "var(--kb-secondary)",',
    '          accent: "var(--kb-accent)",',
    '          warning: "var(--kb-warning)",',
    '          text_primary: "var(--kb-text-primary)",',
    '          text_secondary: "var(--kb-text-secondary)",',
    '        }',
  ].join('\n');
}

export function buildKyberionThemeEntries(tokens: KyberionDesignTokens): Record<string, KyberionThemeEntry> {
  const light = tokens.tokens.colors.light;
  const dark = tokens.tokens.colors.dark;
  const fonts = tokens.tokens.fonts;
  const sharedFonts = {
    heading: fonts.sans,
    body: fonts.sans,
  };

  return {
    'kyberion-standard': {
      name: 'Kyberion Standard',
      colors: {
        primary: light.primary,
        secondary: light.secondary,
        accent: light.accent,
        background: light.bg_main,
        text: light.text_primary,
      },
      fonts: sharedFonts,
      assets: {
        logo_url: '/assets/logos/kyberion-logo.png',
      },
    },
    'kyberion-sovereign': {
      name: 'Kyberion Sovereign',
      colors: {
        primary: dark.primary,
        secondary: dark.secondary,
        accent: dark.accent,
        background: dark.bg_main,
        text: dark.text_primary,
      },
      fonts: sharedFonts,
    },
  };
}

export function updateThemesJson(
  rawText: string,
  tokens: KyberionDesignTokens,
  options?: { includeDefaultTheme?: boolean }
): string {
  const data = JSON.parse(rawText) as Record<string, unknown>;
  const themes = buildKyberionThemeEntries(tokens);
  data.themes = {
    ...(typeof data.themes === 'object' && data.themes ? (data.themes as Record<string, unknown>) : {}),
    ...themes,
  };
  if (options?.includeDefaultTheme && !data.default_theme) {
    data.default_theme = 'kyberion-standard';
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function expectedKyberionThemeEntries(tokens: KyberionDesignTokens): Record<string, KyberionThemeEntry> {
  return buildKyberionThemeEntries(tokens);
}

export function replaceTokenBlock(sourceText: string, tokenBlock: string): string {
  const pattern =
    /:root\s*{\s*[\s\S]*?\n}\n\n@media\s*\(prefers-color-scheme:\s*dark\)\s*{\s*\n\s*:root\s*{\s*[\s\S]*?\n\s*}\n}/m;
  if (!pattern.test(sourceText)) {
    throw new Error('Failed to locate Kyberion token block in source file');
  }
  return sourceText.replace(pattern, tokenBlock);
}

export function extractKyberionTokenBlock(sourceText: string): string | null {
  const pattern =
    /:root\s*{\s*[\s\S]*?\n}\n\n@media\s*\(prefers-color-scheme:\s*dark\)\s*{\s*\n\s*:root\s*{\s*[\s\S]*?\n\s*}\n}/m;
  const match = sourceText.match(pattern);
  return match ? match[0] : null;
}
