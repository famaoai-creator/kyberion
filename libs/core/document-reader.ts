/**
 * The single document reader: pdf / pptx / docx / xlsx / html / markdown /
 * text → Markdown.
 *
 * Every surface that "reads a file" goes through here — `pnpm kyberion read`,
 * `media:document_digest` and the ingest ceremony's `parse_document` — so an
 * agent never has to hand-roll unzip / pdftotext / python scripts, and a
 * document reads the same wherever it is read.
 *
 * Built on the native engines only (native PDF engine, extractPptxSlides,
 * docx-utils, xlsx-utils). OCR is opt-in and local-only: embedded images
 * (pasted tables, charts, slides pasted into Word) are recognized through the
 * governed OCR router, vector images (EMF/WMF) are rasterized via LibreOffice
 * first. Everything this module stages or extracts is removed before it
 * returns — tenant figures never outlive a read in the tmp floor.
 *
 * Prose/web files are read from local bytes only (html via the core
 * htmlToMarkdown converter; markdown / text as-is). URLs are never fetched
 * here — remote content goes through the egress-governed network actuator.
 */
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import { ocrImage } from './ocr-bridge.js';
import type { OcrDataPolicy, OcrDataTier, OcrRoutingMode } from './ocr-types.js';
import { rasterizeVectorImage, VECTOR_IMAGE_EXTENSIONS } from './visual-raster.js';
import { extractPptxSlides, type ExtractedSlide } from './src/native-pptx-engine/engine.js';
import { distillPdfDesign, selectPdfOcrImages } from './src/pdf-utils.js';
import { distillDocxDesign } from './src/docx-utils.js';
import { distillXlsxDesign } from './src/xlsx-utils.js';
import {
  DOCX_IMAGE_MARKER,
  docxToMarkdown,
  pdfToMarkdown,
  xlsxToMarkdown,
} from './src/protocol-to-markdown.js';
import type { PdfDesignProtocol } from './src/types/pdf-protocol.js';
import { extractHtmlTitle, htmlToMarkdown } from './html-to-markdown.js';

export type OfficeDocumentFormat = 'pdf' | 'pptx' | 'docx' | 'xlsx';
export type TextDocumentFormat = 'html' | 'markdown' | 'text';
export type ReadableDocumentFormat = OfficeDocumentFormat | TextDocumentFormat;

/** Binary office/pdf documents only — for callers that must not accept prose files. */
export const OFFICE_DOCUMENT_EXTENSIONS: Readonly<Record<string, OfficeDocumentFormat>> = {
  '.pdf': 'pdf',
  '.pptx': 'pptx',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
};

export const READABLE_DOCUMENT_EXTENSIONS: Readonly<Record<string, ReadableDocumentFormat>> = {
  ...OFFICE_DOCUMENT_EXTENSIONS,
  '.html': 'html',
  '.htm': 'html',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
};

export interface ReadDocumentOptions {
  /** OCR embedded images (slides, pages, pictures). */
  ocr?: boolean;
  ocrLanguage?: string;
  ocrMode?: OcrRoutingMode;
  /** Tier of the source. PII may be retained when the caller declares this. */
  tier?: OcrDataTier;
  /** Owning tenant for tier-aware external egress checks. */
  tenantSlug?: string;
  /** Provider data-use ceiling. Defaults to local_only. */
  trainingUse?: OcrDataPolicy;
  /**
   * Also write every embedded image (slide / page / picture) into this
   * directory inside the repository — EMF/WMF converted to PNG — so a reader
   * can look at figures without extracting the package by hand.
   */
  imagesDir?: string;
}

export interface ReadDocumentImage {
  /** Where the image sits: "slide 8", "page 3", "picture 2". */
  location: string;
  /** Package part or source name, e.g. "ppt/media/image45.emf". */
  source: string;
  /** Written file (repository-absolute). */
  path: string;
}

export interface ReadDocumentTable {
  name: string;
  markdown: string;
}

