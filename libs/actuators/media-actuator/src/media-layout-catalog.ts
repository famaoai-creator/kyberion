import {
  deepMergeCatalog,
  readJsonFilesRecursively,
  loadMediaDesignSystemsCatalog,
  loadJsonValue,
  loadTenantEntries,
  resolveConfidentialTenantOverride,
} from './media-catalog-loaders.js';
import { assertSafeRepositoryPath, safeReadFile } from '@agent/core/secure-io';
import { defineCatalog } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { createGovernedRetryOptionsBuilder } from '@agent/core/recovery-policy';
import {
  fitTextToBox,
  measureTextBlock,
  type LayoutFitResult,
} from '@agent/core/src/native-pptx-engine/text-metrics';
import { resolvePptxSurfaceDesign } from '@agent/core/src/native-pptx-engine/design-cascade';
import * as path from 'node:path';
const MEDIA_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/media-actuator/manifest.json');
const DEFAULT_MEDIA_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

export interface MediaLayoutPosition {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  [key: string]: unknown;
}

export interface MediaLayoutChrome {
  header_h?: number;
  body_x?: number;
  body_y?: number;
  body_w?: number;
  body_h?: number;
  footer_y?: number;
  footer_h?: number;
  footer_font_size?: number;
  logo_zone_x?: number;
  logo_zone_y?: number;
  logo_zone_w?: number;
  logo_zone_h?: number;
  logo_display_h?: number;
  logo_display_max_w?: number;
  title_w_logo?: number;
  title_w_no_logo?: number;
  title_font_size?: number;
  title_x?: number;
  accent_strip_x?: number;
  accent_strip_w?: number;
  separator_h?: number;
  [key: string]: unknown;
}

export interface MediaLayoutHero {
  white_panel_y?: number;
  white_panel_h?: number;
  separator_y?: number;
  separator_h?: number;
  logo_display_h?: number;
  logo_display_max_w?: number;
  logo_right_margin?: number;
  logo_y?: number;
  brand_name_x?: number;
  brand_name_y?: number;
  brand_name_w?: number;
  brand_name_h?: number;
  brand_name_font_size?: number;
  title_x?: number;
  title_y?: number;
  title_w?: number;
  title_h?: number;
  title_font_size?: number;
  subtitle_x?: number;
  subtitle_y?: number;
  subtitle_w?: number;
  subtitle_h?: number;
  subtitle_font_size?: number;
  [key: string]: unknown;
}

export interface MediaLayoutShape {
  type?: string;
  shapeType?: string;
  placeholderType?: string;
  pos?: MediaLayoutPosition;
  style?: Record<string, unknown>;
  text?: string;
  [key: string]: unknown;
}

