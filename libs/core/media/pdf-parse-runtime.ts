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

export interface PdfParseInfoPage {
  pageNumber: number;
  width?: number;
  height?: number;
}

export interface PdfParseInfoResult {
  total?: number;
  info?: {
    Title?: unknown;
    EncryptFilterName?: unknown;
    [key: string]: unknown;
  };
  pages?: PdfParseInfoPage[];
}

export interface PdfParseInstance {
  getText(): Promise<PdfParseTextResult>;
  getInfo(params?: { parsePageInfo?: boolean }): Promise<PdfParseInfoResult>;
  getScreenshot(options: {
    partial: number[];
    desiredWidth: number;
  }): Promise<PdfParseScreenshotResult>;
  destroy(): Promise<void>;
}

export type PdfParseErrorConstructor = new (...args: unknown[]) => Error;

export interface PdfParseConstructor {
  new (options: { data: Uint8Array }): PdfParseInstance;
}

export interface PdfParseRuntime {
  PDFParse: PdfParseConstructor;
  PasswordException?: PdfParseErrorConstructor;
}

interface PdfParseModule {
  PDFParse: PdfParseConstructor;
  PasswordException?: PdfParseErrorConstructor;
}

/** Resolve the `pdf-parse` runtime contract without an `as any` at each call site. */
export async function loadPdfParseRuntime(): Promise<PdfParseRuntime> {
  const mod = (await import('pdf-parse')) as unknown as PdfParseModule;
  return {
    PDFParse: mod.PDFParse,
    PasswordException: mod.PasswordException,
  };
}

/** True when `error` signals that the PDF requires a user/open password. */
export function isPdfParsePasswordError(
  error: unknown,
  PasswordExceptionCtor?: PdfParseErrorConstructor
): boolean {
  if (PasswordExceptionCtor && error instanceof PasswordExceptionCtor) return true;
  return error instanceof Error && error.name === 'PasswordException';
}

/** Resolve the `PDFParse` constructor without an `as any` at each call site. */
export async function loadPdfParseConstructor(): Promise<PdfParseConstructor> {
  return (await loadPdfParseRuntime()).PDFParse;
}
