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
  ensureParentDir,
  deepMergeCatalog,
  readJsonFilesRecursively,
  loadJsonCatalog,
  loadArtifactLibraryCatalog,
  loadDocumentCompositionCatalog,
  loadThemeCatalog,
  loadConfidentialThemePackEntries,
  resolveConfidentialThemePack,
  loadMediaDesignSystemsCatalog,
  loadImportedDesignMdIndex,
  normalizeDesignLookupKey,
  resolveDesignBindingHints,
  resolveImportedDesignReference,
  recommendImportedDesignReferences,
  resolveMediaDesignSystem,
  loadSemanticRenderTokenCatalog,
  resolveSemanticRenderTokens,
  resolveSemanticComponentRule,
  resolveNamedTheme,
  resolveDocumentCompositionPresetCore,
  resolveDocumentCompositionPreset,
  buildOutlineDrivenPptxProtocol,
  buildPresentationPptxProtocol,
  buildOutlineFromNormalizedBrief,
  buildCompiledBriefContext,
  resolveObjectInput,
  compileBriefToDesignProtocol,
  themeToPptxPalette,
  themeToDocxStyleHints,
  resolveThemeColorRole,
  resolveThemeHexColor,
  applyCompositionTemplate,
  normalizeProposalText,
  isPlaceholderProposalText,
  sanitizeProposalText,
  normalizeProposalList,
  normalizeAudienceList,
  buildCanonicalProposalEvidence,
  buildCanonicalProposalSlides,
  buildProposalNarrativeOutline,
  normalizeProposalBrief,
  buildReportDocxProtocol,
  buildReportPdfProtocol,
  buildTrackerSpreadsheetProtocol,
  resolveDocumentLayoutTemplate,
  buildDocumentPdfProtocol,
} from './media-design-protocol.js';
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
  buildPptxSlideFromPattern,
} from './media-layout-runtime.js';
import { opCapture } from './media-action-capture.js';
import { opTransform } from './media-action-transform.js';
import { opApply } from './media-action-apply.js';

async function handleAction(input: MediaAction) {
  return handleMediaAction(input, {
    opCapture,
    opTransform,
    opApply,
  });
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
