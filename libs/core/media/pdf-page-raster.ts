/**
 * Render PDF pages to PNG without any external binary (no pdftoppm / soffice).
 *
 * `pdf-parse` (already a dependency for text ordering) ships pdf.js and
 * @napi-rs/canvas, so `getScreenshot()` works wherever `pnpm install` ran —
 * the same way on a developer laptop and in the managed runtime image.
 *
 * Used by the document reader for pages whose text layer cannot be trusted
 * (broken font mapping, vector-only drawings): those pages are drawn as they
 * look, so OCR and `kyberion see` can read what the text layer cannot.
 */
import type { PdfPage } from '../contracts/pdf-protocol.js';
import { loadPdfParseConstructor } from './pdf-parse-runtime.js';

/** Control characters and replacement glyphs that a healthy text layer never carries. */
// eslint-disable-next-line no-control-regex
const BROKEN_GLYPH = /[\u0000-\u0008\u000e-\u001f�-]/g;
const BROKEN_GLYPH_RATIO = 0.1;
const MIN_SAMPLE_CHARS = 8;

/** True when the text is mostly unmapped glyphs (e.g. a font with no usable ToUnicode map). */
export function isBrokenText(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < MIN_SAMPLE_CHARS) return false;
  const broken = compact.match(BROKEN_GLYPH)?.length ?? 0;
  return broken / compact.length >= BROKEN_GLYPH_RATIO;
}

/**
 * A page needs to be rendered when its text layer is broken, or when it carries
 * no text and no placed image yet draws vector shapes (a diagram): neither the
 * text extractor nor the embedded-image OCR can see anything on it.
 */
export function pageNeedsRender(page: PdfPage, hasPlacedImages: boolean): boolean {
  if (isBrokenText(page.text)) return true;
  const hasText = page.text.trim().length > 0 || pageElementText(page).trim().length > 0;
  return !hasText && !hasPlacedImages && (page.vectors?.length ?? 0) > 0;
}

function pageElementText(page: PdfPage): string {
  return (page.elements ?? [])
    .map((element) => (element.type === 'text' ? (element.text ?? '') : ''))
    .join('');
}

/**
 * Drop positioned text elements whose glyphs are unmapped, so the table detector
 * cannot turn them into a table of garbage. Returns true when it removed any.
 */
export function dropBrokenTextElements(page: PdfPage): boolean {
  if (!isBrokenText(pageElementText(page))) return false;
  page.elements = (page.elements ?? []).filter((element) => element.type !== 'text');
  return true;
}

export interface RenderedPdfPage {
  pageNumber: number;
  png: Buffer;
}

export interface RenderPdfPagesOptions {
  /** Output width in pixels. Wide enough to read small print, small enough to stay cheap. */
  desiredWidth?: number;
}

export const DEFAULT_RENDER_WIDTH = 1400;

/** Draw the requested 1-based pages as PNG. Throws when pdf-parse cannot render. */
export async function renderPdfPages(
  raw: Buffer,
  pageNumbers: number[],
  options: RenderPdfPagesOptions = {}
): Promise<RenderedPdfPage[]> {
  if (pageNumbers.length === 0) return [];
  const PDFParse = await loadPdfParseConstructor();
  const parser = new PDFParse({ data: new Uint8Array(raw) });
  try {
    const result = await parser.getScreenshot({
      partial: pageNumbers,
      desiredWidth: options.desiredWidth ?? DEFAULT_RENDER_WIDTH,
    });
    return result.pages.map((page) => ({
      pageNumber: page.pageNumber,
      png: Buffer.from(page.data),
    }));
  } finally {
    await parser.destroy();
  }
}
