import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { loadBrandTokensAtPath, type BrandTokens } from './brand-tokens.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from '../secure-io.js';
import { DEFAULT_CHRONOS_WEB_THEME_PACK, type WebThemePack } from './web-design-system.js';
import { deriveAccentPalette, type CeAccentPalette } from '../harnessing/ce-adoption.js';
import { isValidTenantSlug } from '../entity-scope.js';
import {
  buildFoundationModeVars,
  buildFoundationPrimitiveVars,
  buildStyleVars,
  findDesignStyle,
  loadDesignFoundation,
  type DesignStyle,
} from './design-foundation.js';
import {
  loadTenantDesignOverride,
  loadThemeForTenantDesign,
} from '../organization/tenant-design-override.js';
import {
  SEMANTIC_ENGINE_COLOR_FORMAT,
  type SemanticColorFormat,
  type SemanticEngine,
} from './semantic-design-token-fallbacks.js';
import { isRecord } from '../foundation/primitives.js';
import { readJson } from '../foundation/json.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { createLogger } from '../logger.js';

const designLogger = createLogger('creative-design-resolver');

/**
 * E2E-02: the single entry point for creative design resolution.
 *
 * Every artifact surface (web / pptx / doc / xlsx / video / generation prompt)
 * resolves its design exactly once through this module:
 *   brand tokens (knowledge/public/design-patterns/brand-tokens/kyberion.json)
 *   → tenant override (knowledge/confidential/<slug>/design/)
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
    /**
     * KDS v2 style projection only: supporting roles the media layouts already
     * read (panel fill, hairline, header bar, CTA, text pair) so a style's
     * neutrals reach every slide role instead of the blue fallbacks.
     */
    surface?: string;
    muted?: string;
    border?: string;
    navy?: string;
    cta?: string;
    text_primary?: string;
    text_secondary?: string;
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

export function cloneJsonValue<T>(value: T): T {
  if (value === undefined) return value;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Media JSON clone must be serializable');
  return parseSafeJsonInput(serialized, 'Media JSON clone') as T;
}

export function deepMergeCatalog(base: unknown, next: unknown): unknown {
  if (Array.isArray(base) || Array.isArray(next)) return cloneJsonValue(next);
  if (!isRecord(base)) return cloneJsonValue(next);
  if (!isRecord(next)) return cloneJsonValue(next);
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (isRecord(value) && isRecord(merged[key])) {
      merged[key] = deepMergeCatalog(merged[key], value);
    } else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

export function readJsonFilesRecursively(dirPath: string): unknown[] {
  const safeDirPath = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDirPath) || !safeLstat(safeDirPath).isDirectory()) return [];
  const entries = safeReaddir(safeDirPath).sort();
  const docs: unknown[] = [];
  for (const entry of entries) {
    const fullPath = path.join(safeDirPath, entry);
    const stat = safeLstat(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      docs.push(...readJsonFilesRecursively(fullPath));
      continue;
    }
    if (stat.isFile() && entry.endsWith('.json')) {
      docs.push(loadJsonValue(fullPath));
    }
  }
  return docs;
}

export function loadJsonValue(filePath: string): unknown {
  const safePath = assertSafeRepositoryPath(filePath);
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`Media JSON input must be an existing regular file: ${safePath}`);
  }
  return readJson(safePath);
}