export interface ReadDocumentResult {
  format: ReadableDocumentFormat;
  markdown: string;
  /** Classification carried with the extracted content for the next storage step. */
  dataTier?: OcrDataTier;
  trainingUse?: OcrDataPolicy;
  title?: string;
  tables: ReadDocumentTable[];
  /** Things the reader could not see (unreadable images, hidden sheets …). */
  warnings: string[];
  /** Images written to `imagesDir` (empty unless requested). */
  images: ReadDocumentImage[];
}

const OCR_NOTE = 'OCR — unverified, check figures against the source';

/** OLE compound-file magic: what Office writes for password-protected files. */
const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** Format from the file extension, or undefined when the reader cannot handle it. */
export function inferDocumentFormat(filePath: string): ReadableDocumentFormat | undefined {
  return READABLE_DOCUMENT_EXTENSIONS[path.extname(filePath).toLowerCase()];
}

/** Password-protected (or legacy binary) Office files cannot be read — fail with an actionable message. */
export function assertReadableOfficeBytes(raw: Buffer, format: string): void {
  if (!['docx', 'xlsx', 'pptx'].includes(format)) return;
  if (raw.subarray(0, 8).equals(CFB_MAGIC)) {
    throw new Error(
      `[document-reader] the ${format} is password-protected (or a legacy binary Office file). ` +
        'Ask the owner for a decrypted copy (Office: File → Info → Protect → remove the password) and read that.'
    );
  }
}

function loadBytes(source: string | Buffer): Buffer {
  if (Buffer.isBuffer(source)) return source;
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(source));
  if (!safeExistsSync(absolute)) throw new Error(`[document-reader] file not found: ${absolute}`);
  if (!safeLstat(absolute).isFile()) {
    throw new Error(`[document-reader] not a regular file: ${absolute}`);
  }
  return safeReadFile(absolute, { encoding: null }) as Buffer;
}

/** Read a pdf / pptx / docx / xlsx / html / markdown / text (path inside the repository, or raw bytes) into Markdown. */
export async function readDocument(
  source: string | Buffer,
  format: ReadableDocumentFormat,
  options: ReadDocumentOptions = {}
): Promise<ReadDocumentResult> {
  const raw = loadBytes(source);
  assertReadableOfficeBytes(raw, format);
  const exporter = options.imagesDir ? new ImageExporter(options.imagesDir) : undefined;
  let result: Omit<ReadDocumentResult, 'images'>;
  switch (format) {
    case 'pptx':
      result = await readPptx(raw, options, exporter);
      break;
    case 'pdf':
      result = await readPdf(raw, options, exporter);
      break;
    case 'docx':
      result = await readDocx(raw, options, exporter);
      break;
    case 'xlsx':
      result = await readXlsx(raw);
      break;
    case 'html':
    case 'markdown':
    case 'text':
      result = readTextDocument(raw, format);
      break;
    default:
      throw new Error(`[document-reader] unsupported format: ${String(format)}`);
  }
  return {
    ...result,
    ...(options.tier ? { dataTier: options.tier } : {}),
    ...(options.trainingUse ? { trainingUse: options.trainingUse } : {}),
    images: exporter?.images ?? [],
  };
}

/** Writes images into the requested directory, converting vector formats. */
class ImageExporter {
  readonly images: ReadDocumentImage[] = [];
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = assertSafeRepositoryPath(pathResolver.rootResolve(dir), { allowMissingLeaf: true });
    safeMkdir(this.dir, { recursive: true });
  }

  write(location: string, source: string, data: Buffer): void {
    const safeLocation = location.replace(/\s+/g, '-');
    const base = path.basename(source).replace(/[^\w.\-]+/g, '_');
    let target = path.join(this.dir, `${safeLocation}-${base}`);
    safeWriteFile(target, data);
    if (VECTOR_IMAGE_EXTENSIONS.has(path.extname(base).toLowerCase())) {
      const raster = rasterizeVectorImage({ sourcePath: target, outDir: this.dir });
      // LibreOffice's throwaway user profile must not land in the reader's folder.
      safeRmSync(path.join(this.dir, 'lo-profile'), { recursive: true, force: true });
      if (raster.available && raster.png_path) {
        safeRmSync(target, { force: true });
        target = raster.png_path;
      }
    }
    this.images.push({ location, source, path: target });
  }
}