export interface MediaLayoutTemplate {
  chrome?: MediaLayoutChrome;
  hero?: MediaLayoutHero;
  body_zones?: Record<string, MediaLayoutTemplate>;
  title?: MediaLayoutShape;
  body?: MediaLayoutShape;
  visual?: MediaLayoutShape;
  web?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MediaSlideLayoutPresetCatalog {
  version: string;
  defaults: Record<string, MediaLayoutTemplate>;
  presets: Record<string, MediaLayoutTemplate>;
  grid?: Record<string, unknown>;
  chrome?: MediaLayoutChrome;
  hero?: MediaLayoutHero;
  body_zones?: Record<string, MediaLayoutTemplate>;
  default?: string;
  templates?: Record<string, MediaLayoutTemplate>;
  _meta?: string;
}

export interface MediaLayoutTemplateCatalog {
  version: string;
  default: string;
  templates: Record<string, MediaLayoutTemplate>;
}

function cloneJsonValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

const buildRetryOptions = createGovernedRetryOptionsBuilder({
  manifestPath: MEDIA_MANIFEST_PATH,
  defaults: DEFAULT_MEDIA_RETRY,
  fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
});

function mergePptxShape(base: any, overrides: any): any {
  return {
    ...base,
    ...(overrides || {}),
    pos: {
      ...(base?.pos || {}),
      ...(overrides?.pos || {}),
    },
    style: {
      ...(base?.style || {}),
      ...(overrides?.style || {}),
    },
  };
}

function resolveSlideTemplate(template: any, slideData: any, fallback = ''): string {
  if (typeof template !== 'string') return fallback;
  return template
    .replace(/{{\s*title\s*}}/g, slideData?.title || '')
    .replace(/{{\s*subtitle\s*}}/g, slideData?.subtitle || '')
    .replace(
      /{{\s*body\s*}}/g,
      Array.isArray(slideData?.body) ? slideData.body.join('\n') : slideData?.body || ''
    )
    .replace(/{{\s*visual\s*}}/g, slideData?.visual || '');
}

function loadSlideLayoutPresetCatalog(rootDir: string): MediaSlideLayoutPresetCatalog {
  const fallback: MediaSlideLayoutPresetCatalog = { version: '1.0.0', defaults: {}, presets: {} };
  const catalog = defineCatalog<MediaSlideLayoutPresetCatalog>({
    id: 'slide-layout-presets',
    path: path.resolve(
      rootDir,
      'knowledge/public/design-patterns/media-templates/slide-layout-presets.json'
    ),
    schema: path.resolve(rootDir, 'knowledge/product/schemas/slide-layout-presets.schema.json'),
    fallback,
    fallbackOnInvalid: true,
  });
  const directoryPath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/slide-layout-presets'
  );
  const docs = readJsonFilesRecursively(directoryPath);
  if (docs.length === 0) return catalog.load();
  const merged = docs.reduce((acc, doc) => deepMergeCatalog(acc, doc), cloneJsonValue(fallback));
  return catalog.validate(merged, directoryPath);
}

function resolveRuntimeSlidePreset(rootDir: string, slideData: any): MediaLayoutTemplate | null {
  const layoutKey = String(slideData?.layout_key || '').trim();
  const mediaKind = String(slideData?.media_kind || '').trim();
  const presetKey = layoutKey || mediaKind;
  const catalog = loadSlideLayoutPresetCatalog(rootDir);
  const designSystems = loadMediaDesignSystemsCatalog(rootDir);
  const system = slideData?.design_system_id
    ? designSystems.systems?.[slideData.design_system_id]
    : null;
  const defaults = catalog.defaults?.['title-body'] || null;
  const preset = catalog.presets?.[presetKey] || catalog.presets?.[mediaKind] || defaults;
  const override =
    system?.slide_layout_overrides?.[presetKey] ||
    system?.slide_layout_overrides?.[mediaKind] ||
    null;
  if (!preset && !override) return null;
  return mergePptxShape(preset || {}, override || {});
}

let _cachedBzl: MediaLayoutTemplate | null = null;
function loadBodyZoneLayouts(rootDir: string): MediaLayoutTemplate {
  if (_cachedBzl) return _cachedBzl;
  const catalog = loadSlideLayoutPresetCatalog(rootDir);
  _cachedBzl = {
    version: catalog.version,
    chrome: catalog.chrome || {},
    hero: catalog.hero || {},
    body_zones: catalog.body_zones || {},
  };
  return _cachedBzl;
}

// Reads PNG dimensions from the image file and returns {w, h} in inches, preserving aspect ratio.
// targetH: desired display height in inches; maxW: optional cap on width.
function getPngDisplaySize(
  logoPath: string,
  targetH: number,
  maxW?: number
): { w: number; h: number } {
  try {
    const buf = safeReadFile(logoPath, { encoding: null }) as Buffer;
    if (
      buf &&
      buf.length >= 24 &&
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47
    ) {
      const pxW = buf.readUInt32BE(16);
      const pxH = buf.readUInt32BE(20);
      if (pxW > 0 && pxH > 0) {
        const aspect = pxW / pxH;
        let h = targetH;
        let w = Math.round(aspect * h * 1000) / 1000;
        if (maxW && w > maxW) {
          w = maxW;
          h = Math.round((maxW / aspect) * 1000) / 1000;
        }
        return { w, h };
      }
    }
  } catch {
    /* non-PNG or unreadable — fall through */
  }
  return { w: Math.round(targetH * 3 * 1000) / 1000, h: targetH };
}

