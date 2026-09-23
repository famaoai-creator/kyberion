import { KB_STATUS_TONES, type KbStatusTone } from '@agent/core/a2ui-catalog';
import {
  loadBrandTokensAtPath,
  type BrandTokenColors,
  type BrandTokenFonts,
  type BrandTokens,
  type BrandUiPalette,
  type BrandUiTokens,
} from '@agent/core/brand-tokens';
import { isRecord, parseSafeJsonInput } from '@agent/core/foundation';

export type KyberionDesignTokens = BrandTokens;
export type KyberionColorTokens = BrandTokenColors;
export type KyberionFontTokens = BrandTokenFonts;

export interface KyberionThemeEntry {
  name: string;
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    accent_text?: string;
    surface?: string;
    muted_text?: string;
    border?: string;
    success?: string;
    warning?: string;
    danger?: string;
  };
  fonts: {
    heading: string;
    body: string;
  };
  assets?: {
    logo_url?: string;
  };
}

export function readKyberionDesignTokens(): KyberionDesignTokens {
  return loadBrandTokensAtPath();
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
    `  --kb-accent-text: ${light.accent_text || light.accent};`,
    `  --kb-surface: ${light.surface || light.panel_bg};`,
    `  --kb-muted-text: ${light.muted_text || light.text_secondary};`,
    `  --kb-border: ${light.border || light.secondary};`,
    `  --kb-success: ${light.success || light.accent};`,
    `  --kb-danger: ${light.danger || light.warning};`,
    `  --kb-font-sans: ${fonts.sans};`,
    `  --kb-font-mono: ${fonts.mono};`,
    '  --kb-blur: blur(12px);',
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
    `    --kb-accent-text: ${dark.accent_text || dark.accent};`,
    `    --kb-surface: ${dark.surface || dark.panel_bg};`,
    `    --kb-muted-text: ${dark.muted_text || dark.text_secondary};`,
    `    --kb-border: ${dark.border || dark.secondary};`,
    `    --kb-success: ${dark.success || dark.accent};`,
    `    --kb-danger: ${dark.danger || dark.warning};`,
    '  }',
    '}',
    '',
    "[data-theme='light'] {",
    '  color-scheme: light;',
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
    `  --kb-accent-text: ${light.accent_text || light.accent};`,
    `  --kb-surface: ${light.surface || light.panel_bg};`,
    `  --kb-muted-text: ${light.muted_text || light.text_secondary};`,
    `  --kb-border: ${light.border || light.secondary};`,
    `  --kb-success: ${light.success || light.accent};`,
    `  --kb-danger: ${light.danger || light.warning};`,
    '}',
    '',
    "[data-theme='dark'] {",
    '  color-scheme: dark;',
    `  --background: ${dark.bg_main};`,
    `  --foreground: ${dark.text_primary};`,
    `  --kb-bg-main: ${dark.bg_main};`,
    `  --kb-panel-bg: ${dark.panel_bg};`,
    `  --kb-primary: ${dark.primary};`,
    `  --kb-secondary: ${dark.secondary};`,
    `  --kb-accent: ${dark.accent};`,
    `  --kb-warning: ${dark.warning};`,
    `  --kb-text-primary: ${dark.text_primary};`,
    `  --kb-text-secondary: ${dark.text_secondary};`,
    `  --kb-accent-text: ${dark.accent_text || dark.accent};`,
    `  --kb-surface: ${dark.surface || dark.panel_bg};`,
    `  --kb-muted-text: ${dark.muted_text || dark.text_secondary};`,
    `  --kb-border: ${dark.border || dark.secondary};`,
    `  --kb-success: ${dark.success || dark.accent};`,
    `  --kb-danger: ${dark.danger || dark.warning};`,
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
    '          accent_text: "var(--kb-accent-text)",',
    '          surface: "var(--kb-surface)",',
    '          muted_text: "var(--kb-muted-text)",',
    '          border: "var(--kb-border)",',
    '          success: "var(--kb-success)",',
    '          danger: "var(--kb-danger)",',
    '        }',
  ].join('\n');
}

function semanticColorEntries(palette: KyberionColorTokens): Partial<KyberionThemeEntry['colors']> {
  return {
    ...(palette.accent_text ? { accent_text: palette.accent_text } : {}),
    ...(palette.surface ? { surface: palette.surface } : {}),
    ...(palette.muted_text ? { muted_text: palette.muted_text } : {}),
    ...(palette.border ? { border: palette.border } : {}),
    ...(palette.success ? { success: palette.success } : {}),
    ...(palette.warning ? { warning: palette.warning } : {}),
    ...(palette.danger ? { danger: palette.danger } : {}),
  };
}

