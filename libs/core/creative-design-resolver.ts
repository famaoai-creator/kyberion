import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';
import { DEFAULT_CHRONOS_WEB_THEME_PACK, type WebThemePack } from './web-design-system.js';

/**
 * E2E-02: the single entry point for creative design resolution.
 *
 * Every artifact surface (web / pptx / doc / xlsx / video / generation prompt)
 * resolves its design exactly once through this module:
 *   brand tokens (knowledge/public/design-patterns/brand-tokens/kyberion.json)
 *   → tenant override (knowledge/confidential/<slug>/design/ or customer/<slug>/design/)
 *   → surface-specific projection.
 * Downstream code must not hardcode colors or fonts.
 */

export type CreativeSurface = 'web' | 'pptx' | 'doc' | 'xlsx' | 'video' | 'prompt';
export type CreativeDesignMode = 'light' | 'dark';

export interface CreativeDesignColors {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
  warning: string;
}

export interface CreativeDesignFonts {
  sans: string;
  mono: string;
  heading: string;
  body: string;
}

/**
 * MP-01: modular type scale. Sizes are points on the pptx/doc surface; other
 * surfaces project from these (video px ≈ pt × frame factor). `min_size_pt`
 * is the floor layout-fit (MP-03) may downscale to — never below.
 */
export interface CreativeTypeRole {
  size_pt: number;
  min_size_pt: number;
  weight: number;
  line_spacing_pct: number;
}

export type CreativeTypeRoleName = 'display' | 'headline' | 'title' | 'body' | 'label' | 'caption';

export interface CreativeDesignTypography {
  scale_ratio: number;
  roles: Record<CreativeTypeRoleName, CreativeTypeRole>;
}

export interface CreativeDesignSpacing {
  /** Base grid unit in points (4pt grid). */
  base_pt: number;
  /** Allowed multiples of base_pt for gaps and padding. */
  steps: number[];
  /** Safe content margins for pptx/doc surfaces, inches [top, right, bottom, left]. */
  pptx_safe_margin_in: [number, number, number, number];
  /** Title-safe inset for video surfaces as a fraction of the frame (0.05 = 5%). */
  video_safe_area_pct: number;
}

/**
 * Hard design floors and anti-pattern ids. Floors bound layout-fit
 * downscaling; `banned_patterns` feed the visual-review rubric (MP-04).
 */
export interface CreativeDesignConstraints {
  min_body_pt: number;
  min_label_pt: number;
  video_min_headline_px: number;
  video_min_body_px: number;
  banned_patterns: string[];
}

/** themes.json (media-templates) record shape consumed by media-actuator. */
export interface MediaThemeRecord {
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
  /** MP-01: type ramp and grid carried onto the media surfaces. */
  typography?: CreativeDesignTypography;
  spacing?: CreativeDesignSpacing;
  constraints?: CreativeDesignConstraints;
  assets?: { logo_url?: string };
}

/** Style brief injected into generative prompts (image / video / music). */
export interface PromptStylePack {
  palette_hex: string[];
  tone_words: string[];
  typography_hint: string;
  avoid: string[];
  music?: {
    mood: string;
    bpm_range?: [number, number];
    instrumentation_hint?: string;
  };
}

export type CreativeProjection =
  | { surface: 'web'; theme_pack: WebThemePack }
  | { surface: 'pptx' | 'doc' | 'xlsx'; theme: MediaThemeRecord }
  | { surface: 'video'; css_vars: Record<string, string> }
  | { surface: 'prompt'; style_pack: PromptStylePack };

export interface ResolvedCreativeDesign {
  source: 'brand-default' | 'tenant-override';
  tenant_slug?: string;
  mode: CreativeDesignMode;
  colors: CreativeDesignColors;
  fonts: CreativeDesignFonts;
  typography: CreativeDesignTypography;
  spacing: CreativeDesignSpacing;
  constraints: CreativeDesignConstraints;
  logo_url?: string;
  projection: CreativeProjection;
}

