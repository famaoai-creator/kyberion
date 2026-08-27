import { draftDeckSectionBodies, loadJson, selectDeckTheme } from '@agent/core';
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
import {
  resolveSemanticRenderTokens,
  resolveThemeColorRole,
  resolveThemeHexColor,
} from './media-layout-design-tokens.js';
import {
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
  type FittedTextBox,
  type ZoneAnchors,
  type ZoneRegionSpec,
} from './media-layout-catalog.js';

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
  buildPptxSlideFromPattern,
};
