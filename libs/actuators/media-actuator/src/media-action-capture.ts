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
  const configuredPythonBin = getRegisteredEnvText('KYBERION_PYTHON_BIN');
  if (configuredPythonBin) return configuredPythonBin;
  const configuredPython = getRegisteredEnvText('KYBERION_PYTHON');
  if (configuredPython) return configuredPython;
  const legacyVenvPython = pathResolver.rootResolve('.venv/bin/python3');
  if (safeExistsSync(legacyVenvPython)) return legacyVenvPython;
  return 'python3';
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
async function opCapture(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'json_read': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const parsed = loadJsonValue(sourcePath);
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

export {
  opCapture,
  collectPptxImageOcr,
  augmentPptxDesignWithImageOcr,
  assertInProjectRoot,
  PDF_PYPDF_OPS,
};
