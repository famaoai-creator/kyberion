/**
 * Positioned text runs from a rendered PDF — the measurement side of the
 * post-render text-fit check (`pptx_render_check`).
 *
 * LibreOffice writes each rendered line of a text box as one or more text
 * runs on a shared baseline. pdf.js (shipped inside the `pdf-parse`
 * dependency, so no extra binary or package) reports those runs with their
 * transform; this module turns them into runs with an x / baseline in inches
 * from the page's top-left, so they can be compared against the authored
 * boxes of the protocol that produced the deck. Runs are deliberately not
 * merged into lines here: two boxes side by side share a baseline, and only
 * the run boundary tells their text apart.
 */

import type { RenderedTextRun } from './protocol-text-fit.js';

const POINTS_PER_INCH = 72;

export interface PdfJsTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  hasEOL?: boolean;
}

interface PdfJsPage {
  getViewport(options: { scale: number }): { width: number; height: number };
  getTextContent(): Promise<{ items: PdfJsTextItem[] }>;
}

interface PdfJsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfJsPage>;
}

/**
 * pdf-parse keeps its pdf.js document behind a TypeScript-private `load()`.
 * The cast is confined here; a version that drops the method fails with a
 * clear error instead of a silent empty result.
 */
interface PdfParseWithDocument {
  load?: () => Promise<PdfJsDocument>;
  destroy(): Promise<void>;
}

export interface PdfPageSize {
  page: number;
  widthIn: number;
  heightIn: number;
}

export interface PdfTextRunsResult {
  pages: PdfPageSize[];
  runs: RenderedTextRun[];
}

/** Convert pdf.js text items of one page into positioned runs (inches, top-left origin). */
export function pdfTextItemsToRuns(
  items: PdfJsTextItem[],
  page: number,
  pageHeightPt: number
): RenderedTextRun[] {
  const runs: RenderedTextRun[] = [];
  for (const item of items) {
    const t = item.transform;
    const str = (item.str ?? '').trim();
    if (!t || t.length < 6 || !str) continue;
    // Rotated / vertical runs are not part of a horizontal text box check.
    if (Math.abs(t[1]!) > 1e-3 || Math.abs(t[2]!) > 1e-3) continue;
    const size = Math.abs(t[3]!) || Math.abs(t[0]!);
    runs.push({
      page,
      text: str,
      x: t[4]! / POINTS_PER_INCH,
      width: Math.max(0, item.width ?? 0) / POINTS_PER_INCH,
      baseline: (pageHeightPt - t[5]!) / POINTS_PER_INCH,
      fontSizePt: Math.round(size * 100) / 100,
    });
  }
  return runs;
}

/** Read every page's text runs. Throws when the PDF cannot be parsed. */
export async function extractPdfTextRuns(raw: Uint8Array): Promise<PdfTextRunsResult> {
  const mod = (await import('pdf-parse')) as unknown as {
    PDFParse: new (options: { data: Uint8Array }) => PdfParseWithDocument;
  };
  const parser = new mod.PDFParse({ data: new Uint8Array(raw) });
  try {
    if (typeof parser.load !== 'function') {
      throw new Error(
        'pdf-parse no longer exposes its pdf.js document — positioned text runs are unavailable'
      );
    }
    const doc = await parser.load();
    const pages: PdfPageSize[] = [];
    const runs: RenderedTextRun[] = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      pages.push({
        page: pageNumber,
        widthIn: viewport.width / POINTS_PER_INCH,
        heightIn: viewport.height / POINTS_PER_INCH,
      });
      const content = await page.getTextContent();
      runs.push(...pdfTextItemsToRuns(content.items, pageNumber, viewport.height));
    }
    return { pages, runs };
  } finally {
    await parser.destroy();
  }
}
