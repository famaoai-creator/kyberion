import * as path from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import Tesseract from 'tesseract.js';
import { safeWriteFile, safeReadFile, safeUnlink, pathResolver } from '@agent/core';
// @ts-ignore
import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.mjs';
import { distillPdfDesign } from '@agent/core/media-contracts';
import { processXlsx } from './xlsx-extraction.js';
import { processPptx } from './pptx-extraction.js';

/**
 * doc-to-text Reborn (Digital Archaeologist)
 * 3-Layer Extraction Model: Content (Soul), Aesthetic (Mask), Metadata (Context).
 */

export type ExtractionMode = 'content' | 'aesthetic' | 'metadata' | 'raw' | 'all';

export interface ExtractionOptions {
  preserveRaw?: boolean;
}

export interface ExtractionResult {
  file: string;
  layers: {
    content?: string;      // High-fidelity Markdown/Structure
    aesthetic?: Aesthetic; // Design, Layout, Branding
    metadata?: any;        // Context, Properties
    raw?: any;             // Lossless protocol / raw passthrough layer
  };
}

export interface Aesthetic {
  colors?: string[];
  fonts?: string[];
  layout?: 'single-column' | 'multi-column' | 'grid' | 'unknown';
  elements?: LayoutElement[];
  branding?: Branding;
  table_styles?: string[]; // ECMA-376 Standard Table Styles
}

export interface Branding {
  logo_presence: boolean;
  primary_color?: string;
  tone?: 'professional' | 'creative' | 'technical' | 'casual';
}

export interface LayoutElement {
  type: 'text' | 'image' | 'table' | 'heading';
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  font_size?: number;
  font_name?: string;
  style?: any;
}

/**
 * Universal document extraction core.
 */
export async function extract(
  filePath: string,
  mode: ExtractionMode = 'all',
  options: ExtractionOptions = {},
): Promise<ExtractionResult> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = safeReadFile(filePath) as Buffer;
  const wantsRaw = mode === 'raw' || options.preserveRaw === true;
  const normalizedMode: ExtractionMode = mode === 'raw' ? 'all' : mode;
  const result: ExtractionResult = {
    file: path.basename(filePath),
    layers: {}
  };

  try {
    if (ext === '.pdf') {
      await processPDF(buffer, normalizedMode, result);
    } else if (ext === '.docx') {
      await processDocx(buffer, normalizedMode, result);
    } else if (ext === '.xlsx') {
      await processXlsx(filePath, normalizedMode, result, { preserveRaw: wantsRaw });
    } else if (ext === '.pptx') {
      await processPptx(filePath, normalizedMode, result, { preserveRaw: wantsRaw });
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      await processImage(buffer, normalizedMode, result);
    } else if (['.txt', '.md'].includes(ext)) {
      result.layers.content = buffer.toString('utf8');
      result.layers.metadata = { size: buffer.length };
    } else {
      throw new Error(`Unsupported file format: ${ext}`);
    }

    return result;
  } catch (err: any) {
    throw new Error(`Extraction failed for ${path.basename(filePath)}: ${err.message}`);
  }
}

async function processPDF(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  // Delegate to shared pdf-utils for content/metadata extraction
  if (mode === 'content' || mode === 'metadata' || mode === 'all') {
    const parser = new PDFParse({ data: buffer });
    try {
      const data = await parser.getText();
      if (mode === 'content' || mode === 'all') result.layers.content = data.text;
      if (mode === 'metadata' || mode === 'all') {
        result.layers.metadata = {
          total: data.total,
          pages: Array.isArray(data.pages) ? data.pages.length : undefined,
        };
      }
    } finally {
      await parser.destroy();
    }
  }

  // Aesthetic uses shared pdf-utils layout analysis (via pdfjs-dist)
  if (mode === 'aesthetic' || mode === 'all') {
    try {
      // Use a governed temp path so extraction stays within Kyberion's write policy.
      const tmpPath = pathResolver.sharedTmp(`actuators/media-actuator/pdf-extract-${Date.now()}.pdf`);
      let protocol;
      try {
        safeWriteFile(tmpPath, buffer);
        protocol = await distillPdfDesign(tmpPath, { aesthetic: true });
      } finally {
        try {
          safeUnlink(tmpPath);
        } catch {
          // Extraction cleanup should not shadow the primary extraction result.
        }
      }

      // Map PdfAesthetic to legacy Aesthetic format
      const aesthetic = protocol?.aesthetic;
      result.layers.aesthetic = {
        fonts: aesthetic?.fonts,
        layout: aesthetic?.layout || 'unknown',
        elements: aesthetic?.elements?.map(e => ({
          type: e.type,
          x: e.x, y: e.y,
          width: e.width, height: e.height,
          text: e.text,
          font_name: e.fontName,
          font_size: e.fontSize,
        })),
        branding: {
          logo_presence: aesthetic?.branding?.logoPresence || false,
          tone: result.layers.content?.includes('Agreement') ? 'professional' : 'technical',
        },
      };
    } catch {
      result.layers.aesthetic = { layout: 'unknown', branding: { logo_presence: false } };
    }
  }
}

async function processDocx(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  if (mode === 'content' || mode === 'all') {
    try {
      // @ts-ignore
      const data = await mammoth.convertToMarkdown({ buffer });
      result.layers.content = data.value;
    } catch (_) {
      const data = await mammoth.extractRawText({ buffer });
      result.layers.content = data.value;
    }
  }
  if (mode === 'metadata' || mode === 'all') {
    result.layers.metadata = { type: 'Word Document', extension: 'docx' };
  }
  if (mode === 'aesthetic' || mode === 'all') {
    result.layers.aesthetic = {
      layout: 'single-column',
      branding: { logo_presence: false }
    };
  }
}

async function processImage(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  if (mode === 'content' || mode === 'all') {
    const { data: { text } } = await Tesseract.recognize(buffer, 'eng+jpn');
    result.layers.content = text;
  }
  if (mode === 'aesthetic' || mode === 'all') {
    result.layers.aesthetic = { colors: [], branding: { logo_presence: true } };
  }
}