export function buildKyberionThemeEntries(
  tokens: KyberionDesignTokens
): Record<string, KyberionThemeEntry> {
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
        ...semanticColorEntries(light),
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
        ...semanticColorEntries(dark),
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
  const parsed = parseSafeJsonInput(rawText, 'themes.json');
  if (!isRecord(parsed)) throw new Error('themes.json root must be a JSON object');
  const data = parsed;
  const themes = buildKyberionThemeEntries(tokens);
  data.themes = {
    ...(isRecord(data.themes) ? data.themes : {}),
    ...themes,
  };
  if (options?.includeDefaultTheme && !data.default_theme) {
    data.default_theme = 'kyberion-standard';
  }
  return `${JSON.stringify(data, null, 2)}\n`;
}

export function expectedKyberionThemeEntries(
  tokens: KyberionDesignTokens
): Record<string, KyberionThemeEntry> {
  return buildKyberionThemeEntries(tokens);
}

export function replaceTokenBlock(sourceText: string, tokenBlock: string): string {
  const pattern =
    /:root\s*{\s*[\s\S]*?\n}\n\n@media\s*\(prefers-color-scheme:\s*dark\)\s*{\s*\n\s*:root\s*{\s*[\s\S]*?\n\s*}\n}(?:\n\n\[data-theme='light'\]\s*{[\s\S]*?\n}\n\n\[data-theme='dark'\]\s*{[\s\S]*?\n})?/m;
  if (!pattern.test(sourceText)) {
    throw new Error('Failed to locate Kyberion token block in source file');
  }
  return sourceText.replace(pattern, tokenBlock);
}

export function extractKyberionTokenBlock(sourceText: string): string | null {
  const pattern =
    /:root\s*{\s*[\s\S]*?\n}\n\n@media\s*\(prefers-color-scheme:\s*dark\)\s*{\s*\n\s*:root\s*{\s*[\s\S]*?\n\s*}\n}(?:\n\n\[data-theme='light'\]\s*{[\s\S]*?\n}\n\n\[data-theme='dark'\]\s*{[\s\S]*?\n})?/m;
  const match = sourceText.match(pattern);
  return match ? match[0] : null;
}

// ---------------------------------------------------------------------------
// UI-02: `tokens.ui` → `--kb-ui-*` variables + the `kyberion-ui.css` component
// stylesheet. The UI block lives between fixed marker comments so it can sit
// after the legacy token block (static token files, globals.css) or stand
// alone (concierge), and be replaced idempotently.
// ---------------------------------------------------------------------------

export const KB_UI_TOKEN_BLOCK_START =
  '/* kyberion-ui tokens: generated from tokens.ui by scripts/generate_design_tokens.ts - do not edit */';
export const KB_UI_TOKEN_BLOCK_END = '/* end kyberion-ui tokens */';

/** Authored component stylesheet; the generator stamps it into every surface. */
export const KYBERION_UI_STYLESHEET_SOURCE =
  'knowledge/public/design-patterns/web/kyberion-ui.source.css';
export const KB_UI_STATUS_TONES_PLACEHOLDER = '/* @kb-generated status-tones */';

const STATUS_TONE_ICONS: Record<KbStatusTone, string> = {
  success: '\\2713',
  info: '\\25CF',
  warning: '!',
  danger: '\\2715',
  neutral: '\\25CB',
};
const STATUS_TONE_ORDER: KbStatusTone[] = ['success', 'info', 'warning', 'danger', 'neutral'];

function requireUiTokens(tokens: KyberionDesignTokens): BrandUiTokens {
  const ui = tokens.tokens.ui;
  if (!ui) throw new Error('kyberion.json tokens.ui is missing; the UI token layer is required');
  return ui;
}

function uiPaletteDeclarations(
  palette: BrandUiPalette,
  scheme: 'light' | 'dark',
  indent: string
): string[] {
  const lines: string[] = [`${indent}--kb-ui-color-scheme: ${scheme};`];
  for (const [key, value] of Object.entries(palette)) {
    if (typeof value === 'string') lines.push(`${indent}--kb-ui-${key}: ${value};`);
  }
  for (const [status, triple] of Object.entries(palette.status)) {
    for (const [part, value] of Object.entries(triple)) {
      lines.push(`${indent}--kb-ui-${status}-${part}: ${value};`);
    }
  }
  for (const [role, value] of Object.entries(palette.role)) {
    lines.push(`${indent}--kb-ui-role-${role}: ${value};`);
  }
  for (const [size, value] of Object.entries(palette.shadow)) {
    lines.push(`${indent}--kb-ui-shadow-${size}: ${value};`);
  }
  return lines;
}

function fontScaleDeclarations(scale: Record<string, string>, indent: string): string[] {
  return Object.entries(scale).map(
    ([step, value]) => `${indent}--kb-ui-font-size-${step}: ${value};`
  );
}