/**
 * Map a semantic type onto a body zone.
 *
 * Most semantic types used to fall through to single-column, so a deck of
 * eight distinct meanings rendered as two or three visual shapes — correct,
 * but monotonous. Each type now reaches a zone that suits how its content is
 * actually read; anything genuinely prose-shaped still lands on single-column
 * by design rather than by omission.
 */
function resolveBodyZoneLayout(semanticType: string): string {
  switch (semanticType) {
    case 'problem':
    case 'evidence':
      return 'two-column-callout';
    case 'roi':
      // Numbers-forward: a metric band reads better than a prose callout.
      return 'metrics-band';
    case 'signals':
      return 'metrics-band';
    case 'control':
      return 'two-column-risk';
    case 'plan':
    case 'roadmap':
      return 'timeline';
    case 'solution':
    case 'architecture':
      return 'architecture-panel';
    case 'decision':
    case 'cta':
      return 'decision-cta';
    case 'contents':
      return 'contents-index';
    case 'summary':
      // The headline message of a deck deserves to be held, not listed.
      return 'statement';
    case 'comparison':
    case 'options':
      return 'comparison-two-col';
    case 'execution':
    case 'table':
      return 'table-feature';
    case 'appendix':
      return 'checklist-grid';
    default:
      return 'single-column';
  }
}

let _cachedLayoutTemplates: MediaLayoutTemplateCatalog | null = null;
function loadLayoutTemplateCatalog(rootDir: string): MediaLayoutTemplateCatalog {
  if (_cachedLayoutTemplates) return _cachedLayoutTemplates;
  const catalog = loadSlideLayoutPresetCatalog(rootDir);
  _cachedLayoutTemplates = {
    version: catalog.version,
    default: catalog.default || 'corporate-standard',
    templates: catalog.templates || {},
  };
  return _cachedLayoutTemplates;
}

function loadLayoutTemplateCatalogFromPath(filePath: string): MediaLayoutTemplateCatalog {
  const catalogPath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const fallback: MediaLayoutTemplateCatalog = {
    version: '1.0.0',
    default: 'corporate-standard',
    templates: {},
  };
  return defineCatalog<MediaLayoutTemplateCatalog>({
    id: 'layout-template-catalog',
    path: catalogPath,
    schema: pathResolver.rootResolve(
      'knowledge/product/schemas/layout-template-catalog.schema.json'
    ),
    fallback,
    fallbackOnInvalid: true,
  }).load();
}

function resolveLayoutTemplate(
  rootDir: string,
  designSystemId: string | undefined,
  slideData?: any,
  theme?: any
): MediaLayoutTemplate {
  const themeTemplateCatalog =
    theme?.layout_templates ||
    theme?.pptx?.layout_templates ||
    theme?.web?.layout_templates ||
    null;
  if (themeTemplateCatalog?.templates) {
    const templateId =
      slideData?.layout_template_id || themeTemplateCatalog.default || theme?.layout_template_id;
    const tpl =
      themeTemplateCatalog.templates?.[templateId] ||
      themeTemplateCatalog.templates?.[themeTemplateCatalog.default];
    if (tpl) return tpl;
  }
  const designSystems = loadMediaDesignSystemsCatalog(rootDir);
  const system = designSystemId ? designSystems.systems?.[designSystemId] : null;
  const brandName: string = slideData?.branding?.brand_name || '';
  const tenantOverride = resolveConfidentialTenantOverride(rootDir, brandName, designSystemId);
  // Priority 1: tenant override with an explicit confidential catalog path
  if (tenantOverride?.layout_template_catalog) {
    try {
      const catalog = loadLayoutTemplateCatalogFromPath(
        path.resolve(rootDir, tenantOverride.layout_template_catalog)
      );
      const templateId = tenantOverride.layout_template_id || catalog.default;
      const tpl = catalog.templates?.[templateId];
      if (tpl) return tpl;
    } catch {
      /* fall through to public catalog */
    }
  }
  // Priority 2: template ID resolved from the public catalog
  const templateId: string | null =
    tenantOverride?.layout_template_id || system?.layout_template_id || null;
  if (templateId) {
    const catalog = loadLayoutTemplateCatalog(rootDir);
    const tpl = catalog.templates?.[templateId];
    if (tpl) return tpl;
  }
  return loadBodyZoneLayouts(rootDir);
}

