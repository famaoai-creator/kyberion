import { draftDeckSectionBodies, selectDeckTheme } from '@agent/core';
import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
  safeLstat,
  safeStat,
  safeExec,
  safeExecResult,
  derivePipelineStatus,
  pathResolver,
  pptxUtils,
  xlsxUtils,
  docxUtils,
  loadProjectRecord,
  loadServiceBindingRecord,
  resolveRef,
  resolveVars,
  handleStepError,
  buildGovernedRetryOptions,
  classifyError,
  createActuatorTrace,
  finalizeActuatorTrace,
  resolveMediaToneStyle,
  resolveMediaDrawioBoundaryPalette,
  resolveMediaDrawioNodeSize,
  resolveMediaAwsIconCandidates,
  resolveMediaSemanticType,
  resolveProposalEvidenceIndex,
  resolveSignalToneRank,
  resolveBorderKeySides,
  resolveDocumentContentsLabel,
  resolveDocumentContentsSubtitle,
  resolveReportSectionTitle,
  resolveReportSummaryTitle,
  resolveThemeColorRole as resolveThemeColorRolePolicy,
  resolveThemeHexRole as resolveThemeHexRolePolicy,
  resolveDrawioEdgeLabelStyleParts,
  resolveDrawioEdgeRoutingStyleParts,
  resolveDrawioBoundaryIconCandidates,
  resolveDrawioBoundaryPaletteOverride,
  resolveMediaDrawioTierRank,
  resolveMediaDrawioGroupRank,
  resolveMediaDrawioTypeRank,
  resolveMediaDrawioSecurityGroupRelationPrefix,
  resolveDocumentTypeFromClues as resolveDocumentTypeFromCluesPolicy,
  resolveDocumentProfileCandidates as resolveDocumentProfileCandidatesPolicy,
  resolveDocumentProfileKeywords as resolveDocumentProfileKeywordsPolicy,
  resolveProposalSectionKeywords,
  isLegacyMediaOp,
  retry,
  fitTextToBox,
  measureTextBlock,
  splitLinesBalanced,
  resolvePptxSurfaceDesign,
  detectRasterCapabilities,
  rasterizeDocument,
  rasterizeHtml,
  assertVisualReviewPathScope,
  runVisualReview,
  runVisualReviewLoop,
  loadVisualReviewRubric,
  formatVisualReviewReport,
  ensureReadableOn,
  lockMediaBrief,
  inferredDecisions,
  formatBriefForConfirmation,
  type LayoutFitResult,
} from '@agent/core';
import { validateThemeContrast } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  distillPdfDesign,
  extractPptxSlides,
  filterPptxSlides,
  generateNativeDocx,
  generateNativePdf,
  generateNativePptx,
  generateNativeXlsx,
  patchPptxText,
  patchPptxParagraphs,
  protocolToMarkdown,
  type PdfDesignProtocol,
} from '@agent/core/media-contracts';
import {
  buildPptxProtocolFromPdfDesign as buildPptxProtocolFromPdfDesignHelper,
  buildXlsxProtocolFromPdfDesign as buildXlsxProtocolFromPdfDesignHelper,
  DEFAULT_PDF_TO_PPTX_HINTS,
  DEFAULT_PDF_TO_XLSX_HINTS,
  type PdfToPptxHints,
  type PdfToXlsxHints,
} from './media-pdf-protocol-helpers.js';
import {
  handleMediaAction,
  type MediaAction,
  type MediaPipelineStep,
} from './media-pipeline-helpers.js';
import { recognizeDocumentImage } from './media-ocr.js';
import { createProposalPptxFlow } from './proposal-pptx-helpers.js';
import {
  createMediaDocumentPipelineHelpers,
  assertMediaProtocolLayoutReady,
  summarizeMediaPptxLayout,
} from './media-document-pipeline-helpers.js';
import { registerPresentationPreferenceProfileOp } from './presentation-preference-ops.js';
import {
  warnLegacyMediaOp,
  buildMediaGenerationBoundary,
  resolveMediaBriefCategory,
  normalizeBriefForCategory,
  buildCompositionTokenMap,
  type MediaBriefCategory,
  type ProtocolKind,
  type DocumentCompositionPresetResolver,
  chooseDocumentSectionEvidence,
  classifyRenderSemantic,
  buildDocumentContentsSection,
  insertDocumentContentsSection,
  chooseProposalSectionEvidence,
  buildReportNarrativeOutline,
  buildSpreadsheetNarrativeOutline,
  buildDiagramNarrativeOutline,
  buildUnifiedDocumentBrief,
  normalizeInvoiceDocumentBrief,
  normalizeDiagramDocumentBrief,
  normalizeSpreadsheetDocumentBrief,
  normalizeReportDocumentBrief,
} from './media-document-helpers.js';
import * as mediaPdfHelpers from './media-pdf-helpers.js';
import {
  buildMermaidConfig,
  resolveGraphDefinition,
  resolveDrawioIconMap,
  loadFallbackDrawioTheme,
} from './media-diagram-helpers.js';
import {
  resolveDiagramSource,
  resolveDiagramTheme,
  generateDrawioDocument,
  extractChromeGeometryFromPptxDesign,
  deriveLayoutTemplateFromPptxDesign,
  matchLayoutTemplate,
  deriveThemeFromPptxDesign,
  normalizeFontFamily,
} from './media-diagram-render-helpers.js';
import { createMediaReportPipelineHelpers } from './media-report-pipeline-helpers.js';
import { projectXlsxDesign } from './xlsx-extract-projection.js';
import {
  createMediaSpreadsheetPipelineHelpers,
  columnNumberToLetter,
  inferPrimitiveCellType,
  normalizeXlsxDesignProtocol,
} from './media-spreadsheet-pipeline-helpers.js';
import * as path from 'node:path';
import { findSlidesByOwner, pptxDiff, type MediaSlideText } from './media-slide-ops.js';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as excelUtils from '@agent/shared-media';
import { PDFParse } from 'pdf-parse';
import { runActuatorCli } from '@agent/core';
import { resolveEastAsianFontFamily, resolveLatinFontFamily } from '@agent/core/design-fonts';

const MEDIA_MANIFEST_PATH = pathResolver.rootResolve('libs/actuators/media-actuator/manifest.json');
const DEFAULT_MEDIA_RETRY = {
  maxRetries: 2,
  initialDelayMs: 500,
  maxDelayMs: 10000,
  factor: 2,
  jitter: true,
};

function cloneJsonValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function buildRetryOptions(override?: Record<string, any>) {
  return buildGovernedRetryOptions({
    manifestPath: MEDIA_MANIFEST_PATH,
    defaults: DEFAULT_MEDIA_RETRY,
    override: override,
    fallbackCategories: ['network', 'rate_limit', 'timeout', 'resource_unavailable'],
  });
}

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

function loadSlideLayoutPresetCatalog(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/slide-layout-presets',
    filePath: 'knowledge/public/design-patterns/media-templates/slide-layout-presets.json',
    fallback: { defaults: {}, presets: {} },
  });
}

function resolveRuntimeSlidePreset(rootDir: string, slideData: any): any {
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

let _cachedBzl: any = null;
function loadBodyZoneLayouts(rootDir: string): any {
  if (_cachedBzl) return _cachedBzl;
  const p = path.join(
    rootDir,
    'knowledge/public/design-patterns/media-templates/slide-layout-presets/body-zone-layouts.json'
  );
  _cachedBzl = JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string);
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

let _cachedLayoutTemplates: any = null;
function loadLayoutTemplateCatalog(rootDir: string): any {
  if (_cachedLayoutTemplates) return _cachedLayoutTemplates;
  try {
    const p = path.join(
      rootDir,
      'knowledge/public/design-patterns/media-templates/slide-layout-presets/layout-templates.json'
    );
    _cachedLayoutTemplates = JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string);
  } catch {
    _cachedLayoutTemplates = { default: 'corporate-standard', templates: {} };
  }
  return _cachedLayoutTemplates;
}

let _cachedTenantRegistry: any = null;

/** Build entry list from index.json, or fall back to directory-scanning knowledge/confidential/. */
function loadTenantEntries(rootDir: string): { override_path: string }[] {
  const entries: { override_path: string }[] = [];
  const indexPath = path.join(rootDir, 'knowledge/confidential/tenants/index.json');
  try {
    const registry = JSON.parse(safeReadFile(indexPath, { encoding: 'utf8' }) as string);
    if (Array.isArray(registry.tenants)) {
      entries.push(...registry.tenants.filter((entry: any) => entry?.override_path));
    }
  } catch {
    /* index.json absent or unreadable — fall through to directory scan */
  }
  // Fallback: scan knowledge/confidential/*/design/tenant-override.json
  try {
    const confidentialDir = path.join(rootDir, 'knowledge/confidential');
    const names = safeReaddir(confidentialDir);
    const slugs = names.filter((name) => {
      try {
        return safeStat(path.join(confidentialDir, name)).isDirectory();
      } catch {
        return false;
      }
    });
    entries.push(
      ...slugs.map((s: string) => ({
        override_path: `knowledge/confidential/${s}/design/tenant-override.json`,
      }))
    );
  } catch {
    /* confidential directory absent or unreadable */
  }
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry.override_path || seen.has(entry.override_path)) return false;
    seen.add(entry.override_path);
    return true;
  });
}

function resolveConfidentialTenantOverride(
  rootDir: string,
  brandName: string,
  designSystemId?: string
): any {
  if (!brandName) return null;
  try {
    if (!_cachedTenantRegistry) {
      _cachedTenantRegistry = { entries: loadTenantEntries(rootDir) };
    }
    const key = brandName.toLowerCase();
    for (const entry of _cachedTenantRegistry.entries || []) {
      const overridePath = path.resolve(rootDir, entry.override_path);
      try {
        const override = JSON.parse(safeReadFile(overridePath, { encoding: 'utf8' }) as string);
        if (
          designSystemId &&
          override.design_system_id &&
          override.design_system_id !== designSystemId
        )
          continue;
        const matched =
          Array.isArray(override.matchers) &&
          override.matchers.some((m: string) => key.includes(m.toLowerCase()));
        if (matched) return override;
      } catch {
        /* skip unreadable override */
      }
    }
  } catch {
    /* unexpected failure */
  }
  return null;
}

function resolveLayoutTemplate(
  rootDir: string,
  designSystemId: string | undefined,
  slideData?: any,
  theme?: any
): any {
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
      const catalogPath = path.resolve(rootDir, tenantOverride.layout_template_catalog);
      const catalog = JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string);
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

