import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeExistsSync,
  safeExecResult,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import * as pptxUtils from '@agent/core/pptx-utils';
import * as xlsxUtils from '@agent/core/xlsx-utils';
import * as docxUtils from '@agent/core/docx-utils';
import { getRegisteredEnvText, parseSafeJsonInput } from '@agent/core/foundation';
import {
  distillPdfDesign,
  extractPptxSlides,
  protocolToMarkdown,
} from '@agent/core/media-contracts';
import { rasterizeVectorImage, VECTOR_IMAGE_EXTENSIONS } from '@agent/core/visual-raster';
import { recognizeDocumentImage } from './media-ocr.js';
import { inferDocumentFormat, ocrPdfDesignImages, readDocument } from '@agent/core/document-reader';
import * as mediaPdfHelpers from './media-pdf-helpers.js';
import { projectXlsxDesign } from './xlsx-extract-projection.js';
import * as path from 'node:path';

import { cloneJsonValue, loadJsonValue } from './media-layout-runtime.js';
import { parseMediaBridgeResponse, parsePdfSplitBridgeResponse } from './media-bridge-response.js';

function assertInProjectRoot(filePath: string, label: string): string {
  const rootDir = pathResolver.rootDir();
  const relative = path.relative(rootDir, filePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label}: path must stay under the Kyberion project root: ${filePath}`);
  }
  return assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
}

function resolvePdfPath(value: any, resolve: Function, label: string): string {
  const rootDir = pathResolver.rootDir();
  const resolved = path.resolve(rootDir, String(resolve(value) || '').trim());
  return assertInProjectRoot(resolved, label);
}

function resolveMediaInputPath(value: any, resolve: Function, label: string): string {
  const rootDir = pathResolver.rootDir();
  const requested = String(resolve(value) || '').trim();
  if (!requested) throw new Error(`${label}: path is required`);
  return assertSafeRepositoryPath(path.resolve(rootDir, requested), {
    allowMissingLeaf: true,
  });
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
    parsed = parseMediaBridgeResponse(
      parseSafeJsonInput(
        String(execResult.stdout || '').trim() || '{}',
        `pdf_${command} bridge response`
      )
    );
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

/** Key joining distilled design slides to extracted slides: the slide part name. */
function pptxSlideKey(slide: any, index: number): string {
  return typeof slide?.id === 'string' && slide.id ? slide.id : `slide${index + 1}.xml`;
}

/**
 * OCR every image on every slide. Vector images (EMF/WMF — pasted Excel
 * ranges, charts) are rasterized through LibreOffice first because OCR
 * engines cannot read them; images that still cannot be read are reported in
 * `ocr_skipped` so a missing figure never reads as a slide without one.
 */
async function collectPptxImageOcr(
  design: any,
  options: DocumentOcrOptions = {}
): Promise<Map<string, any>> {
  const bySlide = new Map<string, any>();
  const slides = Array.isArray(design?.slides) ? design.slides : [];
  for (const [index, slide] of slides.entries()) {
    const imagePaths: string[] = Array.from(
      new Set(
        (Array.isArray(slide?.elements) ? slide.elements : [])
          .filter((element: any) => element?.type === 'image' && element?.imagePath)
          .map((element: any) => String(element.imagePath))
      )
    );
    const results: any[] = [];
    const skipped: Array<{ imagePath: string; reason: string }> = [];
    for (const imagePath of imagePaths) {
      let ocrPath = imagePath;
      if (VECTOR_IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
        const raster = rasterizeVectorImage({
          sourcePath: imagePath,
          outDir: path.join(path.dirname(imagePath), 'rasterized'),
        });
        if (!raster.available || !raster.png_path) {
          skipped.push({ imagePath, reason: raster.unavailable_reason || 'rasterize failed' });
          continue;
        }
        ocrPath = raster.png_path;
      }
      try {
        const result = await recognizeDocumentImage({
          path: ocrPath,
          language: options.language || 'jpn+eng',
          mode: options.mode || 'local_only',
        });
        if (result.text.trim()) {
          results.push({
            provider: result.provider,
            confidence: result.confidence,
            text: result.text.trim(),
            lines: result.lines,
            imagePath,
            ...(ocrPath !== imagePath ? { rasterizedPath: ocrPath } : {}),
          });
        }
      } catch (error: any) {
        skipped.push({ imagePath, reason: String(error?.message || error) });
        logger.warn(
          `[MEDIA_CAPTURE] PPTX image OCR failed on slide ${index + 1}: ${error.message}`
        );
      }
    }
    if (results.length === 0 && skipped.length === 0) continue;
    bySlide.set(pptxSlideKey(slide, index), {
      ...(results.length > 0
        ? {
            ocr_text: Array.from(new Set(results.map((result) => result.text))).join('\n\n'),
            ocr_results: results,
            ocr_provider: results.map((result) => result.provider).join(','),
            ocr_confidence: Math.round(
              results.reduce((sum, result) => sum + Number(result.confidence || 0), 0) /
                results.length
            ),
          }
        : {}),
      ...(skipped.length > 0 ? { ocr_skipped: skipped } : {}),
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
    const ocr = ocrBySlide.get(pptxSlideKey(slide, index));
    if (ocr) slide.ocr = ocr;
  }
  return cloned;
}
/** OCR each PDF page's placed images — delegated to the shared document reader. */
async function augmentPdfDesignWithImageOcr(
  design: any,
  options: DocumentOcrOptions & { min_area_ratio?: number } = {}
): Promise<any> {
  const cloned = cloneJsonValue(design);
  await ocrPdfDesignImages(cloned, {
    ...(options.language ? { ocrLanguage: options.language } : {}),
    ...(options.mode ? { ocrMode: options.mode as any } : {}),
    ...(options.min_area_ratio !== undefined ? { minAreaRatio: options.min_area_ratio } : {}),
  });
  return cloned;
}

function pdfOcrOptions(params: any): (DocumentOcrOptions & { min_area_ratio?: number }) | null {
  if (params.ocr !== true && params.ocr?.enabled !== true) return null;
  return {
    language: params.ocr?.language,
    mode: params.ocr?.mode,
    min_area_ratio: params.ocr?.min_area_ratio,
  };
}

async function opCapture(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = pathResolver.rootDir();
  switch (op) {
    case 'json_read': {
      const sourcePath = resolveMediaInputPath(params.path, resolve, 'json_read');
      const parsed = loadJsonValue(sourcePath);
      return { ...ctx, [params.export_as || 'last_json']: parsed };
    }
    case 'pptx_extract': {
      const sourcePath = resolveMediaInputPath(params.path, resolve, 'pptx_extract');
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
      const sourcePath = resolveMediaInputPath(params.path, resolve, 'pptx_slide_text');
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
        // Join on the slide part name: extracted slides are in presentation
        // order while the distilled design follows file numbering.
        slides = slides.map((slide) => ({
          ...slide,
          ...(ocrBySlide.get(path.posix.basename(slide.entry_name)) || {}),
        }));
      }
      return { ...ctx, [params.export_as || 'last_pptx_slides']: slides };
    }
    case 'xlsx_extract': {
      const xlsxPath = resolveMediaInputPath(params.path, resolve, 'xlsx_extract');
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
      const docxPath = resolveMediaInputPath(params.path, resolve, 'docx_extract');
      // Pictures are written as files (imagePath) unless embed_images asks
      // for a self-contained design with inline base64.
      const docxDesign = await docxUtils.distillDocxDesign(docxPath, {
        embedImages: params.embed_images === true,
        ...(params.image_dir ? { imageDir: String(resolve(params.image_dir)) } : {}),
      });
      return { ...ctx, [params.export_as || 'last_docx_design']: docxDesign };
    }
    case 'pdf_extract': {
      const pdfPath = resolveMediaInputPath(params.path, resolve, 'pdf_extract');
      let pdfDesign = await distillPdfDesign(pdfPath, { aesthetic: params.aesthetic !== false });
      try {
        const extractedText = await mediaPdfHelpers.extractCleanerPdfText(pdfPath);
        pdfDesign = mediaPdfHelpers.mergeCleanerPdfText(pdfDesign, extractedText);
      } catch (error: any) {
        logger.warn(
          `[MEDIA_CAPTURE] pdf_extract cleaner text fallback unavailable: ${error.message}`
        );
      }
      const ocrOptions = pdfOcrOptions(params);
      if (ocrOptions) pdfDesign = await augmentPdfDesignWithImageOcr(pdfDesign, ocrOptions);
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
        parsed = parsePdfSplitBridgeResponse(
          parseSafeJsonInput(
            String(execResult.stdout || '').trim() || '{}',
            'pdf_split bridge response'
          )
        );
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
      const pages = (parsed.pages as string[]).map((page) => pathResolver.toRepoRelative(page));
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
      // Supports: pdf, pptx, xlsx, docx, html/htm, txt/md/markdown (auto-detected from extension).
      // params: { path: string, export_as?: string }
      // If a pre-extracted protocol exists in context via params.from, use that directly.
      const exportKey = params.export_as || 'last_document_digest';
      if (params.from && ctx[params.from]) {
        const md = protocolToMarkdown(ctx[params.from]);
        return { ...ctx, [exportKey]: md };
      }
      const filePath = resolveMediaInputPath(params.path, resolve, 'document_digest');
      const ext = path.extname(filePath).toLowerCase();
      if (ext === '.txt' || ext === '.md') {
        const markdown = safeReadFile(filePath, { encoding: 'utf8' });
        return { ...ctx, [exportKey]: markdown };
      }
      // pdf / pptx / docx / xlsx / html (and .markdown): the shared document
      // reader — the same path as `pnpm kyberion read` and the ingest ceremony.
      const format = inferDocumentFormat(filePath);
      if (!format) throw new Error(`document_digest: unsupported format "${ext}"`);
      const ocr = pdfOcrOptions(params);
      const result = await readDocument(filePath, format, {
        ocr: Boolean(ocr),
        ...(ocr?.language ? { ocrLanguage: ocr.language } : {}),
        ...(ocr?.mode ? { ocrMode: ocr.mode as any } : {}),
      });
      return {
        ...ctx,
        [exportKey]: result.markdown,
        ...(result.warnings.length ? { [`${exportKey}_warnings`]: result.warnings } : {}),
      };
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