function resolveBodyZoneKey(
  semanticType: string,
  designSystemId: string | undefined,
  rootDir: string
): string {
  const designSystems = loadMediaDesignSystemsCatalog(rootDir);
  const system = designSystemId ? designSystems.systems?.[designSystemId] : null;
  const mapped: string | undefined = system?.body_zone_map?.[semanticType];
  if (mapped) return mapped;
  return resolveBodyZoneLayout(semanticType).replace(/-/g, '_');
}

/**
 * MP-03: the type ramp floors used when fitting body text.
 *
 * Resolved once per slide from the single design entry point so the floor a
 * box may shrink to is a brand decision, not a constant buried in this file.
 * Falls back to the built-in ramp when the tenant lookup fails, because a
 * missing brand file must not make text unbounded.
 */
interface TypeFloors {
  bodyMinPt: number;
  labelMinPt: number;
  headlineMinPt: number;
  displayMinPt: number;
  captionMinPt: number;
}

const typeFloorsCache = new Map<string, TypeFloors>();

function resolveTypeFloors(tenantSlug?: string): TypeFloors {
  const cacheKey = `${pathResolver.rootDir()}::${tenantSlug || ''}`;
  const cached = typeFloorsCache.get(cacheKey);
  if (cached) return cached;
  try {
    const surface = resolvePptxSurfaceDesign(tenantSlug);
    const floors = {
      bodyMinPt: Math.max(
        surface.typography.roles.body.min_size_pt,
        surface.constraints.min_body_pt
      ),
      labelMinPt: Math.max(
        surface.typography.roles.label.min_size_pt,
        surface.constraints.min_label_pt
      ),
      headlineMinPt: surface.typography.roles.headline.min_size_pt,
      displayMinPt: surface.typography.roles.display.min_size_pt,
      captionMinPt: surface.typography.roles.caption.min_size_pt,
    };
    typeFloorsCache.set(cacheKey, floors);
    return floors;
  } catch {
    const fallback = {
      bodyMinPt: 10,
      labelMinPt: 8,
      headlineMinPt: 18,
      displayMinPt: 24,
      captionMinPt: 8,
    };
    typeFloorsCache.set(cacheKey, fallback);
    return fallback;
  }
}

export interface FittedTextBox {
  fontSize: number;
  designedFontSize: number;
  lineSpacingPct: number;
  fit: LayoutFitResult;
}

/**
 * Fit body text to its box before the element is emitted.
 *
 * Sizes used to be constants regardless of how much text arrived, so long or
 * Japanese-heavy bodies ran past the frame. Measuring here keeps the designed
 * size whenever it fits and shrinks toward the ramp floor when it does not;
 * text that overflows even at the floor is reported so the caller can surface
 * it rather than rendering a broken slide silently.
 */
function fitBodyText(
  text: string,
  box: { widthIn: number; heightIn: number },
  style: {
    fontSize: number;
    minFontSize: number;
    lineSpacingPct?: number;
    margin?: [number, number, number, number];
  }
): FittedTextBox {
  const fit = fitTextToBox({
    text,
    widthIn: box.widthIn,
    heightIn: box.heightIn,
    fontSizePt: style.fontSize,
    minFontSizePt: style.minFontSize,
    lineSpacingPct: style.lineSpacingPct,
    marginIn: style.margin,
  });
  return {
    fontSize: fit.fontSizePt,
    designedFontSize: style.fontSize,
    lineSpacingPct: style.lineSpacingPct ?? 120,
    fit,
  };
}

/**
 * Region-declarative body zones.
 *
 * The original six zones are each a hand-written branch, which is why the
 * layout vocabulary stopped growing: a new zone meant new geometry code, so
 * every unmapped semantic type fell back to single_column and decks looked
 * the same regardless of content. Zones defined with `regions` are built from
 * their JSON alone, so adding one is adding data.
 */