interface FittedTextBox {
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
interface ZoneRegionSpec {
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
interface ZoneAnchors {
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

function buildPptxSlideFromPattern(
  rootDir: string,
  data: any,
  idx: number,
  theme: any,
  pattern: any,
  activeMaster: any,
  canvas: any
) {
  const themeColors = resolveThemeColors(theme);
  const primaryHex = (themeColors.primary || '#3867D6').replace('#', '');
  const accentHex = (themeColors.accent || '#0070C0').replace('#', '');
  const textHex = (themeColors.text || '#000000').replace('#', '');
  const semanticType =
    data.semantic_type || classifyRenderSemantic(data.layout_key, data.media_kind);
  const semanticTokens = resolveSemanticRenderTokens(rootDir, semanticType, data.design_system_id);
  const pptxTokens = semanticTokens.pptx || {};
  const pageLayouts = pattern?.page_layouts || {};
  const pageLayoutId = data.page_layout || data.page_layout_id || data.layout_id;
  const pageLayout = pageLayoutId ? pageLayouts[pageLayoutId] : undefined;
  const runtimePreset = resolveRuntimeSlidePreset(rootDir, data);
  const placeholderConfig = {
    ...(runtimePreset || {}),
    ...(pageLayout?.placeholders || {}),
  };
  const bodyLines: string[] = Array.isArray(data.body) ? data.body : data.body ? [data.body] : [];
  const bodyText = bodyLines.join('\n');
  const elements: any[] = [];

  // Resolve logo from branding > theme assets. No cross-tenant fallback: a
  // hardcoded default tenant's logo must never render on another tenant's
  // deck, and reading another tenant's confidential/ path is a tier-guard
  // violation anyway. Absent an explicit logo_url, render without a logo.
  const rawLogoPath =
    data.branding?.logo_url || theme?.assets?.logo_url || theme?.theme?.assets?.logo_url || null;
  const logoPath = rawLogoPath ? path.resolve(rootDir, rawLogoPath) : null;
  const logoExists = logoPath ? safeExistsSync(logoPath) : false;
  const brandName = data.branding?.brand_name || theme?.name || theme?.theme?.name || '';

  /**
   * Boxes whose text did not fit even at the ramp floor. Surfaced in slide
   * metadata so an overflowing deck is visible to the caller instead of
   * shipping with text running off the frame.
   */
  const overflows: Array<{ zone: string; fillRatio: number; overflowAtParagraph?: number }> = [];
  const shrunkZones: Array<{ zone: string; fontSize: number; designedFontSize: number }> = [];
  const recordFit = (zone: string, fitted: FittedTextBox): FittedTextBox => {
    if (fitted.fit.strategy === 'shrunk') {
      shrunkZones.push({
        zone,
        fontSize: fitted.fontSize,
        designedFontSize: fitted.designedFontSize,
      });
    }
    if (!fitted.fit.fits) {
      overflows.push({
        zone,
        fillRatio: Number(fitted.fit.fillRatio.toFixed(3)),
        ...(fitted.fit.overflowAtParagraph !== undefined
          ? { overflowAtParagraph: fitted.fit.overflowAtParagraph }
          : {}),
      });
    }
    return fitted;
  };

  /** Body zone actually used, recorded for zone-diversity measurement. */
  let renderedBodyZone = 'none';

  const isHero = semanticType === 'hero';
  const themeFonts = theme?.fonts || theme?.theme?.fonts || {};
  const headingFont = resolveLatinFontFamily(themeFonts.heading);
  const bodyFont = resolveLatinFontFamily(themeFonts.body);
  const bzl = resolveLayoutTemplate(rootDir, data.design_system_id, data, theme);
  const chr = bzl.chrome;
  const hro = bzl.hero;
  const typeFloors = resolveTypeFloors(data.branding?.tenant_slug || data.tenant_slug);

  if (Array.isArray(pageLayout?.elements)) {
    elements.push(...cloneJsonValue(pageLayout.elements));
  }

  if (isHero) {
    // ── Hero / Cover slide ──────────────────────────────────────────────────
    // Two-tone: primary-color top + white bottom panel for logo/brand strip

    // White bottom panel (logo sits here on clean white background)
    elements.push({
      type: 'shape',
      shapeType: 'rect',
      pos: { x: 0, y: hro.white_panel_y, w: 10, h: hro.white_panel_h },
      style: { fill: 'FFFFFF', color: 'FFFFFF' },
      text: '',
    });

    // Thin accent line separating blue from white
    elements.push({
      type: 'shape',
      shapeType: 'rect',
      pos: { x: 0, y: hro.separator_y, w: 10, h: hro.separator_h },
      style: { fill: accentHex, color: accentHex },
      text: '',
    });

    // Main title — centered on blue area
    if (data.title && placeholderConfig.title !== false) {
      const titleEl = mergePptxShape(
        {
          type: 'text',
          placeholderType: 'title',
          pos: { x: hro.title_x, y: hro.title_y, w: hro.title_w, h: hro.title_h },
          text: data.title,
          style: {
            fontSize: hro.title_font_size,
            bold: true,
            color: 'FFFFFF',
            fontFamily: headingFont,
            align: 'center',
            valign: 'middle',
          },
        },
        placeholderConfig.title
      );
      const titleFit = recordFit(
        'hero.title',
        fitBodyText(
          data.title,
          { widthIn: hro.title_w, heightIn: hro.title_h },
          {
            fontSize: hro.title_font_size,
            minFontSize: typeFloors.displayMinPt,
          }
        )
      );
      titleEl.style = { ...(titleEl.style || {}), fontSize: titleFit.fontSize };
      titleEl.text = resolveSlideTemplate(titleEl.text, data, data.title);
      elements.push(titleEl);
    }

    // Subtitle — on blue, just above divider
    if (bodyText && placeholderConfig.body !== false) {
      const subtitleEl = mergePptxShape(
        {
          type: 'text',
          placeholderType: 'body',
          pos: { x: hro.subtitle_x, y: hro.subtitle_y, w: hro.subtitle_w, h: hro.subtitle_h },
          text: bodyText,
          style: {
            fontSize: hro.subtitle_font_size,
            color: 'D0E4FF',
            fontFamily: bodyFont,
            align: 'center',
            valign: 'middle',
          },
        },
        placeholderConfig.body
      );
      const subtitleFit = recordFit(
        'hero.subtitle',
        fitBodyText(
          bodyText,
          { widthIn: hro.subtitle_w, heightIn: hro.subtitle_h },
          {
            fontSize: hro.subtitle_font_size,
            minFontSize: typeFloors.bodyMinPt,
          }
        )
      );
      subtitleEl.style = { ...(subtitleEl.style || {}), fontSize: subtitleFit.fontSize };
      subtitleEl.text = resolveSlideTemplate(subtitleEl.text, data, bodyText);
      elements.push(subtitleEl);
    }

    // Logo on white panel — right-aligned, actual aspect ratio from PNG header
    if (logoExists) {
      const ls = getPngDisplaySize(logoPath, hro.logo_display_h, hro.logo_display_max_w);
      elements.push({
        type: 'image',
        imagePath: logoPath,
        pos: { x: 10 - ls.w - hro.logo_right_margin, y: hro.logo_y, w: ls.w, h: ls.h },
      });
    }

    // Brand name on white panel — left-aligned (slide number placeholder style)
    if (brandName) {
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        pos: { x: hro.brand_name_x, y: hro.brand_name_y, w: hro.brand_name_w, h: hro.brand_name_h },
        style: {
          fill: 'FFFFFF',
          color: primaryHex,
          fontSize: hro.brand_name_font_size,
          align: 'left',
          valign: 'middle',
        },
        text: brandName,
      });
    }
  } else {
    // ── Standard content slides ─────────────────────────────────────────────
    // SBISS design: full-height blue header bar with white title text,
    // white logo box on right side of header, navy separator, body below.
    const bodyZoneKey = resolveBodyZoneKey(semanticType, data.design_system_id, rootDir);
    renderedBodyZone = bodyZoneKey;
    const bodyY = chr.body_y;
    const bodyH = chr.body_h;
    const bodyX = chr.body_x;
    const bodyW = chr.body_w;
    // Resolve colors from theme; fall back to neutral corporate defaults
    const navyHex = resolveThemeHexColor(themeColors, 'navy', '#003366').replace('#', '');
    const azureHex = resolveThemeHexColor(themeColors, 'cta', '#0070C0').replace('#', '');
    const surfaceBg = resolveThemeHexColor(themeColors, 'surface', '#E9EDF4').replace('#', '');
    const bodyTextColor = resolveThemeHexColor(themeColors, 'text_primary', '#000000').replace(
      '#',
      ''
    );
    const subTextColor = resolveThemeHexColor(themeColors, 'text_secondary', '#595959').replace(
      '#',
      ''
    );

    // A theme missing a role falls back to a neighbouring one, which is how a
    // panel can end up with identical fill and text color and render its body
    // invisible. Resolve panel text against its own fill rather than trusting
    // the roles to differ.
    const onSurface = (preferred: string) => ensureReadableOn(surfaceBg, preferred);
    const panelBodyColor = onSurface(navyHex);

    // 1. Full-height blue header bar
    elements.push({
      type: 'shape',
      shapeType: 'rect',
      pos: { x: 0, y: 0, w: 10, h: chr.header_h },
      style: { fill: primaryHex, color: primaryHex },
      text: '',
    });

    // 2. White logo zone; logo sized from actual PNG dimensions (tenant-agnostic)
    if (logoExists) {
      elements.push({
        type: 'shape',
        shapeType: 'rect',
        pos: { x: chr.logo_zone_x, y: chr.logo_zone_y, w: chr.logo_zone_w, h: chr.logo_zone_h },
        style: { fill: 'FFFFFF', color: 'FFFFFF' },
        text: '',
      });
      const ls = getPngDisplaySize(logoPath, chr.logo_display_h, chr.logo_display_max_w);
      elements.push({
        type: 'image',
        imagePath: logoPath,
        pos: {
          x: chr.logo_zone_x + (chr.logo_zone_w - ls.w) / 2,
          y: chr.logo_zone_y + (chr.logo_zone_h - ls.h) / 2,
          w: ls.w,
          h: ls.h,
        },
      });
    }

    // 3. Slide title in blue header — white text, bold
    if (data.title && placeholderConfig.title !== false) {
      const titleAlign = bodyZoneKey === 'decision_cta' ? 'center' : 'left';
      const titleW = logoExists ? chr.title_w_logo : chr.title_w_no_logo;
      const titleFit = recordFit(
        'standard.title',
        fitBodyText(
          data.title,
          { widthIn: titleW, heightIn: chr.header_h },
          {
            fontSize: chr.title_font_size,
            minFontSize: typeFloors.headlineMinPt,
            margin: [0, 0, 0, 0.06],
          }
        )
      );
      elements.push({
        type: 'text',
        placeholderType: 'title',
        pos: {
          x: chr.title_x,
          y: 0,
          w: titleW,
          h: chr.header_h,
        },
        text: resolveSlideTemplate(data.title, data, data.title),
        style: {
          fontSize: titleFit.fontSize,
          bold: true,
          color: 'FFFFFF',
          fontFamily: headingFont,
          align: titleAlign,
          valign: 'middle',
          margin: [0, 0, 0, 0.06],
        },
      });
    }

    // 4. Navy separator line below header
    elements.push({
      type: 'shape',
      shapeType: 'rect',
      pos: { x: 0, y: chr.header_h, w: 10, h: chr.separator_h },
      style: { fill: navyHex, color: navyHex },
      text: '',
    });

    // 5. Left accent strip
    elements.push({
      type: 'shape',
      shapeType: 'rect',
      pos: { x: chr.accent_strip_x, y: bodyY, w: chr.accent_strip_w, h: bodyH },
      style: { fill: primaryHex, color: primaryHex },
      text: '',
    });

    // 6. Body zone — layout-dispatched
    if (bodyText && placeholderConfig.body !== false) {
      if (bodyZoneKey === 'two_column_callout') {
        const zc = bzl.body_zones.two_column_callout;
        const { left: leftLines, right: rightLines } = splitLinesBalanced({
          lines: bodyLines,
          columnWidthIn: zc.left_w,
          rightColumnWidthIn: zc.right_w,
          fontSizePt: zc.left_font_size,
          marginIn: zc.left_margin,
          lineSpacingPct: zc.left_line_spacing_pct,
        });
        const rightText =
          rightLines.join('\n') || data.objective || leftLines[leftLines.length - 1] || '';
        const calloutLabels = zc.semantic_labels || {};
        const calloutLabel =
          calloutLabels[semanticType] ?? calloutLabels['default'] ?? '  根拠データ';
        if (leftLines.length > 0) {
          const leftText = leftLines.join('\n');
          const fitted = recordFit(
            'two_column_callout.left',
            fitBodyText(
              leftText,
              { widthIn: zc.left_w, heightIn: bodyH },
              {
                fontSize: zc.left_font_size,
                minFontSize: typeFloors.bodyMinPt,
                lineSpacingPct: zc.left_line_spacing_pct,
                margin: zc.left_margin,
              }
            )
          );
          elements.push({
            type: 'text',
            placeholderType: 'body',
            pos: { x: bodyX, y: bodyY, w: zc.left_w, h: bodyH },
            text: resolveSlideTemplate(leftText, data, leftText),
            style: {
              ...(placeholderConfig.body?.style || {}),
              fontSize: fitted.fontSize,
              color: bodyTextColor,
              fontFamily: bodyFont,
              align: 'left',
              valign: 'top',
              lineSpacingPct: zc.left_line_spacing_pct,
              margin: zc.left_margin,
            },
          });
        }
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: zc.right_x, y: bodyY, w: zc.right_w, h: zc.panel_h },
          style: {
            fill: primaryHex,
            color: 'FFFFFF',
            fontSize: zc.panel_header_font_size,
            bold: true,
            align: 'left',
            valign: 'middle',
            margin: zc.panel_header_margin,
          },
          text: calloutLabel,
        });
        const calloutPanelH = bodyH - zc.panel_h;
        const calloutPanelFit = recordFit(
          'two_column_callout.panel',
          fitBodyText(
            rightText,
            { widthIn: zc.right_w, heightIn: calloutPanelH },
            {
              fontSize: zc.panel_body_font_size,
              minFontSize: typeFloors.bodyMinPt,
              lineSpacingPct: zc.panel_body_line_spacing_pct,
              margin: zc.panel_body_margin,
            }
          )
        );
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: zc.right_x, y: bodyY + zc.panel_h, w: zc.right_w, h: calloutPanelH },
          style: {
            fill: surfaceBg,
            color: panelBodyColor,
            fontSize: calloutPanelFit.fontSize,
            align: 'left',
            valign: 'top',
            lineSpacingPct: zc.panel_body_line_spacing_pct,
            margin: zc.panel_body_margin,
          },
          text: rightText,
        });
        if (data.visual) {
          const vl = zc.visual_label || {};
          // Fitted like every other region: a label whose margins swallow its
          // own box renders one character per line, and only measuring catches
          // that before it ships.
          const labelFit = recordFit(
            'two_column_callout.visual_label',
            fitBodyText(
              String(data.visual),
              { widthIn: zc.right_w, heightIn: vl.h ?? 0.28 },
              {
                fontSize: vl.font_size ?? 9,
                minFontSize: typeFloors.labelMinPt,
                margin: vl.margin,
              }
            )
          );
          elements.push({
            type: 'text',
            pos: {
              x: zc.right_x,
              y: bodyY + bodyH - (vl.y_from_bottom ?? 0.32),
              w: zc.right_w,
              h: vl.h ?? 0.28,
            },
            text: data.visual,
            style: {
              fill: accentHex,
              color: 'FFFFFF',
              fontSize: labelFit.fontSize,
              align: 'left',
              valign: 'middle',
              margin: vl.margin ?? [0.02, 0.06, 0.02, 0.06],
            },
          });
        }
      } else if (bodyZoneKey === 'two_column_risk') {
        const zc = bzl.body_zones.two_column_risk;
        const { left: leftLines, right: rightLines } = splitLinesBalanced({
          lines: bodyLines,
          columnWidthIn: zc.left_w,
          rightColumnWidthIn: zc.right_w,
          fontSizePt: zc.left_font_size,
          marginIn: zc.left_margin,
          lineSpacingPct: zc.left_line_spacing_pct,
        });
        const rightText = rightLines.join('\n') || data.objective || '';
        if (leftLines.length > 0) {
          const leftText = leftLines.join('\n');
          const fitted = recordFit(
            'two_column_risk.left',
            fitBodyText(
              leftText,
              { widthIn: zc.left_w, heightIn: bodyH },
              {
                fontSize: zc.left_font_size,
                minFontSize: typeFloors.bodyMinPt,
                lineSpacingPct: zc.left_line_spacing_pct,
                margin: zc.left_margin,
              }
            )
          );
          elements.push({
            type: 'text',
            placeholderType: 'body',
            pos: { x: bodyX, y: bodyY, w: zc.left_w, h: bodyH },
            text: resolveSlideTemplate(leftText, data, leftText),
            style: {
              ...(placeholderConfig.body?.style || {}),
              fontSize: fitted.fontSize,
              color: bodyTextColor,
              fontFamily: bodyFont,
              align: 'left',
              valign: 'top',
              lineSpacingPct: zc.left_line_spacing_pct,
              margin: zc.left_margin,
            },
          });
        }
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: zc.right_x, y: bodyY, w: zc.right_w, h: zc.panel_h },
          style: {
            fill: zc.panel_header_fill ?? 'C00000',
            color: 'FFFFFF',
            fontSize: zc.panel_header_font_size,
            bold: true,
            align: 'left',
            valign: 'middle',
            margin: zc.panel_header_margin,
          },
          text: zc.panel_label ?? '  リスク対策',
        });
        const riskPanelH = bodyH - zc.panel_h;
        const riskPanelFit = recordFit(
          'two_column_risk.panel',
          fitBodyText(
            rightText,
            { widthIn: zc.right_w, heightIn: riskPanelH },
            {
              fontSize: zc.panel_body_font_size,
              minFontSize: typeFloors.bodyMinPt,
              lineSpacingPct: zc.panel_body_line_spacing_pct,
              margin: zc.panel_body_margin,
            }
          )
        );
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: zc.right_x, y: bodyY + zc.panel_h, w: zc.right_w, h: riskPanelH },
          style: {
            fill: zc.panel_body_fill ?? 'FFF0F0',
            color: zc.panel_body_color ?? '7F1D1D',
            fontSize: riskPanelFit.fontSize,
            align: 'left',
            valign: 'top',
            lineSpacingPct: zc.panel_body_line_spacing_pct,
            margin: zc.panel_body_margin,
          },
          text: rightText,
        });
      } else if (bodyZoneKey === 'timeline') {
        const zc = bzl.body_zones.timeline;
        const tlLabels = zc.semantic_labels || {};
        const tlLabel = tlLabels[semanticType] ?? tlLabels['default'] ?? '  ロードマップ';
        const timelineLeftFit = recordFit(
          'timeline.left',
          fitBodyText(
            bodyText,
            { widthIn: zc.left_w, heightIn: bodyH },
            {
              fontSize: zc.left_font_size,
              minFontSize: typeFloors.bodyMinPt,
              lineSpacingPct: zc.left_line_spacing_pct,
              margin: zc.left_margin,
            }
          )
        );
        elements.push({
          type: 'text',
          placeholderType: 'body',
          pos: { x: bodyX, y: bodyY, w: zc.left_w, h: bodyH },
          text: resolveSlideTemplate(bodyText, data, bodyText),
          style: {
            ...(placeholderConfig.body?.style || {}),
            fontSize: timelineLeftFit.fontSize,
            color: bodyTextColor,
            fontFamily: bodyFont,
            align: 'left',
            valign: 'top',
            lineSpacingPct: zc.left_line_spacing_pct,
            margin: zc.left_margin,
          },
        });
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: zc.right_x, y: bodyY, w: zc.right_w, h: zc.panel_h },
          style: {
            fill: primaryHex,
            color: 'FFFFFF',
            fontSize: zc.panel_header_font_size,
            bold: true,
            align: 'left',
            valign: 'middle',
            margin: zc.panel_header_margin,
          },
          text: tlLabel,
        });
        const timelineText = bodyLines.map((line: string) => `▶  ${line}`).join('\n\n');
        const timelinePanelH = bodyH - zc.panel_h;
        const timelinePanelFit = recordFit(
          'timeline.panel',
          fitBodyText(
            timelineText,
            { widthIn: zc.right_w, heightIn: timelinePanelH },
            {
              fontSize: zc.panel_body_font_size,
              minFontSize: typeFloors.bodyMinPt,
              lineSpacingPct: zc.panel_body_line_spacing_pct,
              margin: zc.panel_body_margin,
            }
          )
        );
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: zc.right_x, y: bodyY + zc.panel_h, w: zc.right_w, h: timelinePanelH },
          style: {
            fill: surfaceBg,
            color: panelBodyColor,
            fontSize: timelinePanelFit.fontSize,
            align: 'left',
            valign: 'top',
            lineSpacingPct: zc.panel_body_line_spacing_pct,
            margin: zc.panel_body_margin,
          },
          text: timelineText,
        });
        if (data.visual) {
          const vl = zc.visual_label || {};
          const labelFit = recordFit(
            'timeline.visual_label',
            fitBodyText(
              String(data.visual),
              { widthIn: zc.right_w, heightIn: vl.h ?? 0.28 },
              {
                fontSize: vl.font_size ?? 9,
                minFontSize: typeFloors.labelMinPt,
                margin: vl.margin,
              }
            )
          );
          elements.push({
            type: 'text',
            pos: {
              x: zc.right_x,
              y: bodyY + bodyH - (vl.y_from_bottom ?? 0.32),
              w: zc.right_w,
              h: vl.h ?? 0.28,
            },
            text: data.visual,
            style: {
              fill: vl.fill ?? 'DCFCE7',
              color: vl.color ?? '166534',
              fontSize: labelFit.fontSize,
              align: 'left',
              valign: 'middle',
              margin: vl.margin ?? [0.02, 0.06, 0.02, 0.06],
            },
          });
        }
      } else if (bodyZoneKey === 'architecture_panel') {
        const zc = bzl.body_zones.architecture_panel;
        // The description band is a fixed-height box, so how many lines belong
        // in it is a measurement question: take lines while they still fit.
        const descLines = takeLinesThatFit(bodyLines, {
          widthIn: bodyW,
          heightIn: zc.desc_h,
          fontSizePt: zc.desc_font_size,
          lineSpacingPct: zc.desc_line_spacing_pct,
          marginIn: zc.desc_margin,
          maxLines: Math.max(1, bodyLines.length - 1),
        });
        const archLines = bodyLines.slice(descLines.length);
        const descText = descLines.join('\n');
        const descFit = recordFit(
          'architecture_panel.desc',
          fitBodyText(
            descText,
            { widthIn: bodyW, heightIn: zc.desc_h },
            {
              fontSize: zc.desc_font_size,
              minFontSize: typeFloors.bodyMinPt,
              lineSpacingPct: zc.desc_line_spacing_pct,
              margin: zc.desc_margin,
            }
          )
        );
        elements.push({
          type: 'text',
          placeholderType: 'body',
          pos: { x: bodyX, y: bodyY, w: bodyW, h: zc.desc_h },
          text: resolveSlideTemplate(descText, data, descText),
          style: {
            ...(placeholderConfig.body?.style || {}),
            fontSize: descFit.fontSize,
            color: bodyTextColor,
            fontFamily: bodyFont,
            align: 'left',
            valign: 'top',
            lineSpacingPct: zc.desc_line_spacing_pct,
            margin: zc.desc_margin,
          },
        });
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: { x: bodyX, y: bodyY + zc.panel_header_y_offset, w: bodyW, h: zc.panel_header_h },
          style: {
            fill: primaryHex,
            color: 'FFFFFF',
            fontSize: zc.panel_header_font_size,
            bold: true,
            align: 'left',
            valign: 'middle',
            margin: zc.panel_header_margin,
          },
          text: zc.panel_label ?? '  システム構成概要',
        });
        const archText = (archLines.length > 0 ? archLines : bodyLines).join('\n');
        const archPanelH = bodyH - zc.panel_body_y_offset;
        const archFit = recordFit(
          'architecture_panel.panel',
          fitBodyText(
            archText,
            { widthIn: bodyW, heightIn: archPanelH },
            {
              fontSize: zc.panel_body_font_size,
              minFontSize: typeFloors.bodyMinPt,
              lineSpacingPct: zc.panel_body_line_spacing_pct,
              margin: zc.panel_body_margin,
            }
          )
        );
        elements.push({
          type: 'shape',
          shapeType: 'rect',
          pos: {
            x: bodyX,
            y: bodyY + zc.panel_body_y_offset,
            w: bodyW,
            h: archPanelH,
          },
          style: {
            fill: surfaceBg,
            color: panelBodyColor,
            fontSize: archFit.fontSize,
            align: 'left',
            valign: 'top',
            lineSpacingPct: zc.panel_body_line_spacing_pct,
            margin: zc.panel_body_margin,
          },
          text: archText,
        });
      } else if (bodyZoneKey === 'decision_cta') {
        const zc = bzl.body_zones.decision_cta;
        const ctaLine = bodyLines.length > 1 ? bodyLines[bodyLines.length - 1] : '';
        const msgLines = ctaLine ? bodyLines.slice(0, -1) : bodyLines;
        const msgText = msgLines.join('\n');
        if (msgText) {
          const msgFit = recordFit(
            'decision_cta.message',
            fitBodyText(
              msgText,
              { widthIn: bodyW, heightIn: zc.msg_h },
              {
                fontSize: zc.msg_font_size,
                minFontSize: typeFloors.bodyMinPt,
                lineSpacingPct: zc.msg_line_spacing_pct,
                margin: zc.msg_margin,
              }
            )
          );
          elements.push({
            type: 'text',
            placeholderType: 'body',
            pos: { x: bodyX, y: bodyY + zc.msg_y_offset, w: bodyW, h: zc.msg_h },
            text: resolveSlideTemplate(msgText, data, msgText),
            style: {
              ...(placeholderConfig.body?.style || {}),
              fontSize: msgFit.fontSize,
              color: navyHex,
              fontFamily: bodyFont,
              align: 'center',
              valign: 'middle',
              lineSpacingPct: zc.msg_line_spacing_pct,
              margin: zc.msg_margin,
            },
          });
        }
        if (ctaLine) {
          const ctaFit = recordFit(
            'decision_cta.cta',
            fitBodyText(
              ctaLine,
              { widthIn: zc.cta_w, heightIn: zc.cta_h },
              { fontSize: zc.cta_font_size, minFontSize: typeFloors.labelMinPt }
            )
          );
          elements.push({
            type: 'shape',
            shapeType: 'rect',
            pos: { x: zc.cta_x, y: bodyY + zc.cta_y_offset, w: zc.cta_w, h: zc.cta_h },
            style: {
              fill: azureHex,
              color: 'FFFFFF',
              fontSize: ctaFit.fontSize,
              bold: true,
              align: 'center',
              valign: 'middle',
            },
            text: ctaLine,
          });
        }
      } else if (Array.isArray(bzl.body_zones?.[bodyZoneKey]?.regions)) {
        // Region-declarative zone: built from JSON, no branch of its own.
        const zoneSpec = bzl.body_zones[bodyZoneKey];
        const anchors: ZoneAnchors = { body_x: bodyX, body_y: bodyY, body_w: bodyW, body_h: bodyH };
        const themeRoles: Record<string, string> = {
          primary: primaryHex,
          accent: accentHex,
          navy: navyHex,
          azure: azureHex,
          surface: surfaceBg,
          text_primary: bodyTextColor,
          text_secondary: subTextColor,
          white: 'FFFFFF',
        };
        const resolveRole = (value: string | undefined, fallback: string): string => {
          if (!value) return fallback;
          if (themeRoles[value]) return themeRoles[value];
          return value.replace('#', '');
        };

        // Column splits are measured, not ratio-guessed.
        const firstColumnWidth = Number(
          resolveZoneCoord(
            (zoneSpec.regions as ZoneRegionSpec[]).find((region) =>
              String(region.source).includes('balanced')
            )?.pos ?? { w: bodyW },
            'w',
            anchors
          )
        );
        const balanced = splitLinesBalanced({
          lines: bodyLines,
          columnWidthIn: firstColumnWidth || bodyW,
          fontSizePt: 13,
          lineSpacingPct: 155,
        });

        for (const region of zoneSpec.regions as ZoneRegionSpec[]) {
          const text = resolveZoneRegionText(region.source, {
            bodyLines,
            balanced,
            objective: String(data.objective || ''),
            cta: bodyLines[bodyLines.length - 1] ?? '',
            title: String(data.title || ''),
            literal: region.text,
          });
          if (!text.trim()) continue;

          const box = {
            x: resolveZoneCoord(region.pos, 'x', anchors),
            y: resolveZoneCoord(region.pos, 'y', anchors),
            w: resolveZoneCoord(region.pos, 'w', anchors),
            h: resolveZoneCoord(region.pos, 'h', anchors),
          };
          if (box.w <= 0 || box.h <= 0) continue;

          const fitted = recordFit(
            `${bodyZoneKey}.${region.id}`,
            fitBodyText(
              text,
              { widthIn: box.w, heightIn: box.h },
              {
                fontSize: region.font_size ?? 13,
                minFontSize: typeFloors.bodyMinPt,
                lineSpacingPct: region.line_spacing_pct,
                margin: region.margin,
              }
            )
          );

          // Region zones pair a fill with a text color from the theme roles;
          // when those roles collapse onto the same value the text renders
          // invisible, so the color is checked against the fill it lands on.
          const regionFill = region.fill ? resolveRole(region.fill, surfaceBg) : undefined;
          const preferredColor = resolveRole(region.color, bodyTextColor);
          const regionColor = regionFill
            ? ensureReadableOn(regionFill, preferredColor)
            : preferredColor;

          elements.push({
            type: region.type === 'panel' ? 'shape' : 'text',
            ...(region.type === 'panel'
              ? { shapeType: 'rect' }
              : { placeholderType: 'body' as const }),
            pos: box,
            text: resolveSlideTemplate(text, data, text),
            style: {
              ...(region.type === 'text' ? placeholderConfig.body?.style || {} : {}),
              fontSize: fitted.fontSize,
              color: regionColor,
              ...(regionFill ? { fill: regionFill } : {}),
              ...(region.type === 'text' ? { fontFamily: bodyFont } : {}),
              ...(region.bold ? { bold: true } : {}),
              align: region.align || 'left',
              valign: region.valign || 'top',
              ...(region.line_spacing_pct ? { lineSpacingPct: region.line_spacing_pct } : {}),
              ...(region.margin ? { margin: region.margin } : {}),
            },
          });
        }
      } else {
        // single-column (content / appendix and anything still unmapped)
        const zc = bzl.body_zones.single_column;
        const baseFontSize = zc.font_size + Number(pptxTokens.body_font_size_delta || 0);
        const singleFit = recordFit(
          'single_column',
          fitBodyText(
            bodyText,
            { widthIn: bodyW, heightIn: bodyH },
            {
              fontSize: baseFontSize,
              minFontSize: typeFloors.bodyMinPt,
              lineSpacingPct: zc.line_spacing_pct,
              margin: zc.margin,
            }
          )
        );
        elements.push({
          type: 'text',
          placeholderType: 'body',
          pos: { x: bodyX, y: bodyY, w: bodyW, h: bodyH },
          text: resolveSlideTemplate(bodyText, data, bodyText),
          style: {
            ...(placeholderConfig.body?.style || {}),
            fontSize: singleFit.fontSize,
            color: bodyTextColor,
            fontFamily: bodyFont,
            align: 'left',
            valign: 'top',
            lineSpacingPct: zc.line_spacing_pct,
            margin: zc.margin,
          },
        });
      }
    }

    // 7. Footer bar
    elements.push({
      type: 'shape',
      shapeType: 'rect',
      pos: { x: 0, y: chr.footer_y, w: 10, h: chr.footer_h },
      style: {
        fill: 'F0F4FA',
        color: subTextColor,
        fontSize: chr.footer_font_size,
        align: 'right',
        valign: 'middle',
      },
      text: brandName ? `${brandName}  |  Confidential  ` : '  Confidential  ',
    });
  }

  if (Array.isArray(data.elements)) {
    elements.push(...cloneJsonValue(data.elements));
  }

  return {
    id: data.id || `slide${idx + 1}`,
    elements,
    backgroundFill: isHero ? primaryHex : data.backgroundFill || pageLayout?.backgroundFill,
    bgXml: isHero ? undefined : data.bgXml || pageLayout?.bgXml,
    transitionXml: data.transitionXml || pageLayout?.transitionXml,
    notesXml: data.notesXml,
    extensions: data.extensions || pageLayout?.extensions,
    metadata: {
      pageLayoutId,
      layoutKey: data.layout_key,
      mediaKind: data.media_kind,
      semanticType,
      // Which body zone rendered this slide. Recorded so zone diversity is
      // measurable: a deck where every semantic type collapses onto one zone
      // reads as visually monotonous no matter how correct the fit is.
      bodyZone: isHero ? 'hero' : renderedBodyZone,
      canvas,
      hasMaster: Boolean(activeMaster),
      layoutFit: {
        status: overflows.length > 0 ? 'overflow' : shrunkZones.length > 0 ? 'shrunk' : 'pass',
        shrinkCount: shrunkZones.length,
        overflowCount: overflows.length,
        shrunkZones,
        overflows,
      },
      ...(overflows.length > 0 ? { layoutOverflows: overflows } : {}),
    },
  };
}

