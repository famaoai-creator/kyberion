/**
 * PDF Design Protocol (ADF)
 * A structured representation of PDF content, following the PPTX/XLSX/DOCX protocol pattern.
 *
 * PDFs differ from Office formats: they are final-form (no editable structure).
 * This protocol captures content + layout for round-trip extraction → composition.
 * Generation uses HTML/Markdown → Puppeteer pipeline (not raw PDF binary).
 */

// ─── Layout Element (from pdfjs-dist extraction) ──────────

export interface PdfLayoutElement {
  type: 'text' | 'image' | 'table' | 'heading';
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  fontSize?: number;
  fontName?: string;
}

// ─── Aesthetic Layer ──────────────────────────────────────

export interface PdfAesthetic {
  colors?: string[];
  fonts?: string[];
  layout?: 'single-column' | 'multi-column' | 'grid' | 'unknown';
  elements?: PdfLayoutElement[];
  branding?: {
    logoPresence: boolean;
    primaryColor?: string;
    tone?: 'professional' | 'creative' | 'technical' | 'casual';
  };
}

// ─── Page ─────────────────────────────────────────────────

export interface PdfPage {
  pageNumber: number;
  width: number;          // Points (1pt = 1/72 inch)
  height: number;
  text: string;
  elements?: PdfLayoutElement[];
}

// ─── PDF Composition Options ───────────────────────────────

export interface PdfCompositionOptions {
  outputPath: string;
  format?: 'A4' | 'A3' | 'Letter' | 'Legal';
  margin?: {
    top: string;
    bottom: string;
    left: string;
    right: string;
  };
  headerHtml?: string;
  footerHtml?: string;
  printBackground?: boolean;
  landscape?: boolean;
  theme?: {
    title?: string;
    body?: string;    // CSS string
  };
}

// ─── Root Protocol ────────────────────────────────────────

export interface PdfDesignProtocol {
  version: string;
  generatedAt: string;

  /** Source content for PDF generation */
  source: {
    format: 'markdown' | 'html';
    body: string;
    title?: string;
  };

  /** Extracted content (populated by distillPdfDesign) */
  content?: {
    text: string;
    pages: PdfPage[];
  };

  /** Document metadata (from pdf-parse info dict) */
  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    producer?: string;
    creationDate?: string;
    modDate?: string;
    pageCount?: number;
    [key: string]: string | number | undefined;
  };

  /** Visual analysis (from pdfjs-dist) */
  aesthetic?: PdfAesthetic;

  /** Composition options for generation */
  compositionOptions?: PdfCompositionOptions;
}