// ─── OCR plumbing ──────────────────────────────────────────

interface OcrOutcome {
  text?: string;
  unreadable?: string;
}

/** OCR one staged image file; vector images are rasterized first. */
async function ocrStagedImage(
  imagePath: string,
  workDir: string,
  label: string,
  options: ReadDocumentOptions
): Promise<OcrOutcome> {
  let target = imagePath;
  if (VECTOR_IMAGE_EXTENSIONS.has(path.extname(imagePath).toLowerCase())) {
    const raster = rasterizeVectorImage({ sourcePath: imagePath, outDir: workDir });
    if (!raster.available || !raster.png_path) {
      return { unreadable: `${label} (${raster.unavailable_reason || 'not rasterizable'})` };
    }
    target = raster.png_path;
  }
  try {
    const result = await ocrImage({
      path: target,
      language: options.ocrLanguage || 'jpn+eng',
      mode:
        options.ocrMode ||
        (options.trainingUse && options.trainingUse !== 'local_only' ? 'balanced' : 'local_only'),
      ...(options.tier ? { tier: options.tier } : {}),
      ...(options.tenantSlug ? { tenant_slug: options.tenantSlug } : {}),
      training_use: options.trainingUse || 'local_only',
    });
    return result.text.trim() ? { text: result.text.trim() } : {};
  } catch (error) {
    return { unreadable: `${label} (${(error as Error).message})` };
  }
}

async function withWorkDir<T>(label: string, run: (workDir: string) => Promise<T>): Promise<T> {
  const workDir = pathResolver.sharedTmp(`document-reader/${label}-${randomUUID()}`);
  safeMkdir(workDir, { recursive: true });
  try {
    return await run(workDir);
  } finally {
    safeRmSync(workDir, { recursive: true, force: true });
  }
}

function ocrBlock(heading: string, texts: string[]): string {
  return [heading, ['```text', ...texts, '```'].join('\n')].join('\n\n');
}