async function handleAction(input: MediaAction) {
  return handleMediaAction(input, {
    opCapture,
    opTransform,
    opApply,
  });
}

function assertInProjectRoot(filePath: string, label: string): string {
  const rootDir = pathResolver.rootDir();
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label}: path must stay under the Kyberion project root: ${filePath}`);
  }
  return filePath;
}

function resolvePdfPath(value: any, resolve: Function, label: string): string {
  const rootDir = pathResolver.rootDir();
  const resolved = path.resolve(rootDir, resolve(value));
  return assertInProjectRoot(resolved, label);
}

function resolvePdfOutPath(params: any, resolve: Function, command: string): string {
  return params.out
    ? resolvePdfPath(params.out, resolve, `pdf_${command} out`)
    : pathResolver.sharedTmp(`pdf-ops/${command}-${Date.now()}.pdf`);
}

function resolvePdfOutDir(params: any, resolve: Function, prefix: string): string {
  return params.out_dir
    ? resolvePdfPath(params.out_dir, resolve, 'pdf_split out_dir')
    : pathResolver.sharedTmp(`pdf-pages/${prefix}-${Date.now()}`);
}

function sanitizePdfFilenamePrefix(value: string): string {
  return (
    path
      .basename(value)
      .replace(/[\\/]+/g, '-')
      .replace(/[^a-zA-Z0-9._-]+/g, '-') || 'page'
  );
}

function runPdfOpsBridge(
  command: string,
  cliArgs: string[],
  passwords: Record<string, string | undefined>,
  timeoutMs?: number
): any {
  const rootDir = pathResolver.rootDir();
  const bridge = pathResolver.rootResolve(
    'libs/actuators/media-actuator/scripts/pdf_ops_bridge.py'
  );
  const pythonBin = resolvePdfBridgePythonBin();
  const cleanedPw: Record<string, string> = {};
  for (const [key, value] of Object.entries(passwords)) {
    if (value !== undefined && value !== null && value !== '') cleanedPw[key] = String(value);
  }
  const execResult = safeExecResult(pythonBin, [bridge, '--command', command, ...cliArgs], {
    cwd: rootDir,
    input: `${JSON.stringify(cleanedPw)}\n`,
    timeoutMs: timeoutMs || 120000,
  });
  if (execResult.error && (execResult.status === null || execResult.status === undefined)) {
    throw new Error(
      `pdf_${command}: failed to launch "${pythonBin}" (${execResult.error.message}). Ensure Python 3 is installed, or set KYBERION_PYTHON_BIN / KYBERION_PYTHON.`
    );
  }
  let parsed: any = {};
  try {
    parsed = JSON.parse(String(execResult.stdout || '').trim() || '{}');
  } catch {
    parsed = {};
  }
  if (execResult.status !== 0 || !parsed.ok) {
    const detail =
      parsed.error ||
      (execResult.stderr || '').trim() ||
      `python exited with status ${execResult.status}`;
    throw new Error(`pdf_${command} failed: ${detail}`);
  }
  return parsed;
}

const PDF_PYPDF_OPS = new Set([
  'pdf_split',
  'pdf_merge',
  'pdf_extract_range',
  'pdf_delete_pages',
  'pdf_reorder',
  'pdf_rotate',
  'pdf_remove_password',
  'pdf_encrypt',
  'pdf_metadata',
  'pdf_stamp',
]);

function resolvePdfBridgePythonBin(): string {
  if (process.env.KYBERION_PYTHON_BIN) return process.env.KYBERION_PYTHON_BIN;
  if (process.env.KYBERION_PYTHON) return process.env.KYBERION_PYTHON;
  const legacyVenvPython = pathResolver.rootResolve('.venv/bin/python3');
  if (safeExistsSync(legacyVenvPython)) return legacyVenvPython;
  return 'python3';
}

async function opCapture(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'json_read': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const parsed = JSON.parse(safeReadFile(sourcePath, { encoding: 'utf8' }) as string);
      return { ...ctx, [params.export_as || 'last_json']: parsed };
    }
    case 'pptx_extract': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const assetsDir = pathResolver.sharedTmp(`actuators/media-actuator/assets_${Date.now()}`);
      const design = await pptxUtils.distillPptxDesign(sourcePath, assetsDir);
      const ocrEnabled = params.ocr === true || params.ocr?.enabled === true;
      const output = ocrEnabled
        ? await augmentPptxDesignWithImageOcr(design, {
            language: params.ocr?.language,
            mode: params.ocr?.mode,
          })
        : design;
      return {
        ...ctx,
        [params.export_as || 'last_pptx_design']: output,
        last_assets_dir: assetsDir,
      };
    }
    case 'pptx_slide_text': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      let slides: any[] = extractPptxSlides(sourcePath);
      if (params.ocr === true || params.ocr?.enabled === true) {
        const assetsDir = pathResolver.sharedTmp(
          `actuators/media-actuator/ocr_assets_${Date.now()}`
        );
        const design = await pptxUtils.distillPptxDesign(sourcePath, assetsDir);
        const ocrBySlide = await collectPptxImageOcr(design, {
          language: params.ocr?.language,
          mode: params.ocr?.mode,
        });
        slides = slides.map((slide) => ({
          ...slide,
          ...(ocrBySlide.get(slide.slide_index) || {}),
        }));
      }
      return { ...ctx, [params.export_as || 'last_pptx_slides']: slides };
    }
    case 'xlsx_extract': {
      const xlsxPath = path.resolve(rootDir, resolve(params.path));
      const xlsxDesign = await xlsxUtils.distillXlsxDesign(xlsxPath);
      // Token-efficient projection: when a sheet/range/values_only filter is given,
      // emit a slim values-only structure (no styles) so a downstream reasoning step
      // receives a fraction of the payload. Default (no filters) = full design unchanged.
      const wantProjection =
        params.values_only === true || params.sheet !== undefined || params.range !== undefined;
      const output = wantProjection
        ? projectXlsxDesign(xlsxDesign, {
            sheet: params.sheet !== undefined ? resolve(params.sheet) : undefined,
            range: params.range !== undefined ? resolve(params.range) : undefined,
            valuesOnly: params.values_only !== false,
            skipZero: params.skip_zero === true,
          })
        : xlsxDesign;
      return { ...ctx, [params.export_as || 'last_xlsx_design']: output };
    }
    case 'docx_extract': {
      const docxPath = path.resolve(rootDir, resolve(params.path));
      const docxDesign = await docxUtils.distillDocxDesign(docxPath);
      return { ...ctx, [params.export_as || 'last_docx_design']: docxDesign };
    }
    case 'pdf_extract': {
      const pdfPath = path.resolve(rootDir, resolve(params.path));
      let pdfDesign = await distillPdfDesign(pdfPath, { aesthetic: params.aesthetic !== false });
      try {
        const extractedText = await mediaPdfHelpers.extractCleanerPdfText(pdfPath);
        pdfDesign = mediaPdfHelpers.mergeCleanerPdfText(pdfDesign, extractedText);
      } catch (error: any) {
        logger.warn(
          `[MEDIA_CAPTURE] pdf_extract cleaner text fallback unavailable: ${error.message}`
        );
      }
      return { ...ctx, [params.export_as || 'last_pdf_design']: pdfDesign };
    }
    case 'pdf_split': {
      // Split a (optionally password-protected) PDF into one file per page.
      // Backed by the pypdf bridge: it decrypts with the supplied password and
      // copies each page losslessly (object graph preserved). The password is
      // passed on stdin — never argv — so it cannot leak via the process list.
      // params: { path, password?, out_dir?, prefix?, pad?, timeout_ms?, export_as? }
      const inputPath = resolvePdfPath(params.path, resolve, 'pdf_split path');
      if (!safeExistsSync(inputPath)) {
        throw new Error(`pdf_split: input PDF not found: ${resolve(params.path)}`);
      }
      const defaultPrefix = path.basename(inputPath).replace(/\.pdf$/i, '') || 'page';
      const prefix = sanitizePdfFilenamePrefix(
        params.prefix ? String(resolve(params.prefix)) : defaultPrefix
      );
      const outDirAbs = resolvePdfOutDir(params, resolve, prefix);
      const pad = Number.isInteger(params.pad) ? params.pad : 3;
      const password =
        params.password !== undefined && params.password !== null
          ? String(resolve(params.password))
          : '';
      const bridge = pathResolver.rootResolve(
        'libs/actuators/media-actuator/scripts/pdf_split_bridge.py'
      );
      const pythonBin = resolvePdfBridgePythonBin();
      const execResult = safeExecResult(
        pythonBin,
        [
          bridge,
          '--input',
          inputPath,
          '--out-dir',
          outDirAbs,
          '--prefix',
          prefix,
          '--pad',
          String(pad),
        ],
        {
          cwd: rootDir,
          input: `${password}\n`, // password via stdin only; never on argv
          timeoutMs: params.timeout_ms || 120000,
        }
      );
      if (execResult.error && (execResult.status === null || execResult.status === undefined)) {
        throw new Error(
          `pdf_split: failed to launch "${pythonBin}" (${execResult.error.message}). Ensure Python 3 is installed, or set KYBERION_PYTHON_BIN / KYBERION_PYTHON.`
        );
      }
      let parsed: any = {};
      try {
        parsed = JSON.parse(String(execResult.stdout || '').trim() || '{}');
      } catch {
        parsed = {};
      }
      if (execResult.status !== 0 || !parsed.ok) {
        const detail =
          parsed.error ||
          (execResult.stderr || '').trim() ||
          `python exited with status ${execResult.status}`;
        throw new Error(`pdf_split failed: ${detail}`);
      }
      // Return repo-relative paths so the result stays portable if persisted downstream.
      const pages = (Array.isArray(parsed.pages) ? parsed.pages : []).map((p: string) =>
        pathResolver.toRepoRelative(p)
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_pages']: {
          count: parsed.count ?? pages.length,
          out_dir: pathResolver.toRepoRelative(parsed.out_dir || outDirAbs),
          pages,
        },
      };
    }
    case 'pdf_merge': {
      const inputs = (Array.isArray(params.inputs) ? params.inputs : []).map((p: any) =>
        resolvePdfPath(p, resolve, 'pdf_merge input')
      );
      if (inputs.length < 2) {
        throw new Error('pdf_merge: "inputs" must list at least two PDF paths');
      }
      const outAbs = resolvePdfOutPath(params, resolve, 'merge');
      const result = runPdfOpsBridge(
        'merge',
        ['--inputs', inputs.join(path.delimiter), '--out', outAbs],
        { password: params.password ? String(resolve(params.password)) : undefined },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_merge']: {
          count: result.count,
          out: pathResolver.toRepoRelative(result.out || outAbs),
        },
      };
    }
    case 'pdf_extract_range': {
      const inputAbs = resolvePdfPath(params.path, resolve, 'pdf_extract_range path');
      if (!safeExistsSync(inputAbs))
        throw new Error(`pdf_extract_range: input not found: ${resolve(params.path)}`);
      const outAbs = resolvePdfOutPath(params, resolve, 'extract');
      const result = runPdfOpsBridge(
        'extract_range',
        ['--input', inputAbs, '--out', outAbs, '--pages', String(resolve(params.pages ?? 'all'))],
        { password: params.password ? String(resolve(params.password)) : undefined },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_extract']: {
          count: result.count,
          out: pathResolver.toRepoRelative(result.out || outAbs),
          pages: result.pages,
        },
      };
    }
    case 'pdf_delete_pages': {
      const inputAbs = resolvePdfPath(params.path, resolve, 'pdf_delete_pages path');
      if (!safeExistsSync(inputAbs))
        throw new Error(`pdf_delete_pages: input not found: ${resolve(params.path)}`);
      const outAbs = resolvePdfOutPath(params, resolve, 'delete');
      const result = runPdfOpsBridge(
        'delete_pages',
        ['--input', inputAbs, '--out', outAbs, '--delete', String(resolve(params.delete ?? ''))],
        { password: params.password ? String(resolve(params.password)) : undefined },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_delete_pages']: {
          count: result.count,
          out: pathResolver.toRepoRelative(result.out || outAbs),
          deleted: result.deleted,
        },
      };
    }
    case 'pdf_reorder': {
      const inputAbs = resolvePdfPath(params.path, resolve, 'pdf_reorder path');
      if (!safeExistsSync(inputAbs))
        throw new Error(`pdf_reorder: input not found: ${resolve(params.path)}`);
      const outAbs = resolvePdfOutPath(params, resolve, 'reorder');
      const result = runPdfOpsBridge(
        'reorder',
        ['--input', inputAbs, '--out', outAbs, '--order', String(resolve(params.order ?? ''))],
        { password: params.password ? String(resolve(params.password)) : undefined },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_reorder']: {
          count: result.count,
          out: pathResolver.toRepoRelative(result.out || outAbs),
          order: result.order,
        },
      };
    }
    case 'pdf_rotate': {
      const inputAbs = resolvePdfPath(params.path, resolve, 'pdf_rotate path');
      if (!safeExistsSync(inputAbs))
        throw new Error(`pdf_rotate: input not found: ${resolve(params.path)}`);
      const outAbs = resolvePdfOutPath(params, resolve, 'rotate');
      const angle = Number.isInteger(params.angle) ? params.angle : 90;
      const result = runPdfOpsBridge(
        'rotate',
        [
          '--input',
          inputAbs,
          '--out',
          outAbs,
          '--pages',
          String(resolve(params.pages ?? 'all')),
          '--angle',
          String(angle),
        ],
        { password: params.password ? String(resolve(params.password)) : undefined },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_rotate']: {
          count: result.count,
          out: pathResolver.toRepoRelative(result.out || outAbs),
          rotated: result.rotated,
          angle: result.angle,
        },
      };
    }
    case 'pdf_remove_password': {
      const inputAbs = resolvePdfPath(params.path, resolve, 'pdf_remove_password path');
      if (!safeExistsSync(inputAbs))
        throw new Error(`pdf_remove_password: input not found: ${resolve(params.path)}`);
      const outAbs = resolvePdfOutPath(params, resolve, 'unlocked');
      const result = runPdfOpsBridge(
        'remove_password',
        ['--input', inputAbs, '--out', outAbs],
        { password: params.password ? String(resolve(params.password)) : undefined },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_unlocked']: {
          count: result.count,
          out: pathResolver.toRepoRelative(result.out || outAbs),
        },
      };
    }
    case 'pdf_encrypt': {
      const inputAbs = resolvePdfPath(params.path, resolve, 'pdf_encrypt path');
      if (!safeExistsSync(inputAbs))
        throw new Error(`pdf_encrypt: input not found: ${resolve(params.path)}`);
      const outAbs = resolvePdfOutPath(params, resolve, 'encrypted');
      const result = runPdfOpsBridge(
        'encrypt',
        ['--input', inputAbs, '--out', outAbs],
        {
          password: params.password ? String(resolve(params.password)) : undefined,
          user_password: params.user_password ? String(resolve(params.user_password)) : undefined,
          owner_password: params.owner_password
            ? String(resolve(params.owner_password))
            : undefined,
        },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_encrypted']: {
          count: result.count,
          out: pathResolver.toRepoRelative(result.out || outAbs),
        },
      };
    }
    case 'pdf_metadata': {
      const inputAbs = resolvePdfPath(params.path, resolve, 'pdf_metadata path');
      if (!safeExistsSync(inputAbs))
        throw new Error(`pdf_metadata: input not found: ${resolve(params.path)}`);
      const setObj =
        params.set && typeof params.set === 'object'
          ? Object.fromEntries(
              Object.entries(params.set).map(([k, v]) => [
                k,
                typeof v === 'string' ? resolve(v) : v,
              ])
            )
          : undefined;
      const cliArgs = ['--input', inputAbs];
      if (setObj) {
        cliArgs.push('--set', JSON.stringify(setObj));
        cliArgs.push('--out', resolvePdfOutPath(params, resolve, 'metadata'));
      }
      const result = runPdfOpsBridge(
        'metadata',
        cliArgs,
        {
          password: params.password ? String(resolve(params.password)) : undefined,
        },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_metadata']: {
          metadata: result.metadata,
          ...(result.out ? { out: pathResolver.toRepoRelative(result.out) } : {}),
          ...(result.count !== undefined ? { count: result.count } : {}),
        },
      };
    }
    case 'pdf_stamp': {
      const inputAbs = resolvePdfPath(params.path, resolve, 'pdf_stamp path');
      if (!safeExistsSync(inputAbs))
        throw new Error(`pdf_stamp: input not found: ${resolve(params.path)}`);
      const stampAbs = resolvePdfPath(params.stamp, resolve, 'pdf_stamp stamp');
      if (!safeExistsSync(stampAbs))
        throw new Error(`pdf_stamp: stamp PDF not found: ${resolve(params.stamp)}`);
      const outAbs = resolvePdfOutPath(params, resolve, 'stamped');
      const result = runPdfOpsBridge(
        'stamp',
        [
          '--input',
          inputAbs,
          '--stamp',
          stampAbs,
          '--out',
          outAbs,
          '--pages',
          String(resolve(params.pages ?? 'all')),
        ],
        { password: params.password ? String(resolve(params.password)) : undefined },
        params.timeout_ms
      );
      return {
        ...ctx,
        [params.export_as || 'pdf_stamp']: {
          count: result.count,
          out: pathResolver.toRepoRelative(result.out || outAbs),
          stamped: result.stamped,
        },
      };
    }
    case 'document_digest': {
      // Extract a document and return concise LLM-friendly Markdown.
      // Supports: pdf, pptx, xlsx, docx (auto-detected from extension).
      // params: { path: string, export_as?: string }
      // If a pre-extracted protocol exists in context via params.from, use that directly.
      const exportKey = params.export_as || 'last_document_digest';
      if (params.from && ctx[params.from]) {
        const md = protocolToMarkdown(ctx[params.from]);
        return { ...ctx, [exportKey]: md };
      }
      const filePath = path.resolve(rootDir, resolve(params.path));
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.txt' || ext === '.md') {
        const markdown = safeReadFile(filePath, { encoding: 'utf8' });
        return { ...ctx, [exportKey]: markdown };
      }
      let protocol: any;
      switch (ext) {
        case '.pdf': {
          protocol = await distillPdfDesign(filePath, { aesthetic: false });
          try {
            const extractedText = await mediaPdfHelpers.extractCleanerPdfText(filePath);
            protocol = mediaPdfHelpers.mergeCleanerPdfText(protocol, extractedText);
          } catch {
            /* fallback to native extraction */
          }
          break;
        }
        case '.pptx': {
          const assetsDir = pathResolver.sharedTmp(`actuators/media-actuator/digest_${Date.now()}`);
          protocol = await pptxUtils.distillPptxDesign(filePath, assetsDir);
          break;
        }
        case '.xlsx': {
          protocol = await xlsxUtils.distillXlsxDesign(filePath);
          break;
        }
        case '.docx': {
          protocol = await docxUtils.distillDocxDesign(filePath);
          break;
        }
        default:
          throw new Error(`document_digest: unsupported format "${ext}"`);
      }
      const md = protocolToMarkdown(protocol);
      return { ...ctx, [exportKey]: md };
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = pathResolver.rootDir();
  if (PDF_PYPDF_OPS.has(op)) return opCapture(op, params, ctx, resolve);
  switch (op) {
    case 'find_slides_by_owner': {
      const slides = (params.slides ||
        ctx[params.from || 'last_pptx_slides'] ||
        []) as MediaSlideText[];
      const labels = Array.isArray(params.owner_labels)
        ? params.owner_labels.map(String)
        : Array.isArray(ctx[params.owner_labels_from || 'owner_labels'])
          ? ctx[params.owner_labels_from || 'owner_labels'].map(String)
          : [];
      const result = findSlidesByOwner({
        slides,
        owner_labels: labels,
        match_mode: params.match_mode,
      });
      return {
        ...ctx,
        [params.export_as || 'slide_owner_matches']: result,
      };
    }
    case 'pptx_diff': {
      const before = (params.before ||
        ctx[params.before_from || 'before_slides'] ||
        []) as MediaSlideText[];
      const after = (params.after ||
        ctx[params.after_from || 'after_slides'] ||
        []) as MediaSlideText[];
      return { ...ctx, [params.export_as || 'pptx_diff']: pptxDiff({ before, after }) };
    }
    case 'pdf_to_pptx_design': {
      const pdfDesign = ctx[params.from || 'last_pdf_design'];
      if (!pdfDesign || typeof pdfDesign !== 'object') {
        throw new Error(
          `pdf_to_pptx_design could not find context key: ${params.from || 'last_pdf_design'}`
        );
      }
      const augmentedPdfDesign = await maybeAugmentPdfDesignWithImageOcr(
        pdfDesign as PdfDesignProtocol,
        params.hints
      );
      return {
        ...ctx,
        [params.export_as || 'last_pptx_design']: buildPptxProtocolFromPdfDesignHelper(
          augmentedPdfDesign,
          params.hints
        ),
        merged_output_format: 'pptx',
      };
    }
    case 'pdf_to_xlsx_design': {
      const pdfDesign = ctx[params.from || 'last_pdf_design'];
      if (!pdfDesign || typeof pdfDesign !== 'object') {
        throw new Error(
          `pdf_to_xlsx_design could not find context key: ${params.from || 'last_pdf_design'}`
        );
      }
      return {
        ...ctx,
        [params.export_as || 'last_xlsx_design']: buildXlsxProtocolFromPdfDesignHelper(
          pdfDesign as PdfDesignProtocol,
          params.hints
        ),
        merged_output_format: 'xlsx',
      };
    }
    case 'apply_theme': {
      const themes = loadThemeCatalog(rootDir);
      if (!themes || typeof themes !== 'object' || !themes.themes) {
        logger.warn('[MEDIA_TRANSFORM] theme catalog not found, skipping theme application');
        return ctx;
      }
      let themeName = resolve(params.theme) || themes.default_theme || 'kyberion-standard';
      // LLM-boundary audit fix A: theme: 'auto' selects a story-matched theme
      // from the governed catalog (selection only — never invents colors);
      // failure or an empty story keeps the catalog default.
      if (themeName === 'auto') {
        const fallbackTheme = themes.default_theme || 'kyberion-standard';
        const storySource =
          ctx.document_outline ||
          ctx.last_brief ||
          ctx.brief ||
          params.story ||
          ctx.last_json ||
          {};
        themeName = await selectDeckTheme({
          title: String(
            (storySource as any).title || (storySource as any).document_type || 'Document'
          ),
          summary: JSON.stringify(storySource).slice(0, 1500),
          catalog: Object.entries(themes.themes).map(([id, record]: [string, any]) => ({
            id,
            name: record?.name ? String(record.name) : undefined,
          })),
          defaultTheme: fallbackTheme,
        });
      }
      const theme = themes.themes[themeName];
      const confidentialPack = theme ? null : resolveConfidentialThemePack(rootDir, themeName);
      const resolvedTheme =
        theme ||
        (confidentialPack?.theme
          ? {
              ...confidentialPack.theme,
              layout_templates: confidentialPack.layout_templates || null,
              pptx: confidentialPack.pptx || null,
              web: confidentialPack.web || null,
            }
          : null);
      if (!resolvedTheme) {
        logger.warn(
          `[MEDIA_TRANSFORM] Theme "${themeName}" not found, available: ${Object.keys(themes.themes).join(', ')}`
        );
        return ctx;
      }
      return {
        ...ctx,
        active_theme: resolvedTheme,
        active_theme_name: themeName,
        active_theme_pack: confidentialPack || null,
        active_pptx_master: confidentialPack?.pptx?.master || ctx.active_pptx_master,
        active_canvas: confidentialPack?.pptx?.canvas || ctx.active_canvas,
        active_web_theme: confidentialPack?.web
          ? {
              theme: confidentialPack.theme || resolvedTheme,
              web: confidentialPack.web,
              layout_templates: confidentialPack.layout_templates || null,
            }
          : ctx.active_web_theme,
      };
    }
    case 'apply_pattern': {
      const patternPath = path.resolve(rootDir, resolve(params.pattern_path));
      if (!safeExistsSync(patternPath)) {
        throw new Error(`Design pattern not found: ${patternPath}`);
      }
      const pattern = JSON.parse(safeReadFile(patternPath, { encoding: 'utf8' }) as string);
      return { ...ctx, active_pattern: pattern, pattern_id: pattern.pattern_id };
    }
    case 'merge_content': {
      const pattern = ctx.active_pattern;
      const theme = ctx.active_theme;
      const contentData = resolve(params.content_data) || pattern?.content_data || [];
      const outputFormat =
        resolve(params.output_format) || pattern?.media_actuator_config?.engine || 'pptx';

      if (outputFormat === 'pptx') {
        const themeColors = resolveThemeColors(theme);
        const themePack = ctx.active_theme_pack || null;
        const activeMaster = ctx.active_pptx_master || themePack?.pptx?.master;
        const canvas = ctx.active_canvas || themePack?.pptx?.canvas || { w: 10, h: 5.625 };
        const protocol: any = {
          version: '3.0.0',
          generatedAt: new Date().toISOString(),
          canvas,
          theme: {
            dk1: (themeColors.primary || '#000000').replace('#', ''),
            dk2: (themeColors.secondary || themeColors.text || '#44546A').replace('#', ''),
            lt1: (themeColors.background || '#FFFFFF').replace('#', ''),
            lt2: (themeColors.background || '#E7E6E6').replace('#', ''),
            accent1: (themeColors.accent || '#38BDF8').replace('#', ''),
            accent2: (themeColors.secondary || '#334155').replace('#', ''),
          },
          master: {
            elements: Array.isArray(activeMaster?.elements) ? activeMaster.elements : [],
            extensions: activeMaster?.extensions,
            bgXml: activeMaster?.bgXml,
          },
          slides: contentData.map((data: any, idx: number) =>
            buildPptxSlideFromPattern(rootDir, data, idx, theme, pattern, activeMaster, canvas)
          ),
        };
        protocol.metadata = {
          ...(protocol.metadata || {}),
          layoutDiagnostics: summarizeMediaPptxLayout(protocol),
        };
        return { ...ctx, last_pptx_design: protocol, merged_output_format: 'pptx' };
      }

      // For non-pptx formats, store the merged data for downstream processing
      return { ...ctx, merged_content: contentData, merged_output_format: outputFormat };
    }
    case 'set': {
      const key = resolve(params.key);
      const value = resolve(params.value);
      if (key) return { ...ctx, [key]: value };
      return ctx;
    }
    case 'layout_template_from_pptx_design': {
      const fromKey = resolve(params.from) || 'last_pptx_design';
      const design = ctx[fromKey];
      if (!design)
        throw new Error(`layout_template_from_pptx_design: context key not found: ${fromKey}`);

      const geometry = extractChromeGeometryFromPptxDesign(design);
      const publicCatalog = loadLayoutTemplateCatalog(rootDir);
      const publicMatch = matchLayoutTemplate(geometry, publicCatalog);

      const tenantSlug: string = resolve(params.tenant_slug) || ctx.tenant_slug || '';
      let confMatch: { id: string; score: number; catalog?: string } | null = null;
      if (tenantSlug) {
        const confPath = `knowledge/confidential/${tenantSlug}/design/layout-templates.json`;
        try {
          const confCatalog = JSON.parse(
            safeReadFile(path.resolve(rootDir, confPath), { encoding: 'utf8' }) as string
          );
          const m = matchLayoutTemplate(geometry, confCatalog);
          if (m) confMatch = { ...m, catalog: confPath };
        } catch {
          /* no confidential catalog yet */
        }
      }

      const THRESHOLD = 0.85;
      const chosen: any =
        (confMatch?.score ?? 0) >= (publicMatch?.score ?? 0) ? confMatch : publicMatch;
      const baseTemplate = chosen?.id
        ? chosen?.catalog === 'public' || !chosen?.catalog
          ? publicCatalog.templates?.[chosen.id]
          : null
        : null;
      const template = deriveLayoutTemplateFromPptxDesign(
        design,
        baseTemplate || publicCatalog.templates?.[chosen?.id || 'corporate-standard'] || {}
      );
      const result: any = {
        geometry,
        matched_template_id: chosen && chosen.score >= THRESHOLD ? chosen.id : null,
        match_score: chosen?.score ?? 0,
        match_catalog: (chosen as any)?.catalog || 'public',
        needs_new_template: !chosen || chosen.score < THRESHOLD,
        recommended_template_id: chosen?.id || 'corporate-standard',
        template,
      };
      return { ...ctx, [params.export_as || 'last_layout_geometry']: result };
    }
    case 'theme_from_pptx_design': {
      const fromKey = resolve(params.from) || 'last_pptx_design';
      const design = ctx[fromKey];
      if (!design) {
        throw new Error(`theme_from_pptx_design could not find context key: ${fromKey}`);
      }

      const derivedTheme = deriveThemeFromPptxDesign(design, resolve(params.name));
      const nextCtx: Record<string, any> = {
        ...ctx,
        active_theme: derivedTheme,
        active_theme_name: derivedTheme.name || resolve(params.name) || 'pptx-extracted-theme',
        active_pptx_master: design.master,
        active_canvas: design.canvas,
        active_pptx_design: design,
        active_theme_source: fromKey,
      };

      if (params.export_as) {
        nextCtx[params.export_as] = derivedTheme;
      }
      if (params.export_master_as) {
        nextCtx[params.export_master_as] = design.master;
      }
      return nextCtx;
    }
    case 'proposal_storyline_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`proposal_storyline_from_brief could not find context key: ${fromKey}`);
      }
      const brief = normalizeProposalBrief(rootDir, rawBrief);
      const outline = buildProposalNarrativeOutline(rootDir, brief);
      const slides = outline.toc.map((entry: any, idx: number) => ({
        id: entry.section_id || `slide_${idx + 1}`,
        title: entry.title,
        objective: entry.objective,
        body: Array.isArray(entry.body) ? entry.body : [entry.objective].filter(Boolean),
        visual: entry.visual,
        media_kind: entry.media_kind,
        layout_key: entry.layout_key,
        semantic_type: entry.semantic_type,
        pattern_id: entry.pattern_id,
        slide_pattern: entry.slide_pattern,
        body_zone: entry.body_zone,
        design_system_id: outline.design_system_id,
        branding: outline.branding || {},
      }));

      return {
        ...ctx,
        [params.export_as || 'proposal_storyline']: {
          kind: 'proposal-storyline-adf',
          title: brief.title || 'Proposal',
          client: brief.client,
          core_message: brief.story?.core_message,
          document_profile: brief.document_profile,
          design_system_id: outline.design_system_id,
          branding: outline.branding || {},
          layout_template_id: brief.layout_template_id,
          narrative_pattern_id: outline.narrative_pattern_id,
          recommended_theme: outline.recommended_theme,
          recommended_layout_template_id: outline.recommended_layout_template_id,
          toc: outline.toc,
          diagnostics: outline.diagnostics,
          slides,
        },
      };
    }
    case 'document_outline_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`document_outline_from_brief could not find context key: ${fromKey}`);
      }
      const category = resolveMediaBriefCategory(rawBrief);
      const brief = normalizeBriefForCategory(rootDir, rawBrief);
      const outline = buildOutlineFromNormalizedBrief(rootDir, category, brief);

      // Story-matched theme (deck counterpart of video-visual-direction):
      // only when the brief did not explicitly choose one — operator intent
      // always wins, and failure keeps the preset default.
      const explicitTheme = (brief as any).theme || (brief as any).payload?.theme;
      if (!explicitTheme && outline?.recommended_theme) {
        const catalogRaw = loadThemeCatalog(rootDir)?.themes || {};
        const catalog = Object.entries(catalogRaw).map(([id, record]: [string, any]) => ({
          id,
          name: record?.name ? String(record.name) : undefined,
        }));
        outline.recommended_theme = await selectDeckTheme({
          title: String((brief as any).title || outline.document_type || 'Document'),
          summary: JSON.stringify(
            (brief as any).sections ?? (brief as any).objective ?? brief
          ).slice(0, 1500),
          tone: (brief as any).tone ? String((brief as any).tone) : undefined,
          audience: (brief as any).audience ? String((brief as any).audience) : undefined,
          catalog,
          defaultTheme: String(outline.recommended_theme),
        });
      }

      // LLM-boundary audit fix B: fill ONLY empty section bodies (the
      // llm_zone declared draft_body_content but nothing implemented it —
      // body-less briefs rendered heading-only decks). Existing bodies and
      // failures leave the outline untouched.
      const outlineSections = Array.isArray((outline as any)?.sections)
        ? ((outline as any).sections as any[])
        : [];
      const draftTargets = outlineSections.map((section: any) => ({
        id: String(section.section_id || section.id || section.title || 'section'),
        title: String(section.title || section.section_id || 'Section'),
        body: Array.isArray(section.body) ? section.body.join(' ') : section.body,
      }));
      if (draftTargets.some((section) => !String(section.body ?? '').trim())) {
        const drafts = await draftDeckSectionBodies({
          title: String((brief as any).title || outline.document_type || 'Document'),
          tone: (brief as any).tone ? String((brief as any).tone) : undefined,
          audience: (brief as any).audience ? String((brief as any).audience) : undefined,
          locale: (brief as any).locale ? String((brief as any).locale) : undefined,
          sections: draftTargets,
        });
        for (const section of outlineSections) {
          const key = String(section.section_id || section.id || section.title || 'section');
          const hasBody = Array.isArray(section.body)
            ? section.body.some((value: any) => String(value ?? '').trim())
            : Boolean(String(section.body ?? '').trim());
          if (!hasBody && drafts[key]) {
            section.body = Array.isArray(section.body) ? [drafts[key]] : drafts[key];
          }
        }
      }

      return {
        ...ctx,
        [params.export_as || 'document_outline']: outline,
      };
    }
    case 'brief_to_design_protocol': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief =
        params.brief && typeof params.brief === 'object' ? params.brief : ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`brief_to_design_protocol could not find context key: ${fromKey}`);
      }
      const sourceBrief =
        (rawBrief as any).kind === 'locked-media-brief' &&
        (rawBrief as any).source_brief &&
        typeof (rawBrief as any).source_brief === 'object'
          ? (rawBrief as any).source_brief
          : rawBrief;
      const compiled = compileBriefToDesignProtocol(rootDir, sourceBrief);
      const exportKey = params.export_as || compiled.exportKey;
      return {
        ...ctx,
        active_theme: ctx.active_theme || compiled.theme || ctx.active_theme,
        active_theme_name: ctx.active_theme_name || compiled.themeName,
        document_outline: compiled.outline,
        [exportKey]: compiled.protocol,
        last_design_protocol: compiled.protocol,
        last_design_protocol_kind: compiled.protocolKind,
      };
    }
    case 'pptx_layout_preflight': {
      const fromKey = resolve(params.from) || 'last_pptx_design';
      const protocol = ctx[fromKey];
      if (!protocol || typeof protocol !== 'object') {
        throw new Error(`pptx_layout_preflight could not find context key: ${fromKey}`);
      }
      assertMediaProtocolLayoutReady(protocol, {
        allowLayoutOverflow: params.allow_layout_overflow === true,
      });
      const diagnostics =
        protocol?.metadata?.layoutDiagnostics || summarizeMediaPptxLayout(protocol);
      return {
        ...ctx,
        [params.export_as || 'media_layout_diagnostics']: diagnostics,
      };
    }
    case 'lock_media_brief': {
      // MP-05: fix the brief before anything is produced, and record which
      // parts the operator actually decided. An inference nobody can see is
      // how a deck ends up written for the wrong reader.
      const fromKey = resolve(params.from) || 'last_json';
      const raw = ctx[fromKey];
      if (!raw || typeof raw !== 'object') {
        throw new Error(`[UNKNOWN_INPUT] lock_media_brief could not find context key: ${fromKey}`);
      }

      const stated: Record<string, string | undefined> = {};
      for (const field of ['audience', 'objective', 'tone', 'locale', 'render_target', 'title']) {
        const value = (raw as any)[field];
        if (typeof value === 'string' && value.trim()) stated[field] = value.trim();
      }

      const inferred: Record<string, { value: string; rationale: string }> = {};
      if (!stated.locale) {
        inferred.locale = {
          value: 'ja-JP',
          rationale: 'no locale stated; defaulted to the workspace locale',
        };
      }
      if (!stated.tone) {
        inferred.tone = {
          value: stated.audience ? 'formal' : 'neutral',
          rationale: stated.audience
            ? `inferred from the stated audience "${stated.audience}"`
            : 'no audience or tone stated',
        };
      }

      // Nested params are not template-resolved by the dispatcher, so a
      // pipeline writing `"visual_review_rounds": "{{rounds}}"` would otherwise
      // hand the op the literal placeholder. Resolve each value here; the
      // run-shape schema then coerces the resulting strings.
      const rawRunShape =
        params.run_shape && typeof params.run_shape === 'object' ? params.run_shape : {};
      const runShape: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawRunShape)) {
        runShape[key] = typeof value === 'string' ? resolve(value) : value;
      }

      const locked = lockMediaBrief({
        intent: String((raw as any).title || (raw as any).objective || 'media brief'),
        stated,
        inferred,
        runShape: runShape as any,
        sourceBrief: raw as Record<string, unknown>,
      });

      // Surfaced, not buried: the operator needs to see the guesses.
      const assumptions = inferredDecisions(locked);
      if (assumptions.length > 0) {
        logger.info(`📋 [MEDIA]\n${formatBriefForConfirmation(locked)}`);
      }

      return { ...ctx, [params.export_as || 'locked_media_brief']: locked };
    }
    case 'visual_review': {
      const capabilities = detectRasterCapabilities({ refresh: true });
      const lockedBrief = ctx[String(resolve(params.brief_from) || 'locked_media_brief')];
      const runShape = lockedBrief?.run_shape;
      const tier = String(resolve(params.tier) || 'public');
      if (!['public', 'confidential', 'personal'].includes(tier)) {
        throw new Error(
          '[VISUAL_REVIEW_TIER_INVALID] tier must be public, confidential, or personal'
        );
      }
      const missionId = String(resolve(params.mission_id) || 'none');
      const tenantSlug = String(resolve(params.tenant_slug) || 'kyberion');
      if (tier !== 'public' && !lockedBrief) {
        throw new Error(
          '[VISUAL_REVIEW_LOCK_REQUIRED] confidential and personal reviews require a locked media brief'
        );
      }
      const allowExternal =
        lockedBrief && runShape
          ? runShape.allow_external_visual_review === true
          : tier === 'public' && params.allow_external_egress === true;
      const requestedWorkDir = params.work_dir
        ? resolve(params.work_dir)
        : tier === 'public'
          ? undefined
          : missionId !== 'none'
            ? path.join('active', 'missions', tier, missionId, 'visual-review')
            : undefined;
      const artifactKind = String(resolve(params.artifact_kind) || 'pptx') as
        | 'pptx'
        | 'doc'
        | 'video-scenes'
        | 'web';
      const label = String(params.label || params.path || 'media-review').replace(
        /[^a-zA-Z0-9._-]/g,
        '-'
      );
      const rawHtmlPaths = Array.isArray(params.html_paths)
        ? params.html_paths.map((value: unknown) => String(resolve(value)))
        : [];
      const artifactInput = String(resolve(params.path || params.artifact_path) || '');
      if (artifactKind === 'video-scenes' || artifactKind === 'web') {
        if (rawHtmlPaths.length === 0) {
          throw new Error(
            '[VISUAL_REVIEW_HTML_INPUT_REQUIRED] html_paths is required for HTML review'
          );
        }
        for (const htmlPath of rawHtmlPaths) {
          assertVisualReviewPathScope({
            artifactPath: htmlPath,
            workDir: requestedWorkDir,
            tier: tier as any,
            tenantSlug,
            missionId,
          });
        }
      } else {
        const artifactPath = path.resolve(rootDir, artifactInput);
        assertVisualReviewPathScope({
          artifactPath,
          workDir: requestedWorkDir,
          tier: tier as any,
          tenantSlug,
          missionId,
        });
        if (!safeExistsSync(artifactPath)) {
          throw new Error(
            '[UNKNOWN_ARTIFACT] visual_review could not find artifact: ' + artifactPath
          );
        }
      }

      const scope = {
        tenant_id: tenantSlug,
        mission_id: missionId,
        read_tiers: [tier],
        write_tier: tier,
        purpose: 'media visual review',
        external_egress: allowExternal ? 'allow' : 'deny',
      } as any;

      // Zero rounds means the operator turned the review off; that is a
      // deliberate skip, not a pass.
      if (runShape && runShape.visual_review_rounds === 0) {
        return {
          ...ctx,
          [params.export_as || 'media_visual_review']: {
            status: 'skipped',
            rubric_model:
              'visual-review-rubric@' +
              String((loadVisualReviewRubric({ tenantSlug }) as any).version || '1'),
            error_count: 0,
            warning_count: 0,
            images_reviewed: 0,
            findings: [],
            delivery_status: 'unreviewed',
            review_outcome: 'unreviewed',
            skipped_reason: 'visual review disabled by the locked brief (visual_review_rounds = 0)',
            raster: { available: false, backend: null, missing_binaries: capabilities.missing },
          },
        };
      }

      let lastRaster: any = {
        available: false,
        images: [],
        unavailable_reason: 'rasterization did not run',
      };
      const render = async () => {
        lastRaster =
          artifactKind === 'video-scenes' || artifactKind === 'web'
            ? await rasterizeHtml({
                htmlPaths: rawHtmlPaths,
                label,
                ...(requestedWorkDir ? { workDir: requestedWorkDir } : {}),
                tier: tier as any,
                tenantSlug,
                missionId,
              })
            : rasterizeDocument({
                sourcePath: path.resolve(rootDir, artifactInput),
                label,
                ...(params.dpi ? { dpi: Number(params.dpi) } : {}),
                ...(params.max_pages ? { maxPages: Number(params.max_pages) } : {}),
                ...(requestedWorkDir ? { workDir: requestedWorkDir } : {}),
                tier: tier as any,
                tenantSlug,
                missionId,
              });
        return {
          images: lastRaster.images,
          ...(lastRaster.unavailable_reason
            ? { unavailable_reason: lastRaster.unavailable_reason }
            : {}),
        };
      };
      const loop = await runVisualReviewLoop({
        render,
        review: {
          artifactKind,
          title: params.title ? String(resolve(params.title)) : undefined,
          scope,
          backendName: String(resolve(params.backend) || 'stub'),
          rubric: loadVisualReviewRubric({ tenantSlug }),
        },
        maxRounds: Number(runShape?.visual_review_rounds ?? 1),
      });
      const report = loop.final_report || {
        status: 'skipped' as const,
        findings: [],
        error_count: 0,
        warning_count: 0,
        images_reviewed: 0,
        skipped_reason: 'visual review did not produce a report',
      };

      if (report.status !== 'reviewed' && lastRaster.unavailable_reason) {
        report.skipped_reason = lastRaster.unavailable_reason;
      }

      if (report.status !== 'reviewed') {
        logger.warn(`⚠️  [MEDIA] ${formatVisualReviewReport(report)}`);
      } else if (report.findings.length > 0) {
        logger.info(`🔍 [MEDIA]\n${formatVisualReviewReport(report)}`);
      }
      if (missionId !== 'none') {
        const missionPath = pathResolver.findMissionPath(missionId);
        if (missionPath) {
          try {
            const evidenceDir = path.join(missionPath, 'evidence');
            safeMkdir(evidenceDir, { recursive: true });
            safeWriteFile(
              path.join(evidenceDir, 'visual-review-report.json'),
              JSON.stringify(
                {
                  version: '1.0.0',
                  mission_id: missionId,
                  tenant_slug: tenantSlug,
                  tier,
                  artifact_kind: artifactKind,
                  delivery_status:
                    loop.outcome === 'clean'
                      ? 'clean'
                      : loop.outcome === 'residual'
                        ? 'residual'
                        : 'unreviewed',
                  review_outcome: loop.outcome,
                  rounds: loop.rounds,
                  report,
                  generated_at: new Date().toISOString(),
                },
                null,
                2
              )
            );
          } catch (error: any) {
            logger.warn('[MEDIA] visual review evidence could not be persisted: ' + error?.message);
          }
        }
      }

      return {
        ...ctx,
        [params.export_as || 'media_visual_review']: {
          status: report.status,
          rubric_model:
            'visual-review-rubric@' +
            String((loadVisualReviewRubric({ tenantSlug }) as any).version || '1'),
          error_count: report.error_count,
          warning_count: report.warning_count,
          images_reviewed: report.images_reviewed,
          findings: report.findings,
          delivery_status:
            loop.outcome === 'clean'
              ? 'clean'
              : loop.outcome === 'residual'
                ? 'residual'
                : 'unreviewed',
          review_outcome: loop.outcome,
          rounds: loop.rounds,
          summary: loop.summary,
          ...(report.verdict ? { verdict: report.verdict } : {}),
          ...(report.skipped_reason ? { skipped_reason: report.skipped_reason } : {}),
          raster: {
            available: lastRaster.available,
            backend: lastRaster.backend ?? null,
            missing_binaries: capabilities.missing,
          },
        },
      };
    }
    case 'visual_review_delivery_gate': {
      const fromKey = String(resolve(params.from) || 'media_visual_review');
      const report = ctx[fromKey];
      if (!report || typeof report !== 'object') {
        throw new Error('[VISUAL_REVIEW_GATE_BLOCKED] visual review report is missing');
      }
      const deliveryStatus = String((report as any).delivery_status || '');
      if (deliveryStatus !== 'clean') {
        throw new Error(
          '[VISUAL_REVIEW_GATE_BLOCKED] delivery requires a clean visual review: ' +
            String((report as any).summary || (report as any).skipped_reason || deliveryStatus)
        );
      }
      return {
        ...ctx,
        [params.export_as || 'visual_review_delivery_gate']: {
          status: 'passed',
          source: fromKey,
          delivery_status: deliveryStatus,
        },
      };
    }
    case 'proposal_content_from_storyline': {
      const fromKey = resolve(params.from) || 'proposal_storyline';
      const storyline = ctx[fromKey];
      if (!storyline || typeof storyline !== 'object' || !Array.isArray(storyline.slides)) {
        throw new Error(`proposal_content_from_storyline could not find context key: ${fromKey}`);
      }

      const contentData = storyline.slides.map((slide: any) => ({
        title: slide.title,
        body: Array.isArray(slide.body) ? slide.body : [slide.objective].filter(Boolean),
        subtitle: slide.objective,
        visual: slide.visual,
        media_kind: slide.media_kind,
        layout_key: slide.layout_key,
        semantic_type: slide.semantic_type,
        design_system_id: storyline.design_system_id,
        branding: storyline.branding || {},
      }));

      return {
        ...ctx,
        active_theme:
          ctx.active_theme ||
          resolveNamedTheme(rootDir, storyline.recommended_theme) ||
          ctx.active_theme,
        active_theme_name: ctx.active_theme_name || storyline.recommended_theme,
        [params.export_as || 'proposal_content_data']: contentData,
      };
    }
    case 'document_pdf_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const brief = ctx[fromKey];
      if (!brief || typeof brief !== 'object') {
        throw new Error(`document_pdf_from_brief could not find context key: ${fromKey}`);
      }

      const invoiceProtocol = buildDocumentPdfProtocol(brief);
      return {
        ...ctx,
        [params.export_as || 'last_pdf_design']: invoiceProtocol,
      };
    }
    case 'document_diagram_asset_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`document_diagram_asset_from_brief could not find context key: ${fromKey}`);
      }

      const brief = normalizeDiagramDocumentBrief(rawBrief);
      const nextCtx: Record<string, any> = {
        ...ctx,
        [params.export_as || 'document_diagram_asset']: brief.payload.source || brief.payload.graph,
        document_diagram_render_target: brief.render_target,
        document_diagram_layout_template_id: brief.layout_template_id,
        document_diagram_brief: brief,
      };

      if (brief.render_target === 'drawio') {
        const iconMap = resolveDrawioIconMap(rootDir, params, resolve);
        const activeTheme =
          ctx.active_theme ||
          loadFallbackDrawioTheme(rootDir, brief.layout_template_id, loadThemeCatalog);
        nextCtx.last_drawio_document = generateDrawioDocument(brief.payload.graph, {
          title: brief.payload.title || brief.title || 'Diagram',
          theme: activeTheme,
          iconMap,
          iconRoot: params.icon_root ? path.resolve(rootDir, resolve(params.icon_root)) : undefined,
        });
      } else if (typeof brief.payload.source === 'string') {
        nextCtx.document_diagram_source = brief.payload.source;
      }

      return nextCtx;
    }
    case 'document_spreadsheet_design_from_brief': {
      warnLegacyMediaOp(op);
      const rawBrief = resolveObjectInput(ctx, params, resolve, {
        fromKey: params.from,
        opName: 'document_spreadsheet_design_from_brief',
      });
      return buildCompiledBriefContext({
        rootDir,
        ctx,
        rawBrief,
        exportAs: params.export_as || 'last_xlsx_design',
        briefContextKey: 'document_spreadsheet_brief',
      });
    }
    case 'document_report_design_from_brief': {
      warnLegacyMediaOp(op);
      const rawBrief = resolveObjectInput(ctx, params, resolve, {
        fromKey: params.from,
        opName: 'document_report_design_from_brief',
      });
      return buildCompiledBriefContext({
        rootDir,
        ctx,
        rawBrief,
        exportAs: params.export_as,
        briefContextKey: 'document_report_brief',
      });
    }
    case 'drawio_from_graph': {
      const graph = resolveGraphDefinition(rootDir, params, ctx, resolve);
      const iconMap = resolveDrawioIconMap(rootDir, params, resolve);
      const preferredTheme = resolve(params.theme) || graph?.render_hints?.theme;
      const activeTheme =
        ctx.active_theme || loadFallbackDrawioTheme(rootDir, preferredTheme, loadThemeCatalog);
      const document = generateDrawioDocument(graph, {
        title: resolve(params.title) || graph.title || 'Architecture Diagram',
        theme: activeTheme,
        iconMap,
        iconRoot: params.icon_root ? path.resolve(rootDir, resolve(params.icon_root)) : undefined,
      });
      return {
        ...ctx,
        [params.export_as || 'last_drawio_document']: document,
        last_drawio_graph: graph,
      };
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

// Warn once per palette: runtime/personal/tenant themes bypass the CI
// contrast gate, so the renderer is the last line of defense. Rendering is
// never blocked — the defect lands in the log/trace for the designer review.
const auditedThemePalettes = new Set<string>();
function auditThemeContrast(colors: Record<string, string>): void {
  const signature = JSON.stringify(colors);
  if (auditedThemePalettes.has(signature)) return;
  auditedThemePalettes.add(signature);
  try {
    const issues = validateThemeContrast(colors);
    for (const issue of issues.filter((entry) => entry.severity === 'must_fix')) {
      logger.warn(
        `[THEME_CONTRAST] ${issue.pair} ${issue.ratio}:1 < ${issue.required}:1 (${issue.foreground} on ${issue.background}) — ${issue.note}`
      );
    }
  } catch {
    // contrast auditing must never break rendering
  }
}

function resolveThemeColors(theme: any): Record<string, string> {
  const cssVars = {
    ...(theme?.css_vars || {}),
    ...(theme?.theme?.css_vars || {}),
  };
  const colors = {
    ...(theme?.colors || {}),
    ...(theme?.theme?.colors || {}),
  };
  const mappedFromCssVars = {
    background: cssVarHex(cssVars['--kb-bg-main']),
    primary: cssVarHex(cssVars['--kb-panel-bg']) || cssVarHex(cssVars['--kb-bg-main']),
    secondary: cssVarHex(cssVars['--kb-warning']),
    accent: cssVarHex(cssVars['--kb-accent']),
    text: cssVarHex(cssVars['--kb-text-primary']),
  };
  const resolved = Object.entries(mappedFromCssVars).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (value) acc[key] = value;
      return acc;
    },
    { ...colors }
  );
  auditThemeContrast(resolved);
  return resolved;
}

function cssVarHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const hex = trimmed.match(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (hex) return trimmed;
  const rgba = trimmed.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i
  );
  if (!rgba) return undefined;
  const channels = rgba.slice(1, 4).map((entry) => Math.max(0, Math.min(255, Number(entry))));
  if (channels.some((entry) => !Number.isFinite(entry))) return undefined;
  return `#${channels.map((entry) => entry.toString(16).padStart(2, '0')).join('')}`;
}