export interface ResolveCreativeDesignInput {
  surface: CreativeSurface;
  tenantSlug?: string;
  /** light/dark override. Defaults: video/prompt → dark, others → light. */
  mode?: CreativeDesignMode;
}

interface BrandTokensFile {
  brand_name?: string;
  tokens?: {
    colors?: Record<CreativeDesignMode, Record<string, string>>;
    fonts?: { sans?: string; mono?: string; heading?: string; body?: string };
    typography?: Partial<CreativeDesignTypography>;
    spacing?: Partial<CreativeDesignSpacing>;
    constraints?: Partial<CreativeDesignConstraints>;
  };
}

const BRAND_TOKENS_PATH = 'public/design-patterns/brand-tokens/kyberion.json';
const MEDIA_DESIGN_SYSTEMS_PATH =
  'public/design-patterns/media-templates/media-design-systems.json';

const FALLBACK_COLORS: Record<CreativeDesignMode, CreativeDesignColors> = {
  light: {
    primary: '#0f172a',
    secondary: '#334155',
    accent: '#0066cc',
    background: '#ffffff',
    text: '#0f172a',
    warning: '#eab308',
  },
  dark: {
    primary: '#0A192F',
    secondary: '#31415B',
    accent: '#00F2FF',
    background: '#020617',
    text: '#F8FAFC',
    warning: '#f59e0b',
  },
};

const FALLBACK_FONTS: CreativeDesignFonts = {
  sans: "Inter, 'Noto Sans JP', sans-serif",
  mono: "'JetBrains Mono', monospace",
  heading: "Inter, 'Noto Sans JP', sans-serif",
  body: "Inter, 'Noto Sans JP', sans-serif",
};

/**
 * MP-01 fallbacks. The ramp is a 1.25 (major third) scale anchored on a 13pt
 * body — the size the 10×5.625in deck geometry was tuned around — with weight
 * contrast between display/headline (700+) and body (400) so decks never
 * render as one undifferentiated weight.
 */
const FALLBACK_TYPOGRAPHY: CreativeDesignTypography = {
  scale_ratio: 1.25,
  roles: {
    display: { size_pt: 36, min_size_pt: 24, weight: 800, line_spacing_pct: 110 },
    headline: { size_pt: 26, min_size_pt: 18, weight: 700, line_spacing_pct: 120 },
    title: { size_pt: 20, min_size_pt: 14, weight: 700, line_spacing_pct: 130 },
    body: { size_pt: 13, min_size_pt: 10, weight: 400, line_spacing_pct: 155 },
    label: { size_pt: 11, min_size_pt: 9, weight: 600, line_spacing_pct: 130 },
    caption: { size_pt: 9, min_size_pt: 8, weight: 400, line_spacing_pct: 125 },
  },
};

const FALLBACK_SPACING: CreativeDesignSpacing = {
  base_pt: 4,
  steps: [1, 2, 3, 4, 6, 8, 12],
  pptx_safe_margin_in: [0.3, 0.35, 0.3, 0.35],
  video_safe_area_pct: 0.05,
};

const FALLBACK_CONSTRAINTS: CreativeDesignConstraints = {
  min_body_pt: 10,
  min_label_pt: 8,
  video_min_headline_px: 60,
  video_min_body_px: 20,
  banned_patterns: [
    'decorative-accent-line-under-title',
    'decorative-color-bar',
    'cyan-on-dark-gradient',
    'uniform-font-weight',
    'centered-everything',
  ],
};

const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;
const CSS_TOKEN_FORBIDDEN = /[<>{};\u0000\r\n]/u;

function normalizeFiniteNumber(
  value: unknown,
  fallback: number,
  range: { min: number; max: number }
): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= range.min && number <= range.max ? number : fallback;
}

