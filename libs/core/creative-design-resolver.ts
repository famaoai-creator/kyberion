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
    fonts?: { sans?: string; mono?: string };
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
  brandName: string;
} {
  const parsed = readJsonIfPresent(
    pathResolver.knowledge(BRAND_TOKENS_PATH)
  ) as BrandTokensFile | null;
  const rawColors = parsed?.tokens?.colors?.[mode] || {};
  const fallback = FALLBACK_COLORS[mode];
  const colors: CreativeDesignColors = {
    primary: String(rawColors.primary || fallback.primary),
    secondary: String(rawColors.secondary || fallback.secondary),
    accent: String(rawColors.accent || fallback.accent),
    background: String(rawColors.bg_main || rawColors.background || fallback.background),
    text: String(rawColors.text_primary || rawColors.text || fallback.text),
    warning: String(rawColors.warning || fallback.warning),
  };
  const sans = String(parsed?.tokens?.fonts?.sans || FALLBACK_FONTS.sans);
  const fonts: CreativeDesignFonts = {
    sans,
    mono: String(parsed?.tokens?.fonts?.mono || FALLBACK_FONTS.mono),
    heading: sans,
    body: sans,
  };
  return { colors, fonts, brandName: String(parsed?.brand_name || 'Kyberion') };
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
      if (typeof value === 'string' && value.trim()) merged[key] = value.trim();
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
  const heading =
    typeof source.heading === 'string' && source.heading.trim() ? source.heading : base.heading;
  const body = typeof source.body === 'string' && source.body.trim() ? source.body : base.body;
  return { ...base, heading, body, sans: body };
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
  fonts: CreativeDesignFonts
): CreativeProjection {
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
  let source: ResolvedCreativeDesign['source'] = 'brand-default';
  let logoUrl: string | undefined;
  let brandName = base.brandName;
  let themeName = mode === 'dark' ? 'kyberion-sovereign' : 'kyberion-standard';

  const tenantSlug = input.tenantSlug?.trim() || undefined;
  if (tenantSlug) {
    const tenant = loadTenantDesign(tenantSlug);
    if (tenant) {
      colors = applyTenantColors(colors, tenant);
      fonts = applyTenantFonts(fonts, tenant);
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
      projection = buildMediaProjection(input.surface, colors, fonts, themeName, logoUrl);
      break;
    case 'video':
      projection = buildVideoProjection(colors, fonts);
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