async function opApply(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = pathResolver.rootDir();
  if (PDF_PYPDF_OPS.has(op)) return opCapture(op, params, ctx, resolve);
  switch (op) {
    case 'register_presentation_preference_profile': {
      const result = registerPresentationPreferenceProfileOp({
        profile: params.profile !== undefined ? resolve(params.profile) : undefined,
        profile_path: params.profile_path ? resolve(params.profile_path) : undefined,
        registry_path: params.registry_path ? resolve(params.registry_path) : undefined,
      });
      return {
        ...ctx,
        [params.export_as || 'presentation_preference_profile_registered']: result,
      };
    }
    case 'mermaid_render': {
      const outPath = path.resolve(rootDir, resolve(params.path));
      const source = resolveDiagramSource(rootDir, params, ctx, resolve);
      ensureParentDir(outPath);

      const tempDir = pathResolver.sharedTmp(`actuators/media-actuator/diagram_${Date.now()}`);
      safeMkdir(tempDir, { recursive: true });

      const inputPath = path.join(tempDir, 'diagram.mmd');
      safeWriteFile(inputPath, source);

      const args = ['-i', inputPath, '-o', outPath];
      const activeTheme = resolveDiagramTheme(params, ctx);
      const mermaidConfig = buildMermaidConfig(
        activeTheme,
        params.background_color ? resolve(params.background_color) : undefined
      );
      const configPath = path.join(tempDir, 'mermaid.config.json');
      safeWriteFile(configPath, JSON.stringify(mermaidConfig, null, 2));
      args.push('-c', configPath);

      if (params.width) args.push('-w', String(resolve(params.width)));
      if (params.height) args.push('-H', String(resolve(params.height)));
      if (params.background_color) args.push('-b', String(resolve(params.background_color)));

      await retry(
        async () => safeExec('mmdc', args, { cwd: rootDir, timeoutMs: params.timeout_ms || 30000 }),
        buildRetryOptions()
      );

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Mermaid rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'd2_render': {
      const outPath = path.resolve(rootDir, resolve(params.path));
      const source = resolveDiagramSource(rootDir, params, ctx, resolve);
      ensureParentDir(outPath);

      const tempDir = pathResolver.sharedTmp(`actuators/media-actuator/diagram_${Date.now()}`);
      safeMkdir(tempDir, { recursive: true });

      const inputPath = path.join(tempDir, 'diagram.d2');
      safeWriteFile(inputPath, source);

      const args = [inputPath, outPath];
      if (params.layout) args.push('--layout', String(resolve(params.layout)));
      if (params.theme_id) args.push('--theme', String(resolve(params.theme_id)));
      if (params.sketch) args.push('--sketch');
      if (params.pad) args.push('--pad', String(resolve(params.pad)));

      await retry(
        async () => safeExec('d2', args, { cwd: rootDir, timeoutMs: params.timeout_ms || 30000 }),
        buildRetryOptions()
      );

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] D2 rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'document_diagram_render_from_brief': {
      warnLegacyMediaOp(op);
      const rawBrief = resolveObjectInput(ctx, params, resolve, {
        paramKey: 'brief',
        fromKey: params.from,
        opName: 'document_diagram_render_from_brief',
      });
      const brief = normalizeDiagramDocumentBrief(rawBrief);
      const outPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      await renderDiagramDocumentBrief(rootDir, brief, outPath, params, ctx, resolve);
      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Diagram rendered from brief at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'pptx_render': {
      const baseProtocol = ctx[params.design_from || 'last_pptx_design'];
      // LE-01: a pipeline can opt the protocol into the engine design cascade
      // (or override per-key defaults) without editing the protocol JSON.
      const protocol =
        params.design_defaults !== undefined
          ? { ...baseProtocol, designDefaults: params.design_defaults }
          : baseProtocol;
      assertMediaProtocolLayoutReady(protocol, {
        allowLayoutOverflow: params.allow_layout_overflow === true,
      });
      const outPath = path.resolve(rootDir, resolve(params.path || params.output_path));

      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });

      await retry(async () => generateNativePptx(protocol, outPath), buildRetryOptions());

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] PPTX rendered at: ${outPath} (${stats.size} bytes).`);
      return {
        ...ctx,
        [params.export_as || 'media_render_diagnostics']:
          protocol?.metadata?.layoutDiagnostics || summarizeMediaPptxLayout(protocol),
      };
    }
    case 'pptx_patch': {
      const sourcePath = path.resolve(rootDir, resolve(params.source));
      const outPath = path.resolve(rootDir, resolve(params.path));
      const replacements =
        params.replacements || ctx[params.replacements_from || 'last_replacements'] || {};

      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });

      patchPptxText(sourcePath, outPath, replacements);

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] PPTX patched at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'pptx_filter_slides': {
      const sourcePath = path.resolve(rootDir, resolve(params.source));
      const outPath = path.resolve(rootDir, resolve(params.path));
      const keepIndices: number[] =
        params.keep_indices || ctx[params.keep_indices_from || 'last_keep_indices'] || [];

      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });

      filterPptxSlides(sourcePath, outPath, keepIndices);

      const stats = safeStat(outPath);
      logger.info(
        `✅ [MEDIA] PPTX filtered to slides [${keepIndices.join(',')}] at: ${outPath} (${stats.size} bytes).`
      );
      break;
    }
    case 'pptx_patch_paragraphs': {
      const sourcePath = path.resolve(rootDir, resolve(params.source));
      const outPath = path.resolve(rootDir, resolve(params.path));
      const replacements =
        params.paragraph_replacements ||
        ctx[params.replacements_from || 'last_paragraph_replacements'] ||
        [];

      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });

      const result = patchPptxParagraphs(sourcePath, outPath, replacements);

      const stats = safeStat(outPath);
      logger.info(
        `✅ [MEDIA] PPTX paragraph-patched (${result.match_count} matches across ${result.modified_slides.length} slide(s)) at: ${outPath} (${stats.size} bytes).`
      );
      break;
    }
    case 'xlsx_render': {
      const xlsxProtocol = normalizeXlsxDesignProtocol(
        ctx[params.design_from || 'last_xlsx_design']
      );
      const xlsxOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(xlsxOutPath)))
        safeMkdir(path.dirname(xlsxOutPath), { recursive: true });
      await retry(async () => generateNativeXlsx(xlsxProtocol, xlsxOutPath), buildRetryOptions());
      const xlsxStats = safeStat(xlsxOutPath);
      logger.info(`✅ [MEDIA] XLSX rendered at: ${xlsxOutPath} (${xlsxStats.size} bytes).`);
      break;
    }
    case 'docx_render': {
      const docxProtocol = ctx[params.design_from || 'last_docx_design'];
      const docxOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(docxOutPath)))
        safeMkdir(path.dirname(docxOutPath), { recursive: true });
      await retry(async () => generateNativeDocx(docxProtocol, docxOutPath), buildRetryOptions());
      const docxStats = safeStat(docxOutPath);
      logger.info(`✅ [MEDIA] DOCX rendered at: ${docxOutPath} (${docxStats.size} bytes).`);
      break;
    }
    case 'pdf_render': {
      const pdfProtocol = ctx[params.design_from || 'last_pdf_design'];
      const pdfOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(pdfOutPath)))
        safeMkdir(path.dirname(pdfOutPath), { recursive: true });
      await retry(
        async () => generateNativePdf(pdfProtocol, pdfOutPath, params.options),
        buildRetryOptions()
      );
      const pdfStats = safeStat(pdfOutPath);
      logger.info(`✅ [MEDIA] PDF rendered at: ${pdfOutPath} (${pdfStats.size} bytes).`);
      break;
    }
    case 'generate_document': {
      const fromKey = resolve(params.from) || 'last_json';
      const inlineData = params.data && typeof params.data === 'object' ? params.data : {};
      const source =
        params.brief && typeof params.brief === 'object'
          ? params.brief
          : ctx[fromKey] && typeof ctx[fromKey] === 'object'
            ? ctx[fromKey]
            : {};
      const renderTarget = String(
        params.render_target || source.render_target || inlineData.render_target || ''
      ).trim();
      const profileId = String(
        params.profile_id || source.document_profile || inlineData.document_profile || ''
      ).trim();
      const brief = buildUnifiedDocumentBrief(
        rootDir,
        {
          profileId,
          renderTarget,
          source,
          data: inlineData,
        },
        loadDocumentCompositionCatalog
      );
      const compiled = compileBriefToDesignProtocol(rootDir, brief);
      const outPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      await renderCompiledProtocol(compiled, outPath, params.options);
      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Unified document generated at: ${outPath} (${stats.size} bytes).`);
      return {
        ...ctx,
        [params.export_as || 'media_render_diagnostics']:
          compiled.protocol?.metadata?.layoutDiagnostics ||
          summarizeMediaPptxLayout(compiled.protocol),
      };
    }
    case 'write_file':
      safeWriteFile(
        path.resolve(rootDir, resolve(params.path)),
        ctx[params.from] || params.content
      );
      break;
    case 'drawio_write': {
      const outPath = path.resolve(rootDir, resolve(params.path));
      const content = ctx[params.from || 'last_drawio_document'] || resolve(params.content);
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('drawio_write requires XML content via params.from or params.content');
      }
      ensureParentDir(outPath);
      safeWriteFile(outPath, content);
      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Draw.io document written at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'save_brand_to_confidential': {
      // Writes tenant-override.json + layout-templates.json to confidential tier,
      // then registers the tenant in knowledge/confidential/tenants/index.json.
      const tenantSlug: string = resolve(params.tenant_slug) || ctx.tenant_slug;
      const brandName: string = resolve(params.brand_name) || ctx.brand_name || tenantSlug;
      const matchers: string[] = params.matchers
        ? Array.isArray(params.matchers)
          ? params.matchers
          : [resolve(params.matchers)]
        : [brandName.toLowerCase()];
      const dsId: string =
        resolve(params.design_system_id) || ctx.design_system_id || 'executive-standard';
      const theme: any = ctx[resolve(params.theme_from) || 'active_theme'] || {};
      const webTheme: any =
        ctx[resolve(params.web_theme_from) || 'active_web_theme'] || ctx.active_web_theme || null;
      const webSnapshot: any =
        ctx[resolve(params.web_from) || 'web_snapshot'] || ctx.active_web_snapshot || null;
      const layoutGeo: any = ctx[resolve(params.layout_from) || 'last_layout_geometry'] || {};
      const pptxDesign: any =
        ctx[resolve(params.pptx_from) || 'source_pptx_design'] || ctx.active_pptx_design || null;
      const isWebPack = Boolean(webTheme);
      const webHeritage = webTheme?.web
        ? cloneJsonValue(webTheme.web)
        : webSnapshot
          ? cloneJsonValue(webSnapshot)
          : null;
      const webLayoutTemplates =
        webTheme?.layout_templates || webHeritage?.layout_templates || null;
      const extractedTemplate: any =
        layoutGeo?.template || (pptxDesign ? deriveLayoutTemplateFromPptxDesign(pptxDesign) : null);

      if (!tenantSlug) throw new Error('save_brand_to_confidential: tenant_slug is required');

      const confDir = path.resolve(rootDir, `knowledge/confidential/${tenantSlug}/design`);
      safeMkdir(confDir, { recursive: true });

      // 1. Build and write layout-templates.json
      const templateId = `${tenantSlug}-extracted`;
      const needsNewTemplate = isWebPack ? true : layoutGeo.needs_new_template !== false;
      const webTemplate = webLayoutTemplates?.templates
        ? webLayoutTemplates.templates?.[webLayoutTemplates.default] ||
          webLayoutTemplates.templates?.[Object.keys(webLayoutTemplates.templates)[0]]
        : null;
      const templatePayload = isWebPack
        ? webTemplate || {
            chrome: {
              viewport: webHeritage?.viewport || null,
              background: webHeritage?.background || null,
              container: webHeritage?.container || null,
            },
            hero: webHeritage?.hero || {},
            body_zones: webHeritage?.body_zones || {},
            web: webHeritage || {},
          }
        : extractedTemplate || {
            chrome: layoutGeo.geometry?.chrome || {},
            hero: {},
            body_zones: {},
          };
      if (needsNewTemplate && (layoutGeo.geometry || extractedTemplate || isWebPack)) {
        const pubCatalog = loadLayoutTemplateCatalog(rootDir);
        const baseTemplate =
          pubCatalog.templates?.[layoutGeo.recommended_template_id || 'corporate-standard'] || {};
        const newTemplate = {
          chrome: { ...baseTemplate.chrome, ...(templatePayload.chrome || {}) },
          hero: { ...baseTemplate.hero, ...(templatePayload.hero || {}) },
          body_zones: { ...baseTemplate.body_zones, ...(templatePayload.body_zones || {}) },
          ...(templatePayload.web ? { web: cloneJsonValue(templatePayload.web) } : {}),
          _meta: isWebPack
            ? `Auto-extracted from Web heritage for ${brandName}. Review layout before production use.`
            : `Auto-extracted from PPTX for ${brandName}. Review geometry before production use.`,
        };
        const layoutCatalog = {
          version: '1.0.0',
          default: templateId,
          templates: { [templateId]: newTemplate },
        };
        safeWriteFile(
          path.join(confDir, 'layout-templates.json'),
          JSON.stringify(layoutCatalog, null, 2)
        );
        logger.info(`[BRAND_IMPORT] Wrote confidential layout-templates.json for ${tenantSlug}`);
      }

      // 2. Build and write tenant-override.json
      const usedTemplateId = needsNewTemplate
        ? templateId
        : layoutGeo.matched_template_id || templateId;
      const override: any = {
        _meta: `Auto-imported brand profile for ${brandName}. Review before production use.`,
        design_system_id: dsId,
        matchers,
        theme: `${tenantSlug}-imported`,
      };
      if (needsNewTemplate) {
        override.layout_template_id = templateId;
        override.layout_template_catalog = `knowledge/confidential/${tenantSlug}/design/layout-templates.json`;
      } else {
        override.layout_template_id = usedTemplateId;
      }
      const extractedTheme = webTheme?.theme || theme?.theme || theme;
      if (extractedTheme?.colors || extractedTheme?.fonts) {
        override.extracted_theme = { colors: extractedTheme.colors, fonts: extractedTheme.fonts };
      }
      if (resolve(params.logo_url))
        override.branding = {
          brand_name: brandName,
          logo_url: resolve(params.logo_url),
          tone: 'professional-enterprise',
        };
      else override.branding = { brand_name: brandName };
      if (pptxDesign || theme?.pptx || webTheme) {
        override.theme_pack_path = `knowledge/confidential/${tenantSlug}/design/theme.json`;
      }

      safeWriteFile(path.join(confDir, 'tenant-override.json'), JSON.stringify(override, null, 2));
      logger.info(`[BRAND_IMPORT] Wrote confidential tenant-override.json for ${tenantSlug}`);

      const packTheme = {
        name: webTheme?.theme?.name || theme?.name || brandName,
        colors: webTheme?.theme?.colors || theme?.colors || {},
        fonts: webTheme?.theme?.fonts || theme?.fonts || {},
        assets: {
          logo_url:
            resolve(params.logo_url) ||
            webTheme?.theme?.assets?.logo_url ||
            theme?.assets?.logo_url ||
            undefined,
        },
      };
      const packHeritage = pptxDesign
        ? {
            canvas: cloneJsonValue(pptxDesign.canvas || null),
            master: cloneJsonValue(pptxDesign.master || null),
            rawThemeXml: pptxDesign.rawThemeXml || null,
            rawMasterXml: pptxDesign.rawMasterXml || null,
            rawMasterRelsXml: pptxDesign.rawMasterRelsXml || null,
            rawLayouts: Array.isArray(pptxDesign.rawLayouts)
              ? cloneJsonValue(pptxDesign.rawLayouts)
              : [],
            rawMasters: Array.isArray(pptxDesign.rawMasters)
              ? cloneJsonValue(pptxDesign.rawMasters)
              : [],
            masterMedia: Array.isArray(pptxDesign.masterMedia)
              ? cloneJsonValue(pptxDesign.masterMedia)
              : [],
            rawParts: pptxDesign.rawParts || null,
          }
        : theme?.pptx
          ? cloneJsonValue(theme.pptx)
          : null;
      const packLayoutTemplates =
        isWebPack && webLayoutTemplates
          ? cloneJsonValue(webLayoutTemplates)
          : needsNewTemplate && extractedTemplate
            ? {
                version: '1.0.0',
                default: templateId,
                templates: {
                  [templateId]: {
                    chrome: { ...(extractedTemplate.chrome || {}) },
                    hero: { ...(extractedTemplate.hero || {}) },
                    body_zones: { ...(extractedTemplate.body_zones || {}) },
                    _meta: `Derived from PPTX heritage for ${brandName}.`,
                  },
                },
              }
            : extractedTemplate
              ? {
                  version: '1.0.0',
                  default:
                    layoutGeo.matched_template_id ||
                    layoutGeo.recommended_template_id ||
                    templateId,
                  templates: {
                    [layoutGeo.matched_template_id ||
                    layoutGeo.recommended_template_id ||
                    templateId]: cloneJsonValue(extractedTemplate),
                  },
                }
              : null;
      const themePack = {
        kind: isWebPack ? 'web-theme-pack' : 'pptx-theme-pack',
        version: '1.0.0',
        theme_id: `${tenantSlug}-imported`,
        brand_name: brandName,
        tenant_slug: tenantSlug,
        design_system_id: dsId,
        theme: packTheme,
        web: webHeritage,
        pptx: packHeritage,
        layout_templates: packLayoutTemplates,
        layout_template_id: usedTemplateId,
        layout_template_catalog: override.layout_template_catalog || null,
        source_theme_name: webTheme?.theme?.name || theme?.name || null,
      };
      safeWriteFile(path.join(confDir, 'theme.json'), JSON.stringify(themePack, null, 2));
      logger.info(`[BRAND_IMPORT] Wrote confidential theme.json for ${tenantSlug}`);

      // 3. Update knowledge/confidential/tenants/index.json
      const registryPath = path.resolve(rootDir, 'knowledge/confidential/tenants/index.json');
      let registry: any = { tenants: [] };
      try {
        registry = JSON.parse(safeReadFile(registryPath, { encoding: 'utf8' }) as string);
      } catch {
        /* create new */
      }
      const overridePath = `knowledge/confidential/${tenantSlug}/design/tenant-override.json`;
      const existing = registry.tenants.findIndex((t: any) => t.id === tenantSlug);
      if (existing >= 0)
        registry.tenants[existing] = { id: tenantSlug, override_path: overridePath };
      else registry.tenants.push({ id: tenantSlug, override_path: overridePath });
      safeWriteFile(registryPath, JSON.stringify(registry, null, 2));
      logger.info(`[BRAND_IMPORT] Updated confidential tenant registry for ${tenantSlug}`);

      logger.info(`✅ [BRAND_IMPORT] Brand saved to confidential tier → ${confDir}`);
      break;
    }
    case 'log':
      logger.info(`[MEDIA_LOG] ${resolve(params.message)}`);
      break;
  }
  return ctx;
}

