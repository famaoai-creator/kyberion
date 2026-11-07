/**
 * Design QA — deterministic checks for visual deliverables.
 *
 * Philosophy rule 7 (deterministic first) applied to design: contrast,
 * token completeness, and palette sanity are computed, not eyeballed. LLM
 * design judgment stays for hierarchy/aesthetics; this module guards the
 * floor no artifact may sink below (WCAG 2.1 AA).
 *
 * Used by: theme catalog integrity tests, media/design actuator preflight,
 * and the designer-role review checklist
 * (knowledge/product/governance/working-philosophy.md).
 */

export interface ThemeColors {
  primary?: string;
  secondary?: string;
  accent?: string;
  background?: string;
  text?: string;
  /** Text-safe accent for body/link text when `accent` is decorative-only. */
  accent_text?: string;
  surface?: string;
  muted_text?: string;
  border?: string;
  success?: string;
  warning?: string;
  danger?: string;
}

export interface ThemeContrastIssue {
  pair: string;
  foreground: string;
  background: string;
  ratio: number;
  required: number;
  severity: 'must_fix' | 'suggestion';
  note: string;
}

const HEX_PATTERN = /^#?([0-9a-f]{6})$/i;

export function parseHexColor(value: string): { r: number; g: number; b: number } | null {
  const match = HEX_PATTERN.exec(String(value || '').trim());
  if (!match) return null;
  const hex = match[1];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(hex: string): number | null {
  const rgb = parseHexColor(hex);
  if (!rgb) return null;
  return (
    0.2126 * channelToLinear(rgb.r) +
    0.7152 * channelToLinear(rgb.g) +
    0.0722 * channelToLinear(rgb.b)
  );
}

/** WCAG 2.1 contrast ratio (1..21). Returns null on unparseable colors. */
export function contrastRatio(foreground: string, background: string): number | null {
  const fg = relativeLuminance(foreground);
  const bg = relativeLuminance(background);
  if (fg === null || bg === null) return null;
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}

export const WCAG_AA_BODY_TEXT = 4.5;
export const WCAG_AA_LARGE_TEXT = 3.0;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Validate one theme's palette against the AA floor.
 *
 * Must-fix pairs:
 *  - text / background ≥ 4.5 (body text)
 *  - text / surface ≥ 4.5 (when surface present)
 *  - accent_text (or accent when no accent_text) / background ≥ 4.5 —
 *    whatever renders accent-colored *text* must be readable
 * Suggestions:
 *  - accent / background ≥ 3.0 (large text / UI components); waived when the
 *    theme provides a text-safe accent_text, since accent is then decorative
 *  - muted_text / background ≥ 4.5
 */
export function validateThemeContrast(colors: ThemeColors): ThemeContrastIssue[] {
  const issues: ThemeContrastIssue[] = [];
  const background = colors.background;
  if (!background || !parseHexColor(background)) return issues;

  const check = (
    pair: string,
    foreground: string | undefined,
    over: string,
    required: number,
    severity: 'must_fix' | 'suggestion',
    note: string
  ) => {
    if (!foreground) return;
    const ratio = contrastRatio(foreground, over);
    if (ratio === null) return;
    if (ratio < required) {
      issues.push({
        pair,
        foreground,
        background: over,
        ratio: round2(ratio),
        required,
        severity,
        note,
      });
    }
  };

  check(
    'text/background',
    colors.text,
    background,
    WCAG_AA_BODY_TEXT,
    'must_fix',
    'body text must meet WCAG AA'
  );
  if (colors.surface && parseHexColor(colors.surface)) {
    check(
      'text/surface',
      colors.text,
      colors.surface,
      WCAG_AA_BODY_TEXT,
      'must_fix',
      'body text on cards/surfaces must meet WCAG AA'
    );
  }
  const textAccent = colors.accent_text || colors.accent;
  check(
    'accent_text/background',
    textAccent,
    background,
    WCAG_AA_BODY_TEXT,
    'must_fix',
    'accent-colored text (links, emphasis) must be readable; add a darker accent_text if the brand accent is decorative'
  );
  if (!colors.accent_text) {
    check(
      'accent/background',
      colors.accent,
      background,
      WCAG_AA_LARGE_TEXT,
      'suggestion',
      'accent used for large text / UI components should reach 3:1, or provide accent_text'
    );
  }
  check(
    'muted_text/background',
    colors.muted_text,
    background,
    WCAG_AA_BODY_TEXT,
    'suggestion',
    'muted text is still text — prefer AA-compliant muted tones'
  );
  return issues;
}

export interface ThemeCatalogReport {
  themes_checked: number;
  must_fix: Array<{ theme: string } & ThemeContrastIssue>;
  suggestions: Array<{ theme: string } & ThemeContrastIssue>;
}

/** Validate a themes.json-shaped catalog ({ themes: { id: { colors } } }). */
export function validateThemeCatalog(catalog: {
  themes?: Record<string, { colors?: ThemeColors }>;
}): ThemeCatalogReport {
  const report: ThemeCatalogReport = { themes_checked: 0, must_fix: [], suggestions: [] };
  for (const [themeId, theme] of Object.entries(catalog.themes || {})) {
    report.themes_checked += 1;
    for (const issue of validateThemeContrast(theme.colors || {})) {
      const entry = { theme: themeId, ...issue };
      if (issue.severity === 'must_fix') report.must_fix.push(entry);
      else report.suggestions.push(entry);
    }
  }
  return report;
}

/**
 * MP-04 follow-up: guarantee a text color is actually readable on its fill.
 *
 * Theme palettes do not always carry every role a renderer asks for, and a
 * missing role falls back to a neighbouring one — which is how a panel ended
 * up emitting `fill: #334155` with `color: #334155` and rendering its body
 * text completely invisible on four slides of a ten-slide deck. Layout checks
 * cannot see this: the text fits its box perfectly, it just cannot be read.
 *
 * The preferred color is kept whenever it clears the AA floor. Otherwise the
 * higher-contrast of near-black / near-white is substituted, which is always
 * legible and never invents a brand color.
 */
export function ensureReadableOn(
  fill: string,
  preferred: string,
  options: { minRatio?: number } = {}
): string {
  const minRatio = options.minRatio ?? WCAG_AA_BODY_TEXT;
  const ratio = contrastRatio(preferred, fill);
  // Unparseable colors are left alone: substituting on a guess would be worse
  // than leaving an author's explicit choice in place.
  if (ratio === null) return preferred;
  if (ratio >= minRatio) return preferred;

  const dark = '0f172a';
  const light = 'ffffff';
  const darkRatio = contrastRatio(dark, fill) ?? 0;
  const lightRatio = contrastRatio(light, fill) ?? 0;
  return darkRatio >= lightRatio ? dark : light;
}
