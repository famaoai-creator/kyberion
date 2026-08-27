import { draftDeckSectionBodies, selectDeckTheme } from '@agent/core';
import {
  loadJsonCatalog,
  loadMediaDesignSystemsCatalog,
  loadJsonValue,
  loadTenantEntries,
  resolveConfidentialTenantOverride,
} from './media-catalog-loaders.js';
import { htmlToDeckProtocol } from './html-deck-helpers.js';
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
import { getRegisteredEnvText } from '@agent/core/foundation';
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

let _cachedBzl: ReturnType<typeof loadJsonValue> | null = null;
function loadBodyZoneLayouts(rootDir: string): any {
  if (_cachedBzl) return _cachedBzl;
  const p = path.join(
    rootDir,
    'knowledge/public/design-patterns/media-templates/slide-layout-presets/body-zone-layouts.json'
  );
  _cachedBzl = loadJsonValue(p);
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
    _cachedLayoutTemplates = loadJsonValue(p);
  } catch {
    _cachedLayoutTemplates = { default: 'corporate-standard', templates: {} };
  }
  return _cachedLayoutTemplates;
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
      const catalog = loadJsonValue(catalogPath);
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