function ensureParentDir(targetPath: string): void {
  const parentDir = path.dirname(targetPath);
  if (!safeExistsSync(parentDir)) {
    safeMkdir(parentDir, { recursive: true });
  }
}

function deepMergeCatalog(base: any, next: any): any {
  if (Array.isArray(base) || Array.isArray(next)) {
    return cloneJsonValue(next);
  }
  if (!base || typeof base !== 'object') return cloneJsonValue(next);
  if (!next || typeof next !== 'object') return cloneJsonValue(next);
  const merged: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = deepMergeCatalog(merged[key], value);
    } else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

function readJsonFilesRecursively(dirPath: string): any[] {
  if (!safeExistsSync(dirPath)) return [];
  const entries = safeReaddir(dirPath).sort();
  const docs: any[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    const stat = safeLstat(fullPath);
    if (stat.isDirectory()) {
      docs.push(...readJsonFilesRecursively(fullPath));
      continue;
    }
    if (!entry.endsWith('.json')) continue;
    docs.push(JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string));
  }
  return docs;
}

function loadJsonCatalog(
  rootDir: string,
  input: {
    directoryPath: string;
    filePath: string;
    fallback: any;
  }
): any {
  const dirPath = path.resolve(rootDir, input.directoryPath);
  const filePath = path.resolve(rootDir, input.filePath);
  const docs = readJsonFilesRecursively(dirPath);
  if (docs.length > 0) {
    return docs.reduce((acc, doc) => deepMergeCatalog(acc, doc), cloneJsonValue(input.fallback));
  }
  if (safeExistsSync(filePath)) {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
  }
  return cloneJsonValue(input.fallback);
}

