/**
 * PDF Utilities
 * Extracts a PdfDesignProtocol ADF from a .pdf file natively.
 */
import { distillNativePdfDesign } from './native-pdf-engine/parser.js';
import type { PdfDesignProtocol, PdfImageElement, PdfPage } from './types/pdf-protocol.js';

/**
 * Images on a page worth OCR-ing: extracted to disk and covering at least
 * `minAreaRatio` of the page. The default (3%) skips logos and header marks
 * while keeping pasted tables, charts and screenshots — which is where board
 * and report PDFs carry their figures.
 */
export function selectPdfOcrImages(
  page: PdfPage,
  options: { minAreaRatio?: number } = {}
): Array<PdfImageElement & { path: string }> {
  const minAreaRatio = options.minAreaRatio ?? 0.03;
  const pageArea = Math.max(1, page.width * page.height);
  const seen = new Set<string>();
  return (page.images ?? []).filter((image): image is PdfImageElement & { path: string } => {
    if (!image.path || seen.has(image.path)) return false;
    if ((image.width * image.height) / pageArea < minAreaRatio) return false;
    seen.add(image.path);
    return true;
  });
}

/**
 * Extract a PdfDesignProtocol from an existing PDF file.
 * Natively parses binary buffers without external dependencies like pdf-parse.
 */
export async function distillPdfDesign(
  sourcePath: string,
  options: { aesthetic?: boolean } = {}
): Promise<PdfDesignProtocol> {
  // Pass through to the new native parser
  return distillNativePdfDesign(sourcePath);
}
