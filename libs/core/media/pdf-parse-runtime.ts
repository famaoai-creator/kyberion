/**
 * Typed loader for the `pdf-parse` package.
 *
 * Upstream ships a constructor (`PDFParse`) that the published `@types/pdf-parse`
 * does not describe, so call sites previously cast `as any`. Centralizing the
 * cast here as `unknown →` a local contract keeps the type-ratchet from growing
 * and gives document-reader / page-raster one shared surface.
 */

export interface PdfParseTextPage {
  text?: string;
}

export interface PdfParseTextResult {
  pages?: PdfParseTextPage[];
}

export interface PdfParseScreenshotPage {
  pageNumber: number;
  data: Uint8Array;
}

export interface PdfParseScreenshotResult {
  pages: PdfParseScreenshotPage[];
}

export interface PdfParseInstance {
  getText(): Promise<PdfParseTextResult>;
  getScreenshot(options: {
    partial: number[];
    desiredWidth: number;
  }): Promise<PdfParseScreenshotResult>;
  destroy(): Promise<void>;
}

export interface PdfParseConstructor {
  new (options: { data: Uint8Array }): PdfParseInstance;
}

interface PdfParseModule {
  PDFParse: PdfParseConstructor;
}

/** Resolve the `PDFParse` constructor without an `as any` at each call site. */
export async function loadPdfParseConstructor(): Promise<PdfParseConstructor> {
  const mod = (await import('pdf-parse')) as unknown as PdfParseModule;
  return mod.PDFParse;
}