/** Keep values safe for direct interpolation into generated CSS. */
function normalizeCssToken(value: unknown, fallback: string, maxLength = 256): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || CSS_TOKEN_FORBIDDEN.test(trimmed)) return fallback;
  return trimmed;
}

function normalizeTenantSlug(value: unknown): string | undefined {
  const slug = typeof value === 'string' ? value.trim() : '';
  if (!slug) return undefined;
  if (!TENANT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid tenant slug: expected lowercase letters, digits, and hyphens only (${slug})`
    );
  }
  return slug;
}

function mergeTypeRole(
  base: CreativeTypeRole,
  override: Record<string, unknown> | undefined
): CreativeTypeRole {
  if (!override) return base;
  const size = normalizeFiniteNumber(override.size_pt, base.size_pt, { min: 4, max: 200 });
  const minSize = normalizeFiniteNumber(override.min_size_pt, base.min_size_pt, {
    min: 4,
    max: size,
  });
  return {
    size_pt: size,
    min_size_pt: Math.min(minSize, size),
    weight: Math.round(normalizeFiniteNumber(override.weight, base.weight, { min: 100, max: 900 })),
    line_spacing_pct: normalizeFiniteNumber(override.line_spacing_pct, base.line_spacing_pct, {
      min: 80,
      max: 300,
    }),
  };
}

/**
 * Merge only known keys. Token files carry `_meta` documentation entries that
 * must not leak into the resolved design.
 */
function mergeTypography(
  override: Partial<CreativeDesignTypography> | undefined
): CreativeDesignTypography {
  if (!override) return FALLBACK_TYPOGRAPHY;
  const roles = { ...FALLBACK_TYPOGRAPHY.roles };
  for (const name of Object.keys(roles) as CreativeTypeRoleName[]) {
    const raw = override.roles?.[name];
    if (raw && typeof raw === 'object') {
      roles[name] = mergeTypeRole(roles[name], raw as unknown as Record<string, unknown>);
    }
  }
  return {
    scale_ratio: normalizeFiniteNumber(override.scale_ratio, FALLBACK_TYPOGRAPHY.scale_ratio, {
      min: 1,
      max: 3,
    }),
    roles,
  };
}

function mergeSpacing(override: Partial<CreativeDesignSpacing> | undefined): CreativeDesignSpacing {
  if (!override) return FALLBACK_SPACING;
  const rawSteps = Array.isArray(override.steps) ? override.steps : FALLBACK_SPACING.steps;
  const steps = rawSteps
    .map((value) => normalizeFiniteNumber(value, 1, { min: 0.25, max: 32 }))
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort((a, b) => a - b);
  const margins = Array.isArray(override.pptx_safe_margin_in)
    ? override.pptx_safe_margin_in.map((value, index) =>
        normalizeFiniteNumber(value, FALLBACK_SPACING.pptx_safe_margin_in[index], {
          min: 0,
          max: 2,
        })
      )
    : FALLBACK_SPACING.pptx_safe_margin_in;
  return {
    base_pt: normalizeFiniteNumber(override.base_pt, FALLBACK_SPACING.base_pt, {
      min: 1,
      max: 24,
    }),
    steps: steps.length > 0 ? steps : FALLBACK_SPACING.steps,
    pptx_safe_margin_in: margins as CreativeDesignSpacing['pptx_safe_margin_in'],
    video_safe_area_pct: normalizeFiniteNumber(
      override.video_safe_area_pct,
      FALLBACK_SPACING.video_safe_area_pct,
      { min: 0, max: 0.25 }
    ),
  };
}

function mergeConstraints(
  override: Partial<CreativeDesignConstraints> | undefined
): CreativeDesignConstraints {
  if (!override) return FALLBACK_CONSTRAINTS;
  const minBody = normalizeFiniteNumber(override.min_body_pt, FALLBACK_CONSTRAINTS.min_body_pt, {
    min: 8,
    max: 40,
  });
  const minLabel = normalizeFiniteNumber(override.min_label_pt, FALLBACK_CONSTRAINTS.min_label_pt, {
    min: 6,
    max: minBody,
  });
  const bannedPatterns = Array.isArray(override.banned_patterns)
    ? override.banned_patterns
        .filter((value): value is string => typeof value === 'string')
        .map((value) => normalizeCssToken(value, '', 80))
        .filter(Boolean)
    : FALLBACK_CONSTRAINTS.banned_patterns;
  return {
    min_body_pt: minBody,
    min_label_pt: minLabel,
    video_min_headline_px: Math.round(
      normalizeFiniteNumber(
        override.video_min_headline_px,
        FALLBACK_CONSTRAINTS.video_min_headline_px,
        { min: 12, max: 300 }
      )
    ),
    video_min_body_px: Math.round(
      normalizeFiniteNumber(override.video_min_body_px, FALLBACK_CONSTRAINTS.video_min_body_px, {
        min: 10,
        max: 200,
      })
    ),
    banned_patterns:
      bannedPatterns.length > 0
        ? Array.from(new Set(bannedPatterns))
        : FALLBACK_CONSTRAINTS.banned_patterns,
  };
}

const DEFAULT_STYLE_PACK_BASE = {
  tone_words: ['clean', 'modern', 'tech-forward', 'japanese-minimal'],
  typography_hint: 'geometric sans-serif in the Inter / Noto Sans JP family',
  avoid: ['clip-art', 'watermark', 'stock-photo look', 'colors outside the brand palette'],
  music: { mood: 'focused and forward-moving', bpm_range: [90, 120] as [number, number] },
};

function readJsonIfPresent(filePath: string): Record<string, any> | null {
  try {
    if (!safeExistsSync(filePath)) return null;
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as Record<
      string,
      any
    >;
  } catch {
    return null;
  }
}

function loadBrandTokens(mode: CreativeDesignMode): {
  colors: CreativeDesignColors;
  fonts: CreativeDesignFonts;
  typography: CreativeDesignTypography;
  spacing: CreativeDesignSpacing;
  constraints: CreativeDesignConstraints;
  brandName: string;
} {
  const parsed = readJsonIfPresent(
    pathResolver.knowledge(BRAND_TOKENS_PATH)
  ) as BrandTokensFile | null;
  const rawColors = parsed?.tokens?.colors?.[mode] || {};
  const fallback = FALLBACK_COLORS[mode];
  const colors: CreativeDesignColors = {
    primary: normalizeCssToken(rawColors.primary, fallback.primary),
    secondary: normalizeCssToken(rawColors.secondary, fallback.secondary),
    accent: normalizeCssToken(rawColors.accent, fallback.accent),
    background: normalizeCssToken(rawColors.bg_main || rawColors.background, fallback.background),
    text: normalizeCssToken(rawColors.text_primary || rawColors.text, fallback.text),
    warning: normalizeCssToken(rawColors.warning, fallback.warning),
  };
  const sans = String(parsed?.tokens?.fonts?.sans || FALLBACK_FONTS.sans);
  // MP-01: heading and body are distinct roles. They still default to the
  // brand sans (so existing single-family brands are unchanged), but a brand
  // that declares a display face now keeps it instead of being flattened.
  const fonts: CreativeDesignFonts = {
    sans: normalizeCssToken(sans, FALLBACK_FONTS.sans),
    mono: normalizeCssToken(parsed?.tokens?.fonts?.mono, FALLBACK_FONTS.mono),
    heading: normalizeCssToken(parsed?.tokens?.fonts?.heading, sans),
    body: normalizeCssToken(parsed?.tokens?.fonts?.body, sans),
  };
  return {
    colors,
    fonts,
    typography: mergeTypography(parsed?.tokens?.typography),
    spacing: mergeSpacing(parsed?.tokens?.spacing),
    constraints: mergeConstraints(parsed?.tokens?.constraints),
    brandName: String(parsed?.brand_name || 'Kyberion'),
  };
}

function tenantDesignDirCandidates(tenantSlug: string): string[] {
  return [
    pathResolver.rootResolve(path.join('customer', tenantSlug, 'design')),
    pathResolver.knowledge(path.join('confidential', tenantSlug, 'design')),
  ];
}

interface TenantDesignData {
  override: Record<string, any>;
  themePack: Record<string, any> | null;
  matchedDir: string;
}

function loadTenantDesign(tenantSlug: string): TenantDesignData | null {
  for (const dir of tenantDesignDirCandidates(tenantSlug)) {
    const override = readJsonIfPresent(path.join(dir, 'tenant-override.json'));
    if (!override) continue;
    const themePack = readJsonIfPresent(path.join(dir, 'theme.json'));
    return { override, themePack, matchedDir: dir };
  }
  return null;
}

function applyTenantColors(
  base: CreativeDesignColors,
  tenant: TenantDesignData
): CreativeDesignColors {
  const sources = [
    tenant.themePack?.theme?.colors,
    tenant.override?.theme?.colors,
    tenant.override?.branding?.colors,
  ].filter((entry): entry is Record<string, string> => Boolean(entry && typeof entry === 'object'));
  const merged = { ...base };
  for (const source of sources) {
    for (const key of Object.keys(merged) as Array<keyof CreativeDesignColors>) {
      const value = source[key];
      const safeValue = normalizeCssToken(value, '');
      if (safeValue) merged[key] = safeValue;
    }
  }
  return merged;
}

function applyTenantFonts(
  base: CreativeDesignFonts,
  tenant: TenantDesignData
): CreativeDesignFonts {
  const source =
    tenant.themePack?.theme?.fonts ||
    tenant.override?.theme?.fonts ||
    tenant.override?.branding?.fonts;
  if (!source || typeof source !== 'object') return base;
  const heading = normalizeCssToken(source.heading, base.heading);
  const body = normalizeCssToken(source.body, base.body);
  return { ...base, heading, body, sans: body };
}

/** Read a tenant token group from either the theme pack or the override file. */
function readTenantTokenGroup(
  tenant: TenantDesignData,
  key: 'typography' | 'spacing' | 'constraints'
): Record<string, any> | null {
  const source =
    tenant.themePack?.theme?.[key] || tenant.override?.theme?.[key] || tenant.override?.[key];
  return source && typeof source === 'object' ? (source as Record<string, any>) : null;
}

function applyTenantTypography(
  base: CreativeDesignTypography,
  tenant: TenantDesignData
): CreativeDesignTypography {
  const source = readTenantTokenGroup(tenant, 'typography');
  if (!source) return base;
  const roles = { ...base.roles };
  for (const name of Object.keys(roles) as CreativeTypeRoleName[]) {
    const raw = source.roles?.[name];
    if (raw && typeof raw === 'object') roles[name] = { ...roles[name], ...raw };
  }
  return mergeTypography({ scale_ratio: source.scale_ratio, roles });
}

function resolveTenantLogo(tenant: TenantDesignData): string | undefined {
  const raw =
    tenant.override?.branding?.logo_url ||
    tenant.override?.logo_url ||
    tenant.themePack?.theme?.assets?.logo_url;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function buildWebProjection(
  colors: CreativeDesignColors,
  fonts: CreativeDesignFonts,
  brandName: string,
  tenantSlug: string | undefined,
  logoUrl: string | undefined
): CreativeProjection {
  const themePack: WebThemePack = {
    ...DEFAULT_CHRONOS_WEB_THEME_PACK,
    brand_name: brandName,
    tenant_slug: tenantSlug || DEFAULT_CHRONOS_WEB_THEME_PACK.tenant_slug,
    theme: {
      ...DEFAULT_CHRONOS_WEB_THEME_PACK.theme,
      colors: {
        primary: colors.primary,
        secondary: colors.secondary,
        accent: colors.accent,
        background: colors.background,
        text: colors.text,
      },
      fonts: { heading: fonts.heading, body: fonts.body },
      ...(logoUrl ? { assets: { logo_url: logoUrl } } : {}),
    },
  };
  return { surface: 'web', theme_pack: themePack };
}

function buildMediaProjection(
  surface: 'pptx' | 'doc' | 'xlsx',
  colors: CreativeDesignColors,
  fonts: CreativeDesignFonts,
  typography: CreativeDesignTypography,
  spacing: CreativeDesignSpacing,
  constraints: CreativeDesignConstraints,
  themeName: string,
  logoUrl: string | undefined
): CreativeProjection {
  return {
    surface,
    theme: {
      name: themeName,
      colors: {
        primary: colors.primary,
        secondary: colors.secondary,
        accent: colors.accent,
        background: colors.background,
        text: colors.text,
      },
      fonts: { heading: fonts.heading, body: fonts.body },
      typography,
      spacing,
      constraints,
      ...(logoUrl ? { assets: { logo_url: logoUrl } } : {}),
    },
  };
}

/**
 * Video projection: css_vars overrides for buildVideoDesignCssVars()'s
 * `designSystemRef.css_vars` (VDS-07). Keys not listed here keep the
 * mode-derived defaults from video-design-system.ts.
 */
function buildVideoProjection(
  colors: CreativeDesignColors,
  fonts: CreativeDesignFonts,
  typography: CreativeDesignTypography,
  spacing: CreativeDesignSpacing,
  constraints: CreativeDesignConstraints
): CreativeProjection {
  // MP-01: the type ramp reaches scene CSS as px vars. Points scale to a
  // 1080-tall frame (1pt ≈ 2.6px there), floored at the constraint minimums so
  // no scene can emit sub-legible text.
  const px = (pt: number, floor: number): number => Math.max(floor, Math.round(pt * 2.6));
  const roles = typography.roles;
  return {
    surface: 'video',
    css_vars: {
      '--kb-bg-main': colors.background,
      '--kb-primary': colors.primary,
      '--kb-secondary': colors.secondary,
      '--kb-accent': colors.accent,
      '--kb-warning': colors.warning,
      '--kb-text-primary': colors.text,
      '--kb-font-sans': fonts.sans,
      '--kb-font-heading': fonts.heading,
      '--kb-font-body': fonts.body,
      '--kb-size-display': `${px(roles.display.size_pt, constraints.video_min_headline_px)}px`,
      '--kb-size-headline': `${px(roles.headline.size_pt, constraints.video_min_headline_px)}px`,
      '--kb-size-title': `${px(roles.title.size_pt, constraints.video_min_body_px)}px`,
      '--kb-size-body': `${px(roles.body.size_pt, constraints.video_min_body_px)}px`,
      '--kb-size-label': `${px(roles.label.size_pt, constraints.video_min_body_px)}px`,
      '--kb-weight-display': String(roles.display.weight),
      '--kb-weight-headline': String(roles.headline.weight),
      '--kb-weight-body': String(roles.body.weight),
      '--kb-space-unit': `${spacing.base_pt}px`,
      '--kb-safe-area': `${Math.round(spacing.video_safe_area_pct * 100)}%`,
    },
  };
}

interface StylePackConfig {
  tone_words?: string[];
  typography_hint?: string;
  avoid?: string[];
  music?: PromptStylePack['music'];
}

function loadStylePackConfig(): StylePackConfig {
  const parsed = readJsonIfPresent(pathResolver.knowledge(MEDIA_DESIGN_SYSTEMS_PATH));
  const stylePack = parsed?.style_pack;
  return stylePack && typeof stylePack === 'object' ? (stylePack as StylePackConfig) : {};
}

function buildPromptProjection(
  colors: CreativeDesignColors,
  fonts: CreativeDesignFonts
): CreativeProjection {
  const config = loadStylePackConfig();
  return {
    surface: 'prompt',
    style_pack: {
      palette_hex: [colors.primary, colors.secondary, colors.accent, colors.background],
      tone_words: config.tone_words?.length
        ? config.tone_words
        : DEFAULT_STYLE_PACK_BASE.tone_words,
      typography_hint:
        config.typography_hint || `${DEFAULT_STYLE_PACK_BASE.typography_hint} (${fonts.sans})`,
      avoid: config.avoid?.length ? config.avoid : DEFAULT_STYLE_PACK_BASE.avoid,
      music: config.music || DEFAULT_STYLE_PACK_BASE.music,
    },
  };
}

export function resolveCreativeDesign(input: ResolveCreativeDesignInput): ResolvedCreativeDesign {
  const mode: CreativeDesignMode =
    input.mode ?? (input.surface === 'video' || input.surface === 'prompt' ? 'dark' : 'light');
  const base = loadBrandTokens(mode);

  let colors = base.colors;
  let fonts = base.fonts;
  let typography = base.typography;
  let spacing = base.spacing;
  let constraints = base.constraints;
  let source: ResolvedCreativeDesign['source'] = 'brand-default';
  let logoUrl: string | undefined;
  let brandName = base.brandName;
  let themeName = mode === 'dark' ? 'kyberion-sovereign' : 'kyberion-standard';

  const tenantSlug = normalizeTenantSlug(input.tenantSlug);
  if (tenantSlug) {
    const tenant = loadTenantDesign(tenantSlug);
    if (tenant) {
      colors = applyTenantColors(colors, tenant);
      fonts = applyTenantFonts(fonts, tenant);
      typography = applyTenantTypography(typography, tenant);
      spacing = mergeSpacing({
        ...spacing,
        ...(readTenantTokenGroup(tenant, 'spacing') || {}),
      });
      constraints = mergeConstraints({
        ...constraints,
        ...(readTenantTokenGroup(tenant, 'constraints') || {}),
      });
      logoUrl = resolveTenantLogo(tenant);
      source = 'tenant-override';
      brandName = String(
        tenant.override?.branding?.brand_name || tenant.override?.brand_name || brandName
      );
      themeName = String(tenant.override?.theme || tenant.themePack?.theme?.name || tenantSlug);
    }
  }

  let projection: CreativeProjection;
  switch (input.surface) {
    case 'web':
      projection = buildWebProjection(colors, fonts, brandName, tenantSlug, logoUrl);
      break;
    case 'pptx':
    case 'doc':
    case 'xlsx':
      projection = buildMediaProjection(
        input.surface,
        colors,
        fonts,
        typography,
        spacing,
        constraints,
        themeName,
        logoUrl
      );
      break;
    case 'video':
      projection = buildVideoProjection(colors, fonts, typography, spacing, constraints);
      break;
    case 'prompt':
      projection = buildPromptProjection(colors, fonts);
      break;
  }

  return {
    source,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    mode,
    colors,
    fonts,
    typography,
    spacing,
    constraints,
    ...(logoUrl ? { logo_url: logoUrl } : {}),
    projection,
  };
}

/** Render the style pack as a deterministic prompt suffix (E2E-02 Task 4). */
export function renderPromptStyleBlock(
  pack: PromptStylePack,
  options: { music?: boolean } = {}
): string {
  const lines = [
    `Style: palette=${pack.palette_hex.join(',')}; tone=${pack.tone_words.join(', ')}; typography=${pack.typography_hint}.`,
    `Avoid: ${pack.avoid.join(', ')}.`,
  ];
  if (options.music && pack.music) {
    const bpm = pack.music.bpm_range
      ? ` (${pack.music.bpm_range[0]}-${pack.music.bpm_range[1]} BPM)`
      : '';
    const instrumentation = pack.music.instrumentation_hint
      ? `; instrumentation=${pack.music.instrumentation_hint}`
      : '';
    lines.push(`Music mood: ${pack.music.mood}${bpm}${instrumentation}.`);
  }
  return lines.join('\n');
}
