/**
 * PDF Utilities
 * Extracts a PdfDesignProtocol ADF from a .pdf file natively.
 */
import { distillNativePdfDesign } from './native-pdf-engine/parser.js';
import type { PdfDesignProtocol } from './types/pdf-protocol.js';

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