export interface MediaDesignSystemDefinition {
  theme: string;
  profiles?: string[];
  layout_template_id?: string;
  body_zone_map?: Record<string, string>;
  slide_layout_overrides?: Record<string, unknown>;
  semantic_overrides?: Record<string, Record<string, Record<string, unknown>>>;
  branding?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MediaDesignSystemsCatalog {
  version: string;
  default_system: string;
  systems: Record<string, MediaDesignSystemDefinition>;
  style_pack?: {
    tone_words?: string[];
    typography_hint?: string;
    avoid?: string[];
    music?: {
      mood: string;
      bpm_range?: [number, number];
      instrumentation_hint?: string;
    };
  };
}

export function loadMediaDesignSystemsCatalog(rootDir: string): MediaDesignSystemsCatalog {
  const aggregationSeed: MediaDesignSystemsCatalog = {
    version: '1.0.0',
    default_system: 'executive-standard',
    systems: {},
  };
  const filePath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/media-design-systems.json'
  );
  const catalog = defineCatalog<MediaDesignSystemsCatalog>({
    id: 'media-design-systems',
    path: filePath,
    schema:
      rootDir === pathResolver.rootDir()
        ? pathResolver.knowledge('product/schemas/media-design-systems.schema.json')
        : path.resolve(rootDir, 'knowledge/product/schemas/media-design-systems.schema.json'),
  });
  const directoryPath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/media-design-systems'
  );
  const docs = readJsonFilesRecursively(directoryPath);
  if (docs.length === 0) return catalog.load();
  const merged = docs.reduce(
    (acc, doc) => deepMergeCatalog(acc, doc),
    cloneJsonValue(aggregationSeed)
  );
  return catalog.validate(merged, directoryPath);
}

export const KDS_THEME_PREFIX = 'kds:';
export const KDS_SYSTEM_PREFIX = 'kds-';

/**
 * Semantic types a KDS style re-lays out. Specialised zones (architecture,
 * timeline, decision_cta, hero, contents) keep their own geometry; the generic
 * ones take a composition. `pref` = the style's own first preferred composition.
 */
const KDS_SEMANTIC_COMPOSITION: Record<string, string | 'pref'> = {
  content: 'pref',
  summary: 'pref',
  overview: 'bento-4',
  solution: 'bento-4',
  problem: 'sidebar-detail',
  comparison: 'three-up',
  metrics: 'stat-rail',
  roi: 'stat-rail',
};

/** Compositions that carry only text (no image slot), safe for automatic mapping. */
const KDS_PROSE_COMPOSITIONS = new Set(['spotlight', 'sidebar-detail', 'three-up']);

export function buildKdsDesignSystem(styleId: string): MediaDesignSystemDefinition | null {
  const style = findDesignStyle(styleId);
  if (!style) return null;
  const bodyZoneMap: Record<string, string> = {};
  for (const [semantic, target] of Object.entries(KDS_SEMANTIC_COMPOSITION)) {
    const compositionId =
      target === 'pref'
        ? (style.preferred_compositions.find((id) => KDS_PROSE_COMPOSITIONS.has(id)) ??
          'sidebar-detail')
        : target;
    if (compositionId) bodyZoneMap[semantic] = `kds-${compositionId}`;
  }
  return {
    theme: `${KDS_THEME_PREFIX}${style.id}`,
    body_zone_map: bodyZoneMap,
    metadata: { source_type: 'kds', description: style.description },
  };
}

export interface DesignSystemSelection {
  id: string;
  system: MediaDesignSystemDefinition;
  source: 'explicit' | 'reference' | 'profile' | 'default';
}

function loadOptionalMediaDesignSystemsCatalog(): MediaDesignSystemsCatalog | null {
  try {
    return loadMediaDesignSystemsCatalog(pathResolver.rootDir());
  } catch {
    return null;
  }
}

export interface MediaThemeCatalog<T = MediaThemeRecord> {
  version: string;
  default_theme: string;
  themes: Record<string, T>;
}

export function loadMediaThemeCatalogScope<T>(
  rootDir: string,
  id: string,
  relativeDirectory: string,
  optional = false
): MediaThemeCatalog<T> {
  const directory = path.resolve(rootDir, relativeDirectory);
  const seed: MediaThemeCatalog<T> = {
    version: '1.0.0',
    default_theme: 'kyberion-standard',
    themes: {},
  };
  const catalog = defineCatalog<MediaThemeCatalog<T>>({
    id,
    path: `${directory}.json`,
    schema:
      rootDir === pathResolver.rootDir()
        ? pathResolver.knowledge('product/schemas/media-themes.schema.json')
        : path.resolve(rootDir, 'knowledge/product/schemas/media-themes.schema.json'),
    ...(optional ? { fallback: seed } : {}),
  });
  const fragments = readJsonFilesRecursively(directory);
  return fragments.length
    ? catalog.validate(fragments.reduce(deepMergeCatalog, seed), directory)
    : catalog.load();
}