export function renderKyberionUiTokenBlock(tokens: KyberionDesignTokens): string {
  const ui = requireUiTokens(tokens);
  const fonts = tokens.tokens.fonts;
  return [
    KB_UI_TOKEN_BLOCK_START,
    ':root {',
    ...uiPaletteDeclarations(ui.light, 'light', '  '),
    ...Object.entries(ui.radius).map(([size, value]) => `  --kb-ui-radius-${size}: ${value};`),
    ...Object.entries(ui.space).map(([step, value]) => `  --kb-ui-space-${step}: ${value};`),
    `  --kb-ui-font-sans: ${fonts.sans};`,
    `  --kb-ui-font-mono: ${fonts.mono};`,
    ...fontScaleDeclarations(ui.font_size.comfortable, '  '),
    '}',
    '',
    '[data-density="comfortable"] {',
    ...fontScaleDeclarations(ui.font_size.comfortable, '  '),
    '}',
    '',
    '[data-density="compact"] {',
    ...fontScaleDeclarations(ui.font_size.compact, '  '),
    '}',
    '',
    '@media (prefers-color-scheme: dark) {',
    '  :root:not([data-theme="light"]) {',
    ...uiPaletteDeclarations(ui.dark, 'dark', '    '),
    '  }',
    '}',
    '',
    ':root[data-theme="dark"] {',
    ...uiPaletteDeclarations(ui.dark, 'dark', '  '),
    '}',
    KB_UI_TOKEN_BLOCK_END,
  ].join('\n');
}

function uiTokenBlockRange(sourceText: string): [number, number] | null {
  const start = sourceText.indexOf(KB_UI_TOKEN_BLOCK_START);
  if (start < 0) return null;
  const end = sourceText.indexOf(KB_UI_TOKEN_BLOCK_END, start);
  if (end < 0) throw new Error('Kyberion UI token block is missing its end marker');
  return [start, end + KB_UI_TOKEN_BLOCK_END.length];
}

export function extractKyberionUiTokenBlock(sourceText: string): string | null {
  const range = uiTokenBlockRange(sourceText);
  return range ? sourceText.slice(range[0], range[1]) : null;
}

/**
 * Replace the UI token block in place, or insert it directly after the legacy
 * Kyberion token block when the file does not carry one yet.
 */
export function replaceUiTokenBlock(sourceText: string, uiBlock: string): string {
  const range = uiTokenBlockRange(sourceText);
  if (range) return `${sourceText.slice(0, range[0])}${uiBlock}${sourceText.slice(range[1])}`;
  const legacy = extractKyberionTokenBlock(sourceText);
  if (legacy === null) {
    throw new Error('Failed to locate Kyberion token block to anchor the UI token block');
  }
  const at = sourceText.indexOf(legacy) + legacy.length;
  return `${sourceText.slice(0, at)}\n\n${uiBlock}${sourceText.slice(at)}`;
}

/** Status-pill tone rules, generated from the catalog's status → tone map. */
export function renderStatusToneRules(): string {
  const byTone = new Map<KbStatusTone, string[]>(STATUS_TONE_ORDER.map((tone) => [tone, []]));
  for (const [status, tone] of Object.entries(KB_STATUS_TONES) as [string, KbStatusTone][]) {
    byTone.get(tone)?.push(status);
  }
  return STATUS_TONE_ORDER.map((tone) => {
    const selectors = [
      `.kb-status-pill[data-tone="${tone}"]`,
      ...(byTone.get(tone) || [])
        .sort()
        .map((status) => `.kb-status-pill[data-status="${status}"]`),
    ];
    const colors =
      tone === 'neutral'
        ? [
            '  --kb-ui-pill-fg: var(--kb-ui-text-muted);',
            '  --kb-ui-pill-bg: var(--kb-ui-surface-sunken);',
            '  --kb-ui-pill-border: var(--kb-ui-border);',
          ]
        : [
            `  --kb-ui-pill-fg: var(--kb-ui-${tone}-fg);`,
            `  --kb-ui-pill-bg: var(--kb-ui-${tone}-bg);`,
            `  --kb-ui-pill-border: var(--kb-ui-${tone}-border);`,
          ];
    return [
      `${selectors.join(',\n')} {`,
      ...colors,
      `  --kb-ui-pill-icon: "${STATUS_TONE_ICONS[tone]}";`,
      '}',
    ].join('\n');
  }).join('\n\n');
}

/** Assemble the generated `kyberion-ui.css` from the authored source stylesheet. */
export function renderKyberionUiStylesheet(sourceCss: string): string {
  if (!sourceCss.includes(KB_UI_STATUS_TONES_PLACEHOLDER)) {
    throw new Error(
      `${KYBERION_UI_STYLESHEET_SOURCE} must contain ${KB_UI_STATUS_TONES_PLACEHOLDER}`
    );
  }
  const header = [
    `/* GENERATED by scripts/generate_design_tokens.ts from ${KYBERION_UI_STYLESHEET_SOURCE}.`,
    ' * Do not edit: change the source stylesheet or tokens.ui in kyberion.json and regenerate. */',
    '',
  ].join('\n');
  const body = sourceCss.replace(KB_UI_STATUS_TONES_PLACEHOLDER, renderStatusToneRules());
  return `${header}${body.trimEnd()}\n`;
}