function loadArtifactLibraryCatalog(rootDir: string): any {
  const dirPath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/artifact-library'
  );
  const docs = readJsonFilesRecursively(dirPath);
  const fallback = { profiles: {} };
  if (docs.length === 0) {
    return fallback;
  }
  return docs.reduce((acc, doc) => {
    if (!doc || typeof doc !== 'object') return acc;
    return deepMergeCatalog(acc, { profiles: doc.profiles || {} });
  }, cloneJsonValue(fallback));
}

function loadDocumentCompositionCatalog(rootDir: string): any {
  const primaryCatalog = loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/document-composition-presets',
    filePath: 'knowledge/public/design-patterns/media-templates/document-composition-presets.json',
    fallback: { defaults: {}, profiles: {} },
  });
  const artifactLibraryCatalog = loadArtifactLibraryCatalog(rootDir);
  return {
    ...primaryCatalog,
    profiles: {
      ...(artifactLibraryCatalog.profiles || {}),
      ...(primaryCatalog.profiles || {}),
    },
  };
}

function loadThemeCatalog(rootDir: string): any {
  const publicCatalog = loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/themes',
    filePath: 'knowledge/public/design-patterns/media-templates/themes.json',
    fallback: { default_theme: 'kyberion-standard', themes: {} },
  });
  const runtimeCatalog = loadJsonCatalog(rootDir, {
    directoryPath: 'active/shared/runtime/design-patterns/media-templates/themes',
    filePath: 'active/shared/runtime/design-patterns/media-templates/themes.json',
    fallback: { default_theme: 'kyberion-standard', themes: {} },
  });
  const personalCatalog = loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/personal/design-patterns/media-templates/themes',
    filePath: 'knowledge/personal/design-patterns/media-templates/themes.json',
    fallback: { default_theme: 'kyberion-standard', themes: {} },
  });
  return deepMergeCatalog(deepMergeCatalog(publicCatalog, runtimeCatalog), personalCatalog);
}