function markdownTable(rows: string[][]): string {
  const width = Math.max(...rows.map((row) => row.length));
  const cell = (value: string | undefined) =>
    String(value ?? '')
      .replace(/\n/g, ' / ')
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|');
  const line = (row: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(' | ')} |`;
  return [
    line(rows[0]),
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...rows.slice(1).map(line),
  ].join('\n');
}

// ─── PPTX ──────────────────────────────────────────────────

async function ocrPptxSlideImages(
  raw: Buffer,
  slides: ExtractedSlide[],
  options: ReadDocumentOptions
): Promise<Map<string, { text: string[]; unreadable: string[] }>> {
  const zip = new AdmZip(raw);
  const byEntry = new Map<string, { text: string[]; unreadable: string[] }>();
  await withWorkDir('pptx-ocr', async (workDir) => {
    const cache = new Map<string, OcrOutcome>();
    for (const slide of slides) {
      const found = { text: [] as string[], unreadable: [] as string[] };
      for (const part of slide.image_parts) {
        if (!cache.has(part)) {
          const label = path.posix.basename(part);
          const data = zip.getEntry(part)?.getData();
          if (!data) {
            cache.set(part, { unreadable: `${label} (missing from package)` });
          } else {
            const imagePath = path.join(workDir, `${cache.size}-${label}`);
            safeWriteFile(imagePath, data);
            cache.set(part, await ocrStagedImage(imagePath, workDir, label, options));
          }
        }
        const outcome = cache.get(part)!;
        if (outcome.text) found.text.push(outcome.text);
        if (outcome.unreadable) found.unreadable.push(outcome.unreadable);
      }
      byEntry.set(slide.entry_name, found);
    }
  });
  return byEntry;
}

async function readPptx(
  raw: Buffer,
  options: ReadDocumentOptions,
  exporter?: ImageExporter
): Promise<Omit<ReadDocumentResult, 'images'>> {
  const slides = extractPptxSlides(raw);
  if (exporter) {
    const zip = new AdmZip(raw);
    for (const slide of slides) {
      for (const part of slide.image_parts) {
        const data = zip.getEntry(part)?.getData();
        if (data) exporter.write(`slide ${slide.position}`, part, data);
      }
    }
  }
  const imageText = options.ocr ? await ocrPptxSlideImages(raw, slides, options) : undefined;
  const tables: ReadDocumentTable[] = [];
  const warnings: string[] = [];
  const chunks: string[] = [];
  for (const slide of slides) {
    const heading = slide.shapes_text[0]?.split('\n')[0]?.trim();
    const lines = [
      `## Slide ${slide.position}${heading ? `: ${heading}` : ''}${slide.hidden ? ' (hidden)' : ''}`,
    ];
    if (slide.shapes_text.length > 0) lines.push(slide.shapes_text.join('\n\n'));
    slide.tables.forEach((rows, index) => {
      const markdown = markdownTable(rows);
      tables.push({ name: `slide ${slide.position} table ${index + 1}`, markdown });
      lines.push(markdown);
    });
    const images = imageText?.get(slide.entry_name);
    if (images && images.text.length > 0) {
      lines.push(ocrBlock(`### Image text (${OCR_NOTE})`, images.text));
    }
    if (images && images.unreadable.length > 0) {
      lines.push(`_Unreadable images: ${images.unreadable.join('; ')}_`);
      warnings.push(`slide ${slide.position}: unreadable images ${images.unreadable.join('; ')}`);
    }
    if (!imageText && slide.image_parts.length > 0) {
      lines.push(`_${slide.image_parts.length} image(s) not OCR'd_`);
    }
    if (slide.notes_text) {
      lines.push('### Speaker notes', slide.notes_text.replace(/^/gm, '> '));
    }
    chunks.push(lines.join('\n\n'));
  }
  if (!options.ocr && slides.some((slide) => slide.image_parts.length > 0)) {
    warnings.push('slide images were not OCR’d — pass ocr to read text inside them');
  }
  const title = slides[0]?.shapes_text[0]?.split('\n')[0]?.trim() || undefined;
  return {
    format: 'pptx',
    markdown: chunks.join('\n\n'),
    tables,
    warnings,
    ...(title ? { title } : {}),
  };
}

// ─── PDF ───────────────────────────────────────────────────

/** Placeholder metadata the native parser fills in when a PDF has none. */
const PDF_PLACEHOLDER_TITLES = new Set(['PDF Specification', '']);

async function pdfParsePageTexts(raw: Buffer): Promise<string[] | null> {
  try {
    const { PDFParse } = (await import('pdf-parse')) as any;
    const parser = new PDFParse({ data: new Uint8Array(raw) });
    try {
      const result = await parser.getText();
      return Array.isArray(result.pages)
        ? result.pages.map((page: { text?: string }) => String(page.text ?? '').trim())
        : null;
    } finally {
      await parser.destroy();
    }
  } catch {
    return null; // pdf-parse unavailable or failed — the native text stands.
  }
}

/**
 * OCR each page's placed images (≥3% of the page) into `page.imageOcr`.
 * Shared with media:pdf_extract so both surfaces OCR PDFs the same way.
 */
