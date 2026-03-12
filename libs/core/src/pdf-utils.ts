/**
 * PDF Utilities
 * Extracts a PdfDesignProtocol ADF from a .pdf file.
 * Follows the same pattern as pptx-utils.ts, xlsx-utils.ts, docx-utils.ts.
 */
import * as fs from 'fs';
import type {
  PdfDesignProtocol,
  PdfPage,
  PdfLayoutElement,
  PdfAesthetic,
} from './types/pdf-protocol.js';

/**
 * Extract a PdfDesignProtocol from an existing PDF file.
 * Uses pdf-parse for text/metadata and pdfjs-dist for layout analysis.
 */
export async function distillPdfDesign(
  sourcePath: string,
  options: { aesthetic?: boolean } = {}
): Promise<PdfDesignProtocol> {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`distillPdfDesign: file not found: ${sourcePath}`);
  }

  const buffer = fs.readFileSync(sourcePath);

  // ── Text + Metadata via pdf-parse ──
  const pdfParse = await importPdfParse();
  const data = await pdfParse(buffer);

  const pages: PdfPage[] = [];
  // pdf-parse gives us concatenated text; split by form feeds for rough page separation
  const pageTexts = data.text.split('\f');
  for (let i = 0; i < (data.numpages || pageTexts.length); i++) {
    pages.push({
      pageNumber: i + 1,
      width: 595,   // Default A4 width in points
      height: 842,  // Default A4 height in points
      text: pageTexts[i]?.trim() || '',
    });
  }

  const protocol: PdfDesignProtocol = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    source: {
      format: 'html',
      body: '', // Not reconstructable from PDF
      title: data.info?.Title || '',
    },
    content: {
      text: data.text,
      pages,
    },
    metadata: {
      title: data.info?.Title,
      author: data.info?.Author,
      subject: data.info?.Subject,
      creator: data.info?.Creator,
      producer: data.info?.Producer,
      creationDate: data.info?.CreationDate,
      modDate: data.info?.ModDate,
      pageCount: data.numpages,
    },
  };

  // ── Aesthetic analysis via pdfjs-dist (optional, heavier) ──
  if (options.aesthetic !== false) {
    try {
      protocol.aesthetic = await extractAesthetic(buffer);
    } catch {
      // pdfjs-dist may not be available; aesthetic is optional
      protocol.aesthetic = { layout: 'unknown' };
    }
  }

  return protocol;
}

/**
 * Detect layout type from extracted layout elements.
 */
function detectLayout(elements: PdfLayoutElement[]): 'single-column' | 'multi-column' | 'grid' {
  const xCoords = elements.map(e => Math.round(e.x / 50) * 50);
  const uniqueX = new Set(xCoords);
  if (uniqueX.size > 5) return 'grid';
  if (uniqueX.size > 2) return 'multi-column';
  return 'single-column';
}

/**
 * Extract aesthetic layer using pdfjs-dist for coordinate-based layout analysis.
 */
async function extractAesthetic(buffer: Buffer): Promise<PdfAesthetic> {
  // Dynamic import — pdfjs-dist is optional
  // @ts-ignore
  const PDFJS = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const uint8Array = new Uint8Array(buffer);
  const loadingTask = PDFJS.getDocument({ data: uint8Array, useSystemFonts: true });
  const pdfDoc = await loadingTask.promise;

  const elements: PdfLayoutElement[] = [];
  const fonts = new Set<string>();

  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const page = await pdfDoc.getPage(i);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });

    textContent.items.forEach((item: Record<string, unknown>) => {
      const str = item.str as string;
      const transform = item.transform as number[];
      const width = item.width as number;
      const height = item.height as number;
      const fontName = item.fontName as string;

      const x = transform[4];
      const y = viewport.height - transform[5]; // Flip Y for standard coordinates

      elements.push({
        type: 'text',
        x, y, width, height,
        text: str,
        fontName,
        fontSize: transform[0], // Approximation: scaleX ≈ font size
      });
      if (fontName) fonts.add(fontName);
    });
  }

  const layoutType = elements.length > 0 ? detectLayout(elements) : 'unknown';

  return {
    fonts: Array.from(fonts),
    layout: layoutType,
    elements,
    branding: {
      logoPresence: buffer.toString('utf8').includes('/Image'),
    },
  };
}

/**
 * Dynamic import helper for pdf-parse (handles ESM/CJS interop).
 */
async function importPdfParse(): Promise<(buffer: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, string> }>> {
  const mod = await import('pdf-parse') as any;
  const fn = typeof mod === 'function' ? mod : (mod.default || mod);
  return fn as (buffer: Buffer) => Promise<{ text: string; numpages: number; info: Record<string, string> }>;
}