export interface ZoneRegionSpec {
  id: string;
  type: 'text' | 'panel';
  source: string;
  text?: string;
  pos: Record<string, number | string>;
  font_size?: number;
  line_spacing_pct?: number;
  margin?: [number, number, number, number];
  fill?: string;
  color?: string;
  bold?: boolean;
  align?: string;
  valign?: string;
}

/** Anchors a region's geometry may reference, resolved from the chrome. */
export interface ZoneAnchors {
  body_x: number;
  body_y: number;
  body_w: number;
  body_h: number;
}

function resolveZoneCoord(
  spec: Record<string, number | string>,
  key: 'x' | 'y' | 'w' | 'h',
  anchors: ZoneAnchors
): number {
  const raw = spec[key];
  const base =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw in anchors
        ? anchors[raw as keyof ZoneAnchors]
        : 0;
  const offset = Number(spec[`${key}_offset`] ?? 0);
  return Math.round((base + offset) * 1000) / 1000;
}

/**
 * Select a region's text. Splits are measured (`body_balanced_*`) rather than
 * ratio-guessed, so a heavy line and a one-word bullet are not treated as
 * equal weight.
 */
function resolveZoneRegionText(
  source: string,
  context: {
    bodyLines: string[];
    balanced: { left: string[]; right: string[] };
    objective: string;
    cta: string;
    title: string;
    literal?: string;
  }
): string {
  const [kind, arg] = String(source || '').split(':');
  const count = Number(arg);
  switch (kind) {
    case 'literal':
      return context.literal ?? '';
    case 'body_all':
      return context.bodyLines.join('\n');
    case 'body_head':
      return context.bodyLines.slice(0, Math.max(1, count || 1)).join('\n');
    case 'body_tail':
      // A negative count drops that many leading lines instead of taking a tail.
      return (
        count < 0 ? context.bodyLines.slice(-count) : context.bodyLines.slice(-(count || 1))
      ).join('\n');
    case 'body_balanced_left':
      return context.balanced.left.join('\n');
    case 'body_balanced_right':
      return context.balanced.right.join('\n');
    case 'body_last':
      return context.bodyLines[context.bodyLines.length - 1] ?? '';
    case 'objective':
      return context.objective;
    case 'cta':
      return context.cta;
    case 'title':
      return context.title;
    default:
      return context.bodyLines.join('\n');
  }
}

/**
 * Take as many leading lines as fit a fixed-height box, keeping at least one.
 * Replaces count-based guesses like `Math.min(3, lines.length - 1)`.
 */
function takeLinesThatFit(
  lines: string[],
  box: {
    widthIn: number;
    heightIn: number;
    fontSizePt: number;
    lineSpacingPct?: number;
    marginIn?: [number, number, number, number];
    maxLines: number;
  }
): string[] {
  const limit = Math.max(1, Math.min(box.maxLines, lines.length));
  let taken = 1;
  for (let count = 1; count <= limit; count += 1) {
    const measured = measureTextBlock(lines.slice(0, count).join('\n'), {
      fontSizePt: box.fontSizePt,
      widthIn: box.widthIn,
      lineSpacingPct: box.lineSpacingPct,
      marginIn: box.marginIn,
    });
    if (measured.requiredHeightIn > box.heightIn) break;
    taken = count;
  }
  return lines.slice(0, taken);
}

export {
  MEDIA_MANIFEST_PATH,
  DEFAULT_MEDIA_RETRY,
  cloneJsonValue,
  buildRetryOptions,
  mergePptxShape,
  resolveSlideTemplate,
  loadSlideLayoutPresetCatalog,
  resolveRuntimeSlidePreset,
  loadJsonValue,
  loadBodyZoneLayouts,
  getPngDisplaySize,
  resolveBodyZoneLayout,
  loadLayoutTemplateCatalog,
  loadLayoutTemplateCatalogFromPath,
  loadTenantEntries,
  resolveConfidentialTenantOverride,
  resolveLayoutTemplate,
  resolveBodyZoneKey,
  resolveTypeFloors,
  fitBodyText,
  resolveZoneCoord,
  resolveZoneRegionText,
  takeLinesThatFit,
};