export const PUBLIC_MEDIA_THEMES = 'knowledge/public/design-patterns/media-templates/themes';

function loadPublicMediaTheme(id: string): MediaThemeRecord | undefined {
  try {
    const { themes } = loadMediaThemeCatalogScope<MediaThemeRecord>(
      pathResolver.rootDir(),
      'media-themes-public',
      PUBLIC_MEDIA_THEMES
    );
    return Object.hasOwn(themes, id) ? themes[id] : undefined;
  } catch {
    return undefined;
  }
}

export function selectDesignSystem(
  catalog: MediaDesignSystemsCatalog,
  input: {
    designSystemId?: string;
    profileId?: string;
    resolveReference?: () => string | undefined;
  }
): DesignSystemSelection {
  const lookup = (id: string) =>
    Object.hasOwn(catalog.systems, id) ? catalog.systems[id] : undefined;
  const explicit = input.designSystemId?.trim();
  if (explicit) {
    const system =
      lookup(explicit) ??
      (explicit.startsWith(KDS_SYSTEM_PREFIX)
        ? buildKdsDesignSystem(explicit.slice(KDS_SYSTEM_PREFIX.length))
        : null);
    if (system) return { id: explicit, system, source: 'explicit' };
  }
  const reference = input.resolveReference?.();
  const referenced = reference ? lookup(reference) : undefined;
  if (reference && referenced) return { id: reference, system: referenced, source: 'reference' };
  const profile = input.profileId?.trim();
  if (profile) {
    const match = Object.entries(catalog.systems).find(([, system]) =>
      system.profiles?.includes(profile)
    );
    if (match) return { id: match[0], system: match[1], source: 'profile' };
  }
  const id = catalog.default_system;
  return { id, system: lookup(id) ?? { theme: 'kyberion-standard' }, source: 'default' };
}

export type CreativeProjection =
  | { surface: 'web'; theme_pack: WebThemePack }
  | { surface: 'pptx' | 'doc' | 'xlsx'; theme: MediaThemeRecord }
  | { surface: 'video'; css_vars: Record<string, string> }
  | { surface: 'prompt'; style_pack: PromptStylePack };

export interface ResolvedCreativeDesign {
  source: 'brand-default' | 'tenant-override';
  tenant_slug?: string;
  selection?: DesignSystemSelection;
  theme_id: string;
  theme_source: 'brand' | 'catalog';
  brand_name: string;
  mode: CreativeDesignMode;
  colors: CreativeDesignColors;
  fonts: CreativeDesignFonts;
  typography: CreativeDesignTypography;
  spacing: CreativeDesignSpacing;
  constraints: CreativeDesignConstraints;
  /** CE-09: one derived palette shared by web, media, and operator surfaces. */
  accent_palette: CeAccentPalette;
  logo_url?: string;
  /** KDS v2: present only when a known non-baseline `style` was requested. */
  design_style?: Pick<
    DesignStyle,
    'id' | 'label' | 'radius' | 'elevation' | 'density' | 'gradient' | 'preferred_compositions'
  >;
  /** KDS v2: `--kds-*` primitives + mode + style variables for this resolution. */
  foundation_css_vars?: Record<string, string>;
  projection: CreativeProjection;
}