function loadConfidentialThemePackEntries(
  rootDir: string
): { theme_id: string; theme_name?: string; pack_path: string }[] {
  try {
    const confidentialDir = path.resolve(rootDir, 'knowledge/confidential');
    let tenantNames: string[] = [];
    try {
      tenantNames = safeReaddir(confidentialDir);
    } catch (err: any) {
      logger.warn(`[THEME_RESOLVER] safeReaddir failed on ${confidentialDir}: ${err.message}`);
    }
    const entries: { theme_id: string; theme_name?: string; pack_path: string }[] = [];
    for (const tenantName of tenantNames) {
      const themePackPath = path.join(confidentialDir, tenantName, 'design', 'theme.json');
      if (!safeExistsSync(themePackPath)) continue;
      try {
        const pack = JSON.parse(safeReadFile(themePackPath, { encoding: 'utf8' }) as string);
        const themeId = String(
          pack?.theme_id || pack?.theme?.theme_id || pack?.theme?.name || ''
        ).trim();
        if (!themeId) continue;
        entries.push({
          theme_id: themeId,
          theme_name: pack?.theme?.name,
          pack_path: `knowledge/confidential/${tenantName}/design/theme.json`,
        });
      } catch (err: any) {
        logger.warn(
          `[THEME_RESOLVER] Failed reading theme JSON for tenant ${tenantName}: ${err.message}`
        );
        continue;
      }
    }
    return entries;
  } catch (err: any) {
    logger.warn(
      `[THEME_RESOLVER] loadConfidentialThemePackEntries general failure: ${err.message}`
    );
    return [];
  }
}

function resolveConfidentialThemePack(rootDir: string, themeName: string): any {
  const normalized = String(themeName || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  // Try direct path first to bypass sandbox/secure-io directory listing limitations
  const potentialSlugs = [
    normalized,
    normalized.split('-')[0],
    normalized.replace('-imported', ''),
  ];
  for (const slug of potentialSlugs) {
    if (!slug) continue;
    const directPath = path.join(rootDir, 'knowledge/confidential', slug, 'design/theme.json');
    if (safeExistsSync(directPath)) {
      try {
        const pack = JSON.parse(safeReadFile(directPath, { encoding: 'utf8' }) as string);
        const themeId = String(
          pack?.theme_id || pack?.theme?.theme_id || pack?.theme?.name || ''
        ).trim();
        if (
          themeId.toLowerCase() === normalized ||
          String(pack?.theme?.name || '').toLowerCase() === normalized
        ) {
          logger.info(
            `[THEME_RESOLVER] Direct resolved confidential theme pack from: ${directPath}`
          );
          return pack;
        }
      } catch (err: any) {
        logger.warn(`[THEME_RESOLVER] Direct load failed for ${directPath}: ${err.message}`);
      }
    }
  }

  // Scan fallback
  for (const entry of loadConfidentialThemePackEntries(rootDir)) {
    if (
      entry.theme_id.toLowerCase() !== normalized &&
      String(entry.theme_name || '').toLowerCase() !== normalized
    ) {
      continue;
    }
    try {
      const packPath = path.resolve(rootDir, entry.pack_path);
      return JSON.parse(safeReadFile(packPath, { encoding: 'utf8' }) as string);
    } catch {
      continue;
    }
  }
  return null;
}

function loadMediaDesignSystemsCatalog(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/media-design-systems',
    filePath: 'knowledge/public/design-patterns/media-templates/media-design-systems.json',
    fallback: { default_system: 'executive-standard', systems: {} },
  });
}

function loadImportedDesignMdIndex(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/design-md-catalog',
    filePath: 'knowledge/public/design-patterns/media-templates/design-md-catalog/index.json',
    fallback: { systems: [] },
  });
}

function normalizeDesignLookupKey(input: any): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveDesignBindingHints(brief: any): {
  tenant_id?: string;
  client_key?: string;
  design_system_id?: string;
  design_reference?: string;
  theme?: string;
  branding?: Record<string, any>;
} {
  const direct = {
    tenant_id:
      String(
        brief?.tenant_id ||
          brief?.payload?.tenant_id ||
          brief?.tenant_slug ||
          brief?.payload?.tenant_slug ||
          ''
      ).trim() || undefined,
    client_key: String(brief?.client_key || brief?.payload?.client_key || '').trim() || undefined,
    design_system_id:
      String(brief?.design_system_id || brief?.payload?.design_system_id || '').trim() || undefined,
    design_reference:
      String(brief?.design_reference || brief?.payload?.design_reference || '').trim() || undefined,
    theme: String(brief?.theme || brief?.payload?.theme || '').trim() || undefined,
    branding:
      brief?.branding && typeof brief.branding === 'object'
        ? brief.branding
        : brief?.payload?.branding && typeof brief.payload.branding === 'object'
          ? brief.payload.branding
          : {},
  };
  const projectId = String(brief?.project_id || brief?.payload?.project_id || '').trim();
  const project = projectId ? loadProjectRecord(projectId) : null;
  const projectMeta =
    project?.metadata && typeof project.metadata === 'object'
      ? (project.metadata as Record<string, any>)
      : {};
  const bindingIds = [
    ...(Array.isArray(project?.service_bindings) ? project!.service_bindings : []).map(
      (value: any) => String(value)
    ),
    ...(Array.isArray(brief?.service_binding_ids) ? brief.service_binding_ids : []).map(
      (value: any) => String(value)
    ),
    ...(Array.isArray(brief?.payload?.service_binding_ids)
      ? brief.payload.service_binding_ids
      : []
    ).map((value: any) => String(value)),
  ].filter(Boolean);
  const bindings = bindingIds
    .map((bindingId) => loadServiceBindingRecord(bindingId))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const bindingMeta =
    bindings
      .map((binding) =>
        binding.metadata && typeof binding.metadata === 'object'
          ? (binding.metadata as Record<string, any>)
          : {}
      )
      .find((meta) => Object.keys(meta).length > 0) || {};

  return {
    tenant_id:
      direct.tenant_id ||
      String(projectMeta.tenant_id || bindingMeta.tenant_id || '').trim() ||
      undefined,
    client_key:
      direct.client_key ||
      String(projectMeta.client_key || bindingMeta.client_key || '').trim() ||
      undefined,
    design_system_id:
      direct.design_system_id ||
      String(projectMeta.design_system_id || bindingMeta.design_system_id || '').trim() ||
      undefined,
    design_reference:
      direct.design_reference ||
      String(
        projectMeta.design_reference ||
          bindingMeta.design_reference ||
          bindingMeta.design_system_slug ||
          ''
      ).trim() ||
      undefined,
    theme: direct.theme || String(projectMeta.theme || bindingMeta.theme || '').trim() || undefined,
    branding: {
      ...(projectMeta.branding || {}),
      ...(bindingMeta.branding || {}),
      ...(direct.branding || {}),
    },
  };
}

function resolveImportedDesignReference(rootDir: string, input: any): any | null {
  const catalog = loadImportedDesignMdIndex(rootDir);
  const candidates = [
    input?.design_reference,
    input?.client_key,
    input?.tenant_id,
    input?.client,
    input?.project_name,
    input?.project_id,
  ]
    .map((value: any) => normalizeDesignLookupKey(value))
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const systems = Array.isArray(catalog.systems) ? catalog.systems : [];
  return (
    systems.find((entry: any) => {
      const values = [
        entry?.design_system_id,
        entry?.theme_id,
        entry?.slug,
        entry?.name,
        entry?.description,
        entry?.category,
        ...(Array.isArray(entry?.keywords) ? entry.keywords : []),
      ].map(normalizeDesignLookupKey);
      return candidates.some((candidate) =>
        values.some((value) => {
          if (!value) return false;
          if (value === candidate) return true;
          if (candidate.length >= 4 && value.includes(candidate)) return true;
          return false;
        })
      );
    }) || null
  );
}

function recommendImportedDesignReferences(rootDir: string, brief: any, limit = 3): any[] {
  const catalog = loadImportedDesignMdIndex(rootDir);
  const systems = Array.isArray(catalog.systems) ? catalog.systems : [];
  const haystack = normalizeDesignLookupKey(
    [
      brief?.design_reference,
      brief?.client,
      brief?.client_key,
      brief?.title,
      brief?.objective,
      brief?.summary,
      brief?.project_name,
      brief?.project_id,
      brief?.payload?.title,
      brief?.payload?.summary,
      brief?.payload?.client,
      brief?.story?.core_message,
      brief?.story?.closing_cta,
      brief?.payload?.story?.core_message,
      brief?.audience,
      brief?.payload?.audience,
    ]
      .filter(Boolean)
      .join(' ')
  );

  if (!haystack) return [];

  const scored = systems
    .map((entry: any) => {
      const terms = [
        entry?.slug,
        entry?.name,
        entry?.category,
        entry?.description,
        ...(Array.isArray(entry?.keywords) ? entry.keywords : []),
      ]
        .map(normalizeDesignLookupKey)
        .filter(Boolean);
      let score = 0;
      for (const term of terms) {
        if (!term) continue;
        if (haystack === term) score += 10;
        else if (haystack.includes(term))
          score += Math.min(6, Math.max(2, term.split(' ').length + 1));
        else if (term.includes(haystack)) score += 1;
      }
      return {
        ...entry,
        recommendation_score: score,
      };
    })
    .filter((entry: any) => entry.recommendation_score > 0)
    .sort((left: any, right: any) => {
      if (right.recommendation_score !== left.recommendation_score)
        return right.recommendation_score - left.recommendation_score;
      return String(left.design_system_id || '').localeCompare(
        String(right.design_system_id || '')
      );
    });

  return scored.slice(0, limit).map((entry: any) => ({
    design_system_id: entry.design_system_id,
    theme_id: entry.theme_id,
    slug: entry.slug,
    name: entry.name,
    category: entry.category,
    description: entry.description,
    recommendation_score: entry.recommendation_score,
    source_path: entry.source_path,
  }));
}

function resolveMediaDesignSystem(
  rootDir: string,
  brief: any
): {
  designSystemId: string;
  system: any;
  tenantOverride: any;
  resolvedThemeName: string;
  branding: any;
  promptGuide: string[];
  sourceDesign?: Record<string, any> | null;
  recommendations: any[];
} {
  const catalog = loadMediaDesignSystemsCatalog(rootDir);
  const bindingHints = resolveDesignBindingHints(brief);
  const recommendations = recommendImportedDesignReferences(rootDir, brief);
  const explicit = String(bindingHints.design_system_id || '').trim();
  const resolveTenantOverride = (_system: any, designSystemId?: string) => {
    const clientHint =
      bindingHints.tenant_id ||
      bindingHints.client_key ||
      brief?.client ||
      brief?.payload?.client ||
      '';
    const override = resolveConfidentialTenantOverride(rootDir, String(clientHint));
    if (override) return override;
    return designSystemId
      ? resolveConfidentialTenantOverride(rootDir, String(clientHint), designSystemId)
      : null;
  };
  const buildResult = (designSystemId: string, system: any) => {
    const tenantOverride = resolveTenantOverride(system, designSystemId);
    const promptGuide = Array.isArray(system?.metadata?.prompt_guide)
      ? system.metadata.prompt_guide
      : [];
    return {
      designSystemId,
      system,
      tenantOverride,
      resolvedThemeName: String(
        bindingHints.theme || tenantOverride?.theme || system?.theme || 'kyberion-standard'
      ),
      branding: {
        ...(system?.branding || {}),
        ...(tenantOverride?.branding || {}),
        ...(bindingHints.branding || {}),
      },
      promptGuide,
      recommendations,
      sourceDesign:
        system?.metadata?.source_type === 'design-md'
          ? {
              source_type: system.metadata.source_type,
              source_repo: system.metadata.source_repo,
              source_path: system.metadata.source_path,
              slug: system.metadata.slug,
              category: system.metadata.category,
              description: system.metadata.description,
            }
          : null,
    };
  };
  if (explicit && catalog.systems?.[explicit]) {
    return buildResult(explicit, catalog.systems[explicit]);
  }
  const imported = resolveImportedDesignReference(rootDir, {
    ...bindingHints,
    client: brief?.client || brief?.payload?.client,
    project_name:
      brief?.project_name || brief?.payload?.project_name || brief?.name || brief?.payload?.name,
    project_id: brief?.project_id || brief?.payload?.project_id,
  });
  if (imported?.design_system_id && catalog.systems?.[imported.design_system_id]) {
    return buildResult(imported.design_system_id, catalog.systems[imported.design_system_id]);
  }
  const profileId = String(brief?.document_profile || '').trim();
  const matched = Object.entries(catalog.systems || {}).find(
    ([, system]: any) => Array.isArray(system?.profiles) && system.profiles.includes(profileId)
  );
  if (matched) {
    return buildResult(matched[0], matched[1]);
  }
  const fallbackId = String(catalog.default_system || 'executive-standard');
  return buildResult(fallbackId, catalog.systems?.[fallbackId] || {});
}

function loadSemanticRenderTokenCatalog(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/semantic-render-tokens',
    filePath: 'knowledge/public/design-patterns/media-templates/semantic-render-tokens.json',
    fallback: { defaults: { content: {} }, semantics: {}, signal_tones: {} },
  });
}

function resolveSemanticRenderTokens(
  rootDir: string,
  semanticType?: string,
  designSystemId?: string
): any {
  const catalog = loadSemanticRenderTokenCatalog(rootDir);
  const key = String(semanticType || 'content').trim() || 'content';
  const designSystems = loadMediaDesignSystemsCatalog(rootDir);
  const systemOverrides = designSystemId
    ? designSystems.systems?.[designSystemId]?.semantic_overrides?.[key] || {}
    : {};
  return {
    ...(catalog.defaults?.content || {}),
    ...(catalog.semantics?.[key] || {}),
    ...systemOverrides,
  };
}

function resolveSemanticComponentRule(
  rootDir: string,
  semanticType: string | undefined,
  medium: string,
  component: string
): any {
  const tokens = resolveSemanticRenderTokens(rootDir, semanticType);
  return {
    ...(tokens?.[medium] && tokens[medium][component] ? tokens[medium][component] : {}),
  };
}