export async function ocrPdfDesignImages(
  design: PdfDesignProtocol,
  options: ReadDocumentOptions & { minAreaRatio?: number } = {}
): Promise<void> {
  for (const page of design.content?.pages ?? []) {
    const imageOcr: NonNullable<typeof page.imageOcr> = [];
    const skipped: NonNullable<typeof page.imageOcrSkipped> = [];
    for (const image of selectPdfOcrImages(page, { minAreaRatio: options.minAreaRatio })) {
      try {
        const result = await ocrImage({
          path: image.path,
          language: options.ocrLanguage || 'jpn+eng',
          mode:
            options.ocrMode ||
            (options.trainingUse && options.trainingUse !== 'local_only'
              ? 'balanced'
              : 'local_only'),
          ...(options.tier ? { tier: options.tier } : {}),
          ...(options.tenantSlug ? { tenant_slug: options.tenantSlug } : {}),
          training_use: options.trainingUse || 'local_only',
        });
        if (result.text.trim()) {
          imageOcr.push({
            imagePath: image.path,
            text: result.text.trim(),
            confidence: result.confidence,
            provider: result.provider,
          });
        }
      } catch (error) {
        skipped.push({ imagePath: image.path, reason: (error as Error).message });
      }
    }
    if (imageOcr.length) page.imageOcr = imageOcr;
    if (skipped.length) page.imageOcrSkipped = skipped;
  }
}

async function readPdf(
  raw: Buffer,
  options: ReadDocumentOptions,
  exporter?: ImageExporter
): Promise<Omit<ReadDocumentResult, 'images'>> {
  return withWorkDir('pdf', async (workDir) => {
    const pdfPath = path.join(workDir, 'source.pdf');
    safeWriteFile(pdfPath, raw);
    const design = await distillPdfDesign(pdfPath);
    const imageDirs = new Set<string>();
    for (const page of design.content?.pages ?? []) {
      for (const image of page.images ?? [])
        if (image.path) imageDirs.add(path.dirname(image.path));
    }
    try {
      // pdf-parse reconstructs reading order better than the positioned-glyph
      // text; keep the native layout/images and swap in its per-page text.
      const cleaner = await pdfParsePageTexts(raw);
      const pages = design.content?.pages ?? [];
      if (cleaner && cleaner.length === pages.length) {
        pages.forEach((page, index) => {
          if (cleaner[index]) page.text = cleaner[index];
        });
      }
      if (options.ocr) await ocrPdfDesignImages(design, options);
      if (exporter) {
        for (const page of pages) {
          for (const image of page.images ?? []) {
            if (image.path && safeExistsSync(image.path)) {
              exporter.write(
                `page ${page.pageNumber}`,
                path.basename(image.path),
                safeReadFile(image.path, { encoding: null }) as Buffer
              );
            }
          }
        }
      }
      const rawTitle = String(design.metadata?.title ?? '').trim();
      const title = PDF_PLACEHOLDER_TITLES.has(rawTitle) ? undefined : rawTitle;
      // Author / creator are personal names more often than not — the reader
      // does not surface them.
      const body = pdfToMarkdown({ ...design, metadata: undefined } as PdfDesignProtocol);
      const warnings: string[] = [];
      const skipped = pages.reduce((sum, page) => sum + (page.imageOcrSkipped?.length ?? 0), 0);
      if (skipped) warnings.push(`${skipped} page image(s) could not be OCR’d`);
      if (!options.ocr && pages.some((page) => selectPdfOcrImages(page).length > 0)) {
        warnings.push('page images were not OCR’d — pass ocr to read text inside them');
      }
      return {
        format: 'pdf' as const,
        markdown: title ? `# ${title}\n\n${body}` : body,
        tables: [],
        warnings,
        ...(title ? { title } : {}),
      };
    } finally {
      for (const dir of imageDirs) safeRmSync(dir, { recursive: true, force: true });
    }
  });
}

// ─── DOCX ──────────────────────────────────────────────────

function docxDrawingImages(design: any): Map<string, { data: string; extension: string }> {
  const targets = new Map<string, string>(
    (design?.relationships ?? []).map((rel: any) => [String(rel.id), String(rel.target)])
  );
  const images = new Map<string, { data: string; extension: string }>();
  const walk = (node: any): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'drawing' && node.drawing?.imageData) {
      const target = targets.get(node.drawing.imageRId) || node.drawing.name || 'embedded';
      if (!images.has(target)) {
        images.set(target, {
          data: node.drawing.imageData,
          extension: path.extname(target).toLowerCase() || '.png',
        });
      }
    }
    Object.values(node).forEach(walk);
  };
  walk(design?.body);
  return images;
}