export interface ResolveCreativeDesignInput {
  surface: CreativeSurface;
  /** The caller supplies the authorized tenant slug. */
  tenantSlug?: string;
  designSystemId?: string;
  profileId?: string;
  /** light/dark override. Defaults: video/prompt → dark, others → light. */
  mode?: CreativeDesignMode;
  /** Optional tenant accent override; tone is deliberately a single bounded value. */
  accent?: string;
  tone?: number;
  /**
   * KDS v2 style id (kyberion-foundation.json `styles`). Restyles the fixed
   * scenario — palette, heading face, type ramp, radius/elevation — without
   * touching scenario definitions. Unknown ids and `standard` are the baseline.
   * Precedence: brand tokens → style → tenant override.
   */
  style?: string;
}

type CreativeBrandTokens = Omit<BrandTokens, 'tokens'> & {
  tokens: BrandTokens['tokens'] & {
    fonts: BrandTokens['tokens']['fonts'] & {
      heading?: string;
      body?: string;
    };
    typography?: Partial<CreativeDesignTypography>;
    spacing?: Partial<CreativeDesignSpacing>;
    constraints?: Partial<CreativeDesignConstraints>;
  };
};

const BRAND_TOKENS_PATH = 'public/design-patterns/brand-tokens/kyberion.json';
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
  sans: "'Helvetica Neue', Arial, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', Meiryo, system-ui, sans-serif",
  mono: "'JetBrains Mono', monospace",
  heading: "'Helvetica Neue', Arial, 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif",
  body: "'Helvetica Neue', Arial, 'Hiragino Sans', 'Noto Sans JP', system-ui, sans-serif",
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
  if (!isValidTenantSlug(slug)) {
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

function loadBrandTokens(mode: CreativeDesignMode): {
  colors: CreativeDesignColors;
  fonts: CreativeDesignFonts;
  typography: CreativeDesignTypography;
  spacing: CreativeDesignSpacing;
  constraints: CreativeDesignConstraints;
  brandName: string;
} {
  const parsed = (() => {
    try {
      const filePath = assertSafeRepositoryPath(pathResolver.knowledge(BRAND_TOKENS_PATH), {
        allowMissingLeaf: false,
      });
      if (!safeLstat(filePath).isFile()) return null;
      return loadBrandTokensAtPath(filePath) as CreativeBrandTokens;
    } catch {
      return null;
    }
  })();
  const rawColors = parsed?.tokens?.colors?.[mode];
  const fallback = FALLBACK_COLORS[mode];
  const colors: CreativeDesignColors = {
    primary: normalizeCssToken(rawColors?.primary, fallback.primary),
    secondary: normalizeCssToken(rawColors?.secondary, fallback.secondary),
    accent: normalizeCssToken(rawColors?.accent, fallback.accent),
    background: normalizeCssToken(rawColors?.bg_main, fallback.background),
    text: normalizeCssToken(rawColors?.text_primary, fallback.text),
    warning: normalizeCssToken(rawColors?.warning, fallback.warning),
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

interface TenantDesignData {
  override: Record<string, any>;
  themePack: Record<string, any> | null;
}

function loadTenantDesign(tenantSlug: string): TenantDesignData | null {
  try {
    const directory = pathResolver.knowledge(path.join('confidential', tenantSlug, 'design'));
    const root = pathResolver.rootDir();
    const overridePath = path.join(directory, 'tenant-override.json');
    const override = loadTenantDesignOverride(root, overridePath, directory);
    if (!override) return null;
    return { override, themePack: loadThemeForTenantDesign(root, overridePath, override) };
  } catch {
    return null;
  }
}

/**
 * Tenant semantic-token overlay for one artifact engine
 * (`theme.semantic_tokens.<engine>` in the tenant's theme.json, or the same
 * path in tenant-override.json). Consumed by semantic-design-tokens.ts.
 */
export function readTenantSemanticTokens(
  tenantSlug: string | undefined,
  engine: string
): Record<string, string> {
  if (!tenantSlug || !isValidTenantSlug(tenantSlug)) return {};
  const tenant = loadTenantDesign(tenantSlug);
  if (!tenant) return {};
  const format = Object.hasOwn(SEMANTIC_ENGINE_COLOR_FORMAT, engine)
    ? SEMANTIC_ENGINE_COLOR_FORMAT[engine as SemanticEngine]
    : undefined;
  const merged: Record<string, string> = {};
  const dropped: string[] = [];
  for (const source of [
    tenant.themePack?.theme?.semantic_tokens?.[engine],
    tenant.override?.theme?.semantic_tokens?.[engine],
    tenant.override?.semantic_tokens?.[engine],
  ]) {
    if (!source || typeof source !== 'object') continue;
    for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
      // Unknown engine: no declared colour syntax, so nothing is trusted (fail closed).
      const safe = format ? normalizeSemanticColor(value, format) : undefined;
      if (safe) merged[key] = safe;
      else dropped.push(key);
    }
  }
  if (dropped.length) {
    designLogger.warn(
      `[design] dropped ${dropped.length} tenant semantic token(s) for engine "${engine}" (tenant ${tenantSlug}) — ` +
        `${format ? `values must be ${format === 'ooxml_hex' ? 'a 6-digit hex colour (RRGGBB)' : 'a hex, rgb(a) or hsl(a) colour'}` : 'the engine declares no colour format'} | ` +
        `fix theme.semantic_tokens.${engine} in the tenant design overlay | keys: ${dropped.slice(0, 10).join(', ')}`
    );
  }
  return merged;
}

const OOXML_HEX_COLOR = /^#?[0-9A-Fa-f]{6}$/;
const CSS_HEX_COLOR = /^#(?:[0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/;
/** rgb()/rgba()/hsl()/hsla() with numeric arguments only (no url(), var(), nested calls). */
const CSS_FUNCTIONAL_COLOR = /^(?:rgba?|hsla?)\(\s*(?:[0-9.%\s,/+-]|deg|turn|rad)*\)$/i;

function normalizeSemanticColor(value: unknown, format: SemanticColorFormat): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return undefined;
  if (format === 'ooxml_hex') return OOXML_HEX_COLOR.test(trimmed) ? trimmed : undefined;
  return CSS_HEX_COLOR.test(trimmed) || CSS_FUNCTIONAL_COLOR.test(trimmed) ? trimmed : undefined;
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
  let { heading, body } = base;
  for (const source of [
    tenant.themePack?.theme?.fonts,
    tenant.override?.theme?.fonts,
    tenant.override?.branding?.fonts,
  ]) {
    heading = normalizeCssToken(source?.heading, heading);
    body = normalizeCssToken(source?.body, body);
  }
  return body === base.body && heading === base.heading
    ? base
    : { ...base, heading, body, sans: body };
}

/** Read a tenant token group from either the theme pack or the override file. */
function readTenantTokenGroup(
  tenant: TenantDesignData,
  key: 'typography' | 'spacing' | 'constraints'
): Record<string, any> {
  const sources = [
    tenant.themePack?.theme?.[key],
    tenant.override?.theme?.[key],
    tenant.override?.[key],
  ].filter(isRecord);
  const merged = sources.reduce(deepMergeCatalog, {});
  return isRecord(merged) ? merged : {};
}

function applyTenantTypography(
  base: CreativeDesignTypography,
  tenant: TenantDesignData
): CreativeDesignTypography {
  const source = readTenantTokenGroup(tenant, 'typography');
  const roles = { ...base.roles };
  for (const name of Object.keys(roles) as CreativeTypeRoleName[]) {
    const raw = source.roles?.[name];
    if (raw && typeof raw === 'object') roles[name] = { ...roles[name], ...raw };
  }
  return mergeTypography({ scale_ratio: source.scale_ratio ?? base.scale_ratio, roles });
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
  logoUrl: string | undefined,
  styleColors?: Partial<MediaThemeRecord['colors']>
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
        ...(styleColors || {}),
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

function buildPromptProjection(
  colors: CreativeDesignColors,
  fonts: CreativeDesignFonts,
  style?: DesignStyle,
  config: NonNullable<MediaDesignSystemsCatalog['style_pack']> = {}
): CreativeProjection {
  return {
    surface: 'prompt',
    style_pack: {
      palette_hex: [colors.primary, colors.secondary, colors.accent, colors.background],
      tone_words: style?.tone_words.length
        ? style.tone_words
        : config.tone_words?.length
          ? config.tone_words
          : DEFAULT_STYLE_PACK_BASE.tone_words,
      typography_hint: style
        ? `${style.label} style: headings in ${fonts.heading}, body in ${fonts.body}`
        : config.typography_hint || `${DEFAULT_STYLE_PACK_BASE.typography_hint} (${fonts.sans})`,
      avoid: style?.avoid.length
        ? [...style.avoid, ...DEFAULT_STYLE_PACK_BASE.avoid]
        : config.avoid?.length
          ? config.avoid
          : DEFAULT_STYLE_PACK_BASE.avoid,
      music: config.music || DEFAULT_STYLE_PACK_BASE.music,
    },
  };
}

function applyStyleColors(
  base: CreativeDesignColors,
  style: DesignStyle,
  mode: CreativeDesignMode
): CreativeDesignColors {
  const source = style.colors?.[mode];
  if (!source) return base;
  const merged = { ...base };
  for (const key of Object.keys(merged) as Array<keyof CreativeDesignColors>) {
    merged[key] = normalizeCssToken(source[key], merged[key]);
  }
  return merged;
}

function applyStyleFonts(base: CreativeDesignFonts, style: DesignStyle): CreativeDesignFonts {
  if (!style.fonts) return base;
  const heading = normalizeCssToken(style.fonts.heading, base.heading);
  const body = normalizeCssToken(style.fonts.body, base.body);
  return { ...base, heading, body, sans: body };
}

function applyStyleTypography(
  base: CreativeDesignTypography,
  style: DesignStyle
): CreativeDesignTypography {
  if (!style.typography) return base;
  const roles = { ...base.roles };
  for (const name of Object.keys(roles) as CreativeTypeRoleName[]) {
    const raw = style.typography.roles?.[name];
    if (raw && typeof raw === 'object') {
      roles[name] = mergeTypeRole(roles[name], raw as Record<string, unknown>);
    }
  }
  return {
    scale_ratio: normalizeFiniteNumber(style.typography.scale_ratio, base.scale_ratio, {
      min: 1,
      max: 3,
    }),
    roles,
  };
}

export function resolveCreativeDesign(input: ResolveCreativeDesignInput): ResolvedCreativeDesign {
  const mode: CreativeDesignMode =
    input.mode ?? (input.surface === 'video' || input.surface === 'prompt' ? 'dark' : 'light');
  const base = loadBrandTokens(mode);
  const catalog =
    input.designSystemId || input.profileId || input.surface === 'prompt'
      ? loadOptionalMediaDesignSystemsCatalog()
      : null;
  const selection =
    catalog && (input.designSystemId || input.profileId)
      ? selectDesignSystem(catalog, {
          designSystemId: input.designSystemId,
          profileId: input.profileId,
        })
      : undefined;

  let colors = base.colors;
  let fonts = base.fonts;
  let typography = base.typography;
  let spacing = base.spacing;
  let constraints = base.constraints;
  let source: ResolvedCreativeDesign['source'] = 'brand-default';
  let logoUrl: string | undefined;
  let brandName = base.brandName;
  let themeName = mode === 'dark' ? 'kyberion-sovereign' : 'kyberion-standard';

  const selectedThemeId = selection?.system.theme;
  const styleId =
    input.style ??
    (selectedThemeId?.startsWith(KDS_THEME_PREFIX)
      ? selectedThemeId.slice(KDS_THEME_PREFIX.length)
      : undefined);
  const catalogTheme =
    selectedThemeId && !selectedThemeId.startsWith(KDS_THEME_PREFIX)
      ? loadPublicMediaTheme(selectedThemeId)
      : undefined;
  const themeId = catalogTheme && selectedThemeId ? selectedThemeId : themeName;
  if (catalogTheme && selection) {
    const theme = catalogTheme;
    const layers = { override: {}, themePack: { theme } };
    colors = applyTenantColors(colors, layers);
    fonts = applyTenantFonts(fonts, layers);
    typography = applyTenantTypography(typography, layers);
    spacing = mergeSpacing({ ...spacing, ...theme.spacing });
    constraints = mergeConstraints({ ...constraints, ...theme.constraints });
    logoUrl = resolveTenantLogo(layers);
    themeName = selection.system.theme;
  }

  const foundation = styleId ? loadDesignFoundation() : null;
  const style = findDesignStyle(styleId, foundation);
  let foundationCssVars: Record<string, string> | undefined;
  if (foundation && style) {
    colors = applyStyleColors(colors, style, mode);
    fonts = applyStyleFonts(fonts, style);
    typography = applyStyleTypography(typography, style);
    themeName = `kds:${style.id}`;
    foundationCssVars = {
      ...buildFoundationPrimitiveVars(foundation),
      ...buildFoundationModeVars(foundation, mode),
      ...buildStyleVars(foundation, style, mode),
    };
  }

  const tenantSlug = normalizeTenantSlug(input.tenantSlug);
  if (tenantSlug) {
    const tenant = loadTenantDesign(tenantSlug);
    if (tenant) {
      colors = applyTenantColors(colors, tenant);
      fonts = applyTenantFonts(fonts, tenant);
      typography = applyTenantTypography(typography, tenant);
      spacing = mergeSpacing({
        ...spacing,
        ...readTenantTokenGroup(tenant, 'spacing'),
      });
      constraints = mergeConstraints({
        ...constraints,
        ...readTenantTokenGroup(tenant, 'constraints'),
      });
      logoUrl = resolveTenantLogo(tenant) ?? logoUrl;
      source = 'tenant-override';
      brandName = String(
        tenant.override?.branding?.brand_name || tenant.override?.brand_name || brandName
      );
      const overrideTheme = tenant.override?.theme;
      themeName =
        typeof overrideTheme === 'string'
          ? overrideTheme
          : String(tenant.themePack?.theme?.name || tenantSlug);
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
        logoUrl,
        style
          ? {
              ...(source === 'brand-default' && style.colors?.[mode]
                ? {
                    surface: style.colors[mode].surface,
                    muted: style.colors[mode].muted,
                    border: style.colors[mode].border,
                  }
                : {}),
              navy: colors.primary,
              cta: colors.accent,
              text_primary: colors.text,
              text_secondary: colors.secondary,
            }
          : undefined
      );
      break;
    case 'video':
      projection = buildVideoProjection(colors, fonts, typography, spacing, constraints);
      if (foundationCssVars && projection.surface === 'video') {
        projection = {
          surface: 'video',
          css_vars: { ...foundationCssVars, ...projection.css_vars },
        };
      }
      break;
    case 'prompt':
      projection = buildPromptProjection(colors, fonts, style, catalog?.style_pack);
      break;
  }

  return {
    source,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    ...(selection ? { selection } : {}),
    theme_id: themeId,
    theme_source: catalogTheme ? 'catalog' : 'brand',
    brand_name: brandName,
    mode,
    colors,
    fonts,
    typography,
    spacing,
    constraints,
    accent_palette: deriveAccentPalette(
      input.accent || colors.accent,
      input.tone ?? (mode === 'dark' ? 0.65 : 0.4)
    ),
    ...(logoUrl ? { logo_url: logoUrl } : {}),
    ...(style
      ? {
          design_style: {
            id: style.id,
            label: style.label,
            radius: style.radius,
            elevation: style.elevation,
            density: style.density,
            gradient: style.gradient,
            preferred_compositions: style.preferred_compositions,
          },
        }
      : {}),
    ...(foundationCssVars ? { foundation_css_vars: foundationCssVars } : {}),
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