function resolveNamedTheme(rootDir: string, preferredTheme?: string): any {
  const catalog = loadThemeCatalog(rootDir);
  const themeName = String(preferredTheme || catalog.default_theme || 'kyberion-standard').trim();

  // 1. Try public theme directly
  const publicTheme = catalog.themes?.[themeName] || null;
  if (publicTheme) return publicTheme;

  // 2. Try confidential theme pack
  const confidentialPack = resolveConfidentialThemePack(rootDir, themeName);
  if (confidentialPack?.theme) {
    return {
      ...confidentialPack.theme,
      layout_templates: confidentialPack.layout_templates || null,
      pptx: confidentialPack.pptx || null,
      web: confidentialPack.web || null,
      kind: confidentialPack.kind || null,
    };
  }

  // 3. Fallback to default public theme
  return catalog.themes?.[catalog.default_theme] || null;
}

function resolveDocumentCompositionPresetCore(
  rootDir: string,
  brief: any
): { profileId: string; preset: any } {
  const catalog = loadDocumentCompositionCatalog(rootDir);
  const profiles = catalog.profiles || {};
  const defaults = catalog.defaults || {};
  const artifactFamily = String(
    brief?.artifact_family || brief?.payload?.artifact_family || ''
  ).trim();
  const documentType = String(brief?.document_type || brief?.payload?.document_type || '').trim();
  const explicitProfile = String(
    brief?.document_profile || brief?.payload?.document_profile || brief?.profile_id || ''
  ).trim();

  const candidateProfiles = new Set<string>();
  if (explicitProfile) candidateProfiles.add(explicitProfile);
  if (artifactFamily && typeof defaults[artifactFamily] === 'string')
    candidateProfiles.add(defaults[artifactFamily]);
  if (documentType && typeof defaults[documentType] === 'string')
    candidateProfiles.add(defaults[documentType]);
  for (const candidate of resolveDocumentProfileCandidatesPolicy(documentType, artifactFamily)) {
    candidateProfiles.add(String(candidate));
  }

  const clueText = [
    brief?.title,
    brief?.summary,
    brief?.objective,
    brief?.document_type,
    brief?.document_profile,
    brief?.payload?.title,
    brief?.payload?.summary,
    brief?.payload?.objective,
    brief?.payload?.document_type,
    brief?.payload?.document_profile,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  const keywords = resolveDocumentProfileKeywordsPolicy(documentType, artifactFamily);
  const buildPreset = (profileId: string, preset: any) => {
    const designSystem = resolveMediaDesignSystem(rootDir, {
      ...brief,
      document_profile: profileId,
      profile_id: profileId,
    });
    return {
      profileId,
      preset: {
        ...preset,
        design_system_id: designSystem.designSystemId,
        recommended_theme: designSystem.resolvedThemeName || preset.recommended_theme,
        branding: {
          ...(preset.branding || {}),
          ...(designSystem.branding || {}),
        },
        prompt_guide: Array.isArray(preset.prompt_guide)
          ? preset.prompt_guide
          : designSystem.promptGuide,
        source_design: preset.source_design || designSystem.sourceDesign || null,
        design_recommendations: Array.isArray(preset.design_recommendations)
          ? preset.design_recommendations
          : designSystem.recommendations,
      },
    };
  };

  for (const profileId of candidateProfiles) {
    const preset = profiles?.[profileId];
    if (!preset) continue;
    if (keywords.length === 0 || keywords.some((keyword) => clueText.includes(keyword))) {
      return buildPreset(profileId, preset);
    }
  }

  const inferredProfileId =
    explicitProfile ||
    defaults[artifactFamily] ||
    defaults[documentType] ||
    defaults.proposal ||
    defaults.report ||
    defaults.spreadsheet ||
    defaults.diagram;
  if (inferredProfileId && profiles?.[inferredProfileId]) {
    return buildPreset(inferredProfileId, profiles[inferredProfileId]);
  }

  for (const [profileId, preset] of Object.entries(profiles)) {
    if (!preset || typeof preset !== 'object') continue;
    if (artifactFamily && String((preset as any).artifact_family || '') !== artifactFamily)
      continue;
    if (documentType && String((preset as any).document_type || '') !== documentType) continue;
    return buildPreset(profileId, preset);
  }

  const fallbackId = String(
    defaults[artifactFamily] ||
      defaults[documentType] ||
      defaults.report ||
      defaults.proposal ||
      defaults.spreadsheet ||
      defaults.diagram ||
      'summary-report'
  );
  const profileId = profiles[fallbackId]
    ? fallbackId
    : profiles['summary-report']
      ? 'summary-report'
      : fallbackId;
  const preset = profiles[profileId] || profiles[fallbackId] || profiles['summary-report'] || {};
  return buildPreset(profileId, preset);
}

const mediaDocumentPipelineHelpers = createMediaDocumentPipelineHelpers({
  resolveNamedTheme,
  loadDocumentCompositionCatalog,
  buildPptxSlideFromPattern,
  buildProposalNarrativeOutline,
  buildReportNarrativeOutline,
  buildSpreadsheetNarrativeOutline,
  buildDiagramNarrativeOutline,
  buildReportDocxProtocol,
  buildReportPdfProtocol,
  buildTrackerSpreadsheetProtocol,
  buildDocumentPdfProtocol,
  normalizeXlsxDesignProtocol,
  resolveDocumentLayoutTemplate,
  resolveDocumentCompositionPreset,
  applyCompositionTemplate,
  buildMediaGenerationBoundary,
  normalizeBriefForCategory,
  resolveMediaBriefCategory,
  generateDrawioDocument,
});

const mediaReportPipelineHelpers = createMediaReportPipelineHelpers({
  resolveNamedTheme,
  resolveDocumentCompositionPreset,
  resolveDocumentLayoutTemplate,
  resolveSemanticComponentRule,
  themeToDocxStyleHints,
  themeToPptxPalette,
  normalizeFontFamily,
});
const mediaSpreadsheetPipelineHelpers = createMediaSpreadsheetPipelineHelpers({
  resolveNamedTheme,
  resolveDocumentCompositionPreset,
  resolveDocumentLayoutTemplate,
  loadSemanticRenderTokenCatalog,
});

function resolveDocumentCompositionPreset(
  rootDir: string,
  brief: any
): { profileId: string; preset: any } {
  return resolveDocumentCompositionPresetCore(rootDir, brief);
}

function buildOutlineDrivenPptxProtocol(
  rootDir: string,
  outline: any
): { protocol: any; theme: any; themeName: string } {
  return mediaDocumentPipelineHelpers.buildOutlineDrivenPptxProtocol(rootDir, outline);
}

const proposalPptxFlow = createProposalPptxFlow({
  resolveDocumentCompositionPreset,
  buildMediaGenerationBoundary,
});

function buildPresentationPptxProtocol(
  rootDir: string,
  brief: any
): { protocol: any; outline: any; theme: any; themeName: string } {
  return mediaDocumentPipelineHelpers.buildPresentationPptxProtocol(rootDir, brief);
}

function buildOutlineFromNormalizedBrief(
  rootDir: string,
  category: 'presentation' | 'document' | 'spreadsheet' | 'diagram',
  brief: any
): any {
  return mediaDocumentPipelineHelpers.buildOutlineFromNormalizedBrief(rootDir, category, brief);
}

function buildCompiledBriefContext(input: {
  rootDir: string;
  ctx: any;
  rawBrief: any;
  exportAs?: string;
  briefContextKey?: string;
}): any {
  return mediaDocumentPipelineHelpers.buildCompiledBriefContext(input);
}

async function renderCompiledProtocol(
  compiled: {
    protocol: any;
    protocolKind: ProtocolKind;
  },
  outPath: string,
  options?: any
): Promise<void> {
  return mediaDocumentPipelineHelpers.renderCompiledProtocol(compiled, outPath, options);
}

async function renderDiagramDocumentBrief(
  rootDir: string,
  brief: any,
  outPath: string,
  params: any,
  ctx: any,
  resolve: Function
): Promise<void> {
  return mediaDocumentPipelineHelpers.renderDiagramDocumentBrief(
    rootDir,
    brief,
    outPath,
    params,
    ctx,
    resolve
  );
}

function resolveObjectInput(
  ctx: any,
  params: any,
  resolve: Function,
  defaults: {
    paramKey?: string;
    fromKey?: string;
    opName: string;
  }
): any {
  return mediaDocumentPipelineHelpers.resolveObjectInput(ctx, params, resolve, defaults);
}

function compileBriefToDesignProtocol(
  rootDir: string,
  rawBrief: any
): {
  protocol: any;
  outline: any;
  theme: any;
  themeName: string;
  protocolKind: ProtocolKind;
  exportKey: string;
} {
  return mediaDocumentPipelineHelpers.compileBriefToDesignProtocol(rootDir, rawBrief);
}

function themeToPptxPalette(theme: any): any {
  const colors = theme?.colors || theme?.theme?.colors || {};
  return {
    dk1: String(colors.primary || '#000000').replace('#', ''),
    dk2: String(colors.secondary || colors.text || '#44546A').replace('#', ''),
    lt1: String(colors.background || '#FFFFFF').replace('#', ''),
    lt2: String(colors.background || '#E7E6E6').replace('#', ''),
    accent1: String(colors.accent || '#38BDF8').replace('#', ''),
    accent2: String(colors.secondary || '#334155').replace('#', ''),
  };
}

function themeToDocxStyleHints(
  theme: any,
  locale?: string
): { headingFont: string; bodyFont: string; accent: string } {
  const themeFonts = theme?.fonts || theme?.theme?.fonts || {};
  const headingFont = normalizeFontFamily(
    locale?.startsWith('ja')
      ? resolveEastAsianFontFamily(themeFonts.heading || themeFonts.body)
      : themeFonts.heading || 'Aptos'
  );
  const bodyFont = normalizeFontFamily(
    locale?.startsWith('ja')
      ? resolveEastAsianFontFamily(themeFonts.body || themeFonts.heading)
      : themeFonts.body || 'Aptos'
  );
  return {
    headingFont,
    bodyFont,
    accent: String(theme?.colors?.accent || theme?.theme?.colors?.accent || '#2563eb').replace(
      '#',
      ''
    ),
  };
}

function resolveThemeColorRole(palette: any, accentHex: string, role?: string): string {
  const resolvedRole = resolveThemeColorRolePolicy(role, 'secondary');
  switch (resolvedRole) {
    case 'accent':
      return accentHex || palette.accent1 || '2563EB';
    case 'primary':
      return palette.dk1 || '111827';
    default:
      return palette.dk2 || palette.dk1 || accentHex || '334155';
  }
}

function resolveThemeHexColor(themeColors: any, role?: string, fallback = '#334155'): string {
  const resolvedRole = resolveThemeHexRolePolicy(role, 'secondary');
  switch (resolvedRole) {
    case 'accent':
      return String(themeColors.accent || fallback);
    case 'primary':
      return String(themeColors.primary || fallback);
    case 'background':
      return String(themeColors.background || '#F8FAFC');
    case 'success':
      return String(themeColors.success || '#DCFCE7');
    case 'warning':
      return String(themeColors.warning || '#FEF3C7');
    case 'info':
      return String(themeColors.info || '#DBEAFE');
    case 'muted':
      return String(themeColors.muted || '#F1F5F9');
    case 'surface':
      return String(themeColors.surface || themeColors.background_card || '#E9EDF4');
    case 'navy':
      return String(themeColors.navy || themeColors.primary_dark || fallback);
    case 'cta':
      return String(themeColors.cta || themeColors.azure || themeColors.accent || fallback);
    case 'text_primary':
      return String(themeColors.text_primary || themeColors.text || '#000000');
    case 'text_secondary':
      return String(themeColors.text_secondary || themeColors.secondary || '#595959');
    default:
      return String(themeColors.secondary || themeColors.text || fallback);
  }
}

function applyCompositionTemplate(
  template: any,
  tokens: Record<string, string>,
  fallback = ''
): string {
  return proposalPptxFlow.applyCompositionTemplate(template, tokens, fallback);
}

function normalizeProposalText(value: unknown): string {
  return proposalPptxFlow.normalizeProposalText(value);
}

function isPlaceholderProposalText(value: unknown): boolean {
  return proposalPptxFlow.isPlaceholderProposalText(value);
}

function sanitizeProposalText(value: unknown, fallback: string): string {
  return proposalPptxFlow.sanitizeProposalText(value, fallback);
}

function normalizeProposalList(value: unknown, fallback: string[]): string[] {
  return proposalPptxFlow.normalizeProposalList(value, fallback);
}

function normalizeAudienceList(value: unknown, fallback: string[]): string[] {
  return proposalPptxFlow.normalizeAudienceList(value, fallback);
}

function buildCanonicalProposalEvidence(brief: any): Array<{ title: string; point: string }> {
  return proposalPptxFlow.buildCanonicalProposalEvidence(brief);
}

function buildCanonicalProposalSlides(rootDir: string, brief: any): any[] {
  return proposalPptxFlow.buildCanonicalProposalSlides(rootDir, brief);
}

function buildProposalNarrativeOutline(rootDir: string, brief: any): any {
  return proposalPptxFlow.buildProposalNarrativeOutline(rootDir, brief);
}

function normalizeProposalBrief(rootDir: string, input: any): any {
  return proposalPptxFlow.normalizeProposalBrief(rootDir, input);
}

function buildReportDocxProtocol(rootDir: string, brief: any): any {
  return mediaReportPipelineHelpers.buildReportDocxProtocol(rootDir, brief);
}

function buildReportPdfProtocol(rootDir: string, brief: any): any {
  return mediaReportPipelineHelpers.buildReportPdfProtocol(rootDir, brief);
}

function buildTrackerSpreadsheetProtocol(rootDir: string, brief: any): any {
  return mediaSpreadsheetPipelineHelpers.buildTrackerSpreadsheetProtocol(rootDir, brief);
}
function resolveDocumentLayoutTemplate(
  rootDir: string,
  brief: any
): { templateId: string; template: any } {
  return mediaDocumentPipelineHelpers.resolveDocumentLayoutTemplate(rootDir, brief);
}

function buildDocumentPdfProtocol(rawBrief: any): any {
  return mediaDocumentPipelineHelpers.buildDocumentPdfProtocol(rawBrief);
}

async function maybeAugmentPdfDesignWithImageOcr(
  pdfDesign: PdfDesignProtocol,
  hints?: PdfToPptxHints
): Promise<PdfDesignProtocol> {
  const resolvedHints: PdfToPptxHints = {
    canvas: { ...DEFAULT_PDF_TO_PPTX_HINTS.canvas, ...(hints?.canvas || {}) },
    features: { ...DEFAULT_PDF_TO_PPTX_HINTS.features, ...(hints?.features || {}) },
    ocr: { ...DEFAULT_PDF_TO_PPTX_HINTS.ocr, ...(hints?.ocr || {}) },
    style: { ...DEFAULT_PDF_TO_PPTX_HINTS.style, ...(hints?.style || {}) },
    layout: { ...DEFAULT_PDF_TO_PPTX_HINTS.layout, ...(hints?.layout || {}) },
    theme: { ...DEFAULT_PDF_TO_PPTX_HINTS.theme, ...(hints?.theme || {}) },
  };
  if (!resolvedHints.features?.fullPageImageOcrOverlay) return pdfDesign;
  if (!Array.isArray(pdfDesign.content?.pages) || pdfDesign.content.pages.length === 0)
    return pdfDesign;

  const cloned = cloneJsonValue(pdfDesign as any) as PdfDesignProtocol;
  for (const page of cloned.content.pages as any[]) {
    const pageWidth = page?.width || 960;
    const pageHeight = page?.height || 540;
    const pageArea = pageWidth * pageHeight;
    const images = Array.isArray(page?.images) ? page.images : [];
    const dominantImage = images.find(
      (image: any) => (image.width || 0) * (image.height || 0) >= pageArea * 0.85
    );
    const positionedTextElements = Array.isArray(page?.elements)
      ? page.elements.filter((element: any) => ['text', 'heading'].includes(element?.type))
      : [];
    const existingTextCount = positionedTextElements.length;
    const reliableTextCount = positionedTextElements.filter((element: any) =>
      mediaPdfHelpers.isLikelyReliablePdfText(String(element?.text || ''))
    ).length;
    const hasMostlyUnreliableText =
      existingTextCount > 0 && reliableTextCount / existingTextCount < 0.35;
    const shouldRunOcr =
      existingTextCount <= 8 || reliableTextCount <= 3 || hasMostlyUnreliableText;
    if (Array.isArray(page?.ocrLines) && page.ocrLines.length > 0) continue;
    if (!dominantImage || !dominantImage.path || !shouldRunOcr) continue;
    try {
      const requestedLanguage = resolvedHints.ocr?.language || 'jpn+eng';
      const ocr = await recognizeDocumentImage({
        path: dominantImage.path,
        language: requestedLanguage,
        mode: 'local_only',
      });
      page.ocrProvider = ocr.provider;
      page.ocrConfidence = ocr.confidence;
      page.ocrLines = mediaPdfHelpers.buildPdfPageOcrOverlayLinesFromResult(
        page,
        dominantImage,
        ocr
      );
    } catch (error: any) {
      logger.warn(
        `[MEDIA_TRANSFORM] fullPageImageOcrOverlay failed on page ${page.pageNumber}: ${error.message}`
      );
    }
  }
  return cloned;
}

interface DocumentOcrOptions {
  language?: string;
  mode?: 'fast' | 'accurate' | 'balanced' | 'local_only' | 'privacy_first';
}

async function collectPptxImageOcr(
  design: any,
  options: DocumentOcrOptions = {}
): Promise<Map<number, any>> {
  const bySlide = new Map<number, any>();
  const slides = Array.isArray(design?.slides) ? design.slides : [];
  for (const [index, slide] of slides.entries()) {
    const imageElements = Array.isArray(slide?.elements)
      ? slide.elements.filter((element: any) => element?.type === 'image' && element?.imagePath)
      : [];
    const results: any[] = [];
    for (const image of imageElements) {
      try {
        const result = await recognizeDocumentImage({
          path: image.imagePath,
          language: options.language || 'jpn+eng',
          mode: options.mode || 'local_only',
        });
        if (result.text.trim()) {
          results.push({
            provider: result.provider,
            confidence: result.confidence,
            text: result.text.trim(),
            lines: result.lines,
            imagePath: image.imagePath,
          });
        }
      } catch (error: any) {
        logger.warn(
          `[MEDIA_CAPTURE] PPTX image OCR failed on slide ${index + 1}: ${error.message}`
        );
      }
    }
    if (results.length === 0) continue;
    const ocrText = Array.from(new Set(results.map((result) => result.text))).join('\n\n');
    bySlide.set(index + 1, {
      ocr_text: ocrText,
      ocr_results: results,
      ocr_provider: results.map((result) => result.provider).join(','),
      ocr_confidence: Math.round(
        results.reduce((sum, result) => sum + Number(result.confidence || 0), 0) / results.length
      ),
    });
  }
  return bySlide;
}

async function augmentPptxDesignWithImageOcr(
  design: any,
  options: DocumentOcrOptions = {}
): Promise<any> {
  const cloned = cloneJsonValue(design);
  const ocrBySlide = await collectPptxImageOcr(design, options);
  for (const [index, slide] of (cloned.slides || []).entries()) {
    const ocr = ocrBySlide.get(index + 1);
    if (ocr) slide.ocr = ocr;
  }
  return cloned;
}

const main = async () => {
  await runActuatorCli({
    name: 'media-actuator',
    handleAction,
  });
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch((err) => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