async function readDocx(
  raw: Buffer,
  options: ReadDocumentOptions,
  exporter?: ImageExporter
): Promise<Omit<ReadDocumentResult, 'images'>> {
  // Pictures stay in memory: the markdown only carries markers.
  const design = await distillDocxDesign(raw, { embedImages: true });
  let markdown = docxToMarkdown(design);
  const images = docxDrawingImages(design);
  const warnings: string[] = [];
  if (exporter) {
    let index = 0;
    for (const [target, image] of images) {
      index += 1;
      exporter.write(`picture ${index}`, target, Buffer.from(image.data, 'base64'));
    }
  }
  if (options.ocr && images.size > 0) {
    const ocrText = new Map<string, string>();
    await withWorkDir('docx-ocr', async (workDir) => {
      let counter = 0;
      for (const [target, image] of images) {
        counter += 1;
        const imagePath = path.join(workDir, `image-${counter}${image.extension}`);
        safeWriteFile(imagePath, Buffer.from(image.data, 'base64'));
        const outcome = await ocrStagedImage(imagePath, workDir, target, options);
        if (outcome.text) ocrText.set(target, outcome.text);
        if (outcome.unreadable) warnings.push(`unreadable image ${outcome.unreadable}`);
      }
    });
    markdown = markdown.replace(DOCX_IMAGE_MARKER, (marker, target: string) => {
      const text = ocrText.get(target);
      return text ? ocrBlock(`_[image: ${target}] text (${OCR_NOTE}):_`, [text]) : marker;
    });
  } else if (images.size > 0) {
    warnings.push(`${images.size} picture(s) not OCR’d — pass ocr to read text inside them`);
  }
  const title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim();
  return { format: 'docx', markdown, tables: [], warnings, ...(title ? { title } : {}) };
}

// ─── XLSX ──────────────────────────────────────────────────

async function readXlsx(raw: Buffer): Promise<Omit<ReadDocumentResult, 'images'>> {
  const design = await distillXlsxDesign(raw);
  const tables: ReadDocumentTable[] = [];
  const chunks: string[] = [];
  const hidden: string[] = [];
  for (const sheet of design.sheets) {
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') {
      hidden.push(sheet.name);
      continue;
    }
    const markdown = xlsxToMarkdown({ ...design, sheets: [sheet] }).trim();
    if (!markdown || markdown === '(Empty sheet)') continue;
    tables.push({ name: sheet.name, markdown });
    chunks.push(`## ${sheet.name}\n\n${markdown}`);
  }
  const warnings: string[] = [];
  if (hidden.length) {
    chunks.push(`_Hidden sheets not read: ${hidden.join(', ')}_`);
    warnings.push(`hidden sheets not read: ${hidden.join(', ')}`);
  }
  return { format: 'xlsx', markdown: chunks.join('\n\n'), tables, warnings };
}

// ─── HTML / Markdown / text ────────────────────────────────

function readTextDocument(
  raw: Buffer,
  format: TextDocumentFormat
): Omit<ReadDocumentResult, 'images'> {
  const source = raw
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
  const warnings: string[] = [];
  let markdown: string;
  let title: string | undefined;
  if (format === 'html') {
    const scripts = (source.match(/<script\b/gi) ?? []).length;
    if (scripts)
      warnings.push(`${scripts} <script> block(s) stripped — dynamic content is not rendered`);
    title = extractHtmlTitle(source);
    const body = htmlToMarkdown(source);
    const headingTitle = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    markdown = title && title !== headingTitle ? `# ${title}\n\n${body}` : body;
    title = title ?? headingTitle;
  } else {
    markdown = source;
    if (format === 'markdown') title = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() || undefined;
  }
  if (!markdown.trim()) warnings.push('document body is empty');
  return { format, markdown, tables: [], warnings, ...(title ? { title } : {}) };
}
