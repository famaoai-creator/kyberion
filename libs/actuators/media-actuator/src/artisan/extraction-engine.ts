import * as path from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import Tesseract from 'tesseract.js';
import { safeWriteFile, safeReadFile, safeUnlink, pathResolver } from '@agent/core';
import AdmZip from 'adm-zip';
import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.mjs';
import { distillPdfDesign, distillPptxDesign } from '@agent/core/media-contracts';
import { distillExcelDesign } from '@agent/shared-media';

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
    content?: string; // High-fidelity Markdown/Structure
    aesthetic?: Aesthetic; // Design, Layout, Branding
    metadata?: any; // Context, Properties
    raw?: any; // Lossless protocol / raw passthrough layer
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
  options: ExtractionOptions = {}
): Promise<ExtractionResult> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = safeReadFile(filePath) as Buffer;
  const wantsRaw = mode === 'raw' || options.preserveRaw === true;
  const normalizedMode: ExtractionMode = mode === 'raw' ? 'all' : mode;
  const result: ExtractionResult = {
    file: path.basename(filePath),
    layers: {},
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
      const tmpPath = pathResolver.sharedTmp(
        `actuators/media-actuator/pdf-extract-${Date.now()}.pdf`
      );
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
        elements: aesthetic?.elements?.map((e) => ({
          type: e.type,
          x: e.x,
          y: e.y,
          width: e.width,
          height: e.height,
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

// mammoth's bundled .d.ts predates its own convertToMarkdown export (present in
// lib/index.js since 1.x) — augment locally instead of losing type coverage on
// the whole module.
type MammothWithMarkdown = typeof mammoth & {
  convertToMarkdown: (input: { buffer: Buffer }) => Promise<{ value: string; messages: unknown[] }>;
};

async function processDocx(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  if (mode === 'content' || mode === 'all') {
    try {
      const data = await (mammoth as MammothWithMarkdown).convertToMarkdown({ buffer });
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
      branding: { logo_presence: false },
    };
  }
}

async function processXlsx(
  filePath: string,
  mode: ExtractionMode,
  result: ExtractionResult,
  opts: { preserveRaw?: boolean } = {}
) {
  const protocol = await distillExcelDesign(filePath);

  if (opts.preserveRaw) {
    result.layers.raw = protocol;
  }

  if (mode === 'content' || mode === 'all') {
    let content = '';
    for (const sheet of protocol.sheets) {
      content += `### Sheet: ${sheet.name}\n\n`;
      const maxRow = sheet.rows.reduce((max, row) => Math.max(max, row.number), 0);
      const maxCol = sheet.columns.reduce((max, col) => Math.max(max, col.index), 0);
      for (let rowNum = 1; rowNum <= maxRow; rowNum++) {
        const row = sheet.rows.find((r) => r.number === rowNum);
        const values: string[] = [];
        for (let col = 1; col <= maxCol; col++) {
          const cell = row?.cells?.[col];
          const raw = cell?.value;
          const text = raw === undefined || raw === null ? '' : String(raw);
          values.push(text.includes(',') ? JSON.stringify(text) : text);
        }
        content += values.join(',') + '\n';
      }
      content += '\n';
    }
    result.layers.content = content.trimEnd();
  }

  if (mode === 'metadata' || mode === 'all') {
    result.layers.metadata = {
      sheets: protocol.sheets.map((sheet) => ({
        name: sheet.name,
        rows: sheet.rows.length,
        columns: sheet.columns.length,
        merges: sheet.merges.length,
      })),
      theme: protocol.theme,
      generatedAt: protocol.generatedAt,
    };
  }

  if (mode === 'aesthetic' || mode === 'all') {
    result.layers.aesthetic = {
      layout: 'grid',
      branding: { logo_presence: false, tone: 'technical' },
      table_styles: protocol.sheets.flatMap((sheet) => sheet.merges.map(() => 'merge')),
      colors: Object.values(protocol.theme),
    };
  }
}

async function processPptx(
  filePath: string,
  mode: ExtractionMode,
  result: ExtractionResult,
  opts: { preserveRaw?: boolean } = {}
) {
  try {
    const buffer = safeReadFile(filePath, { encoding: null }) as Buffer;
    const zip = new AdmZip(buffer);

    if (opts.preserveRaw) {
      result.layers.raw = await distillPptxDesign(filePath);
    }

    if (mode === 'content' || mode === 'all') {
      let content = '';
      const slides = zip
        .getEntries()
        .filter((e) => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/));
      for (const slide of slides) {
        const xml = slide.getData().toString('utf8');
        const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g);
        if (textMatches) {
          content += textMatches.map((t) => t.replace(/<\/?a:t>/g, '')).join(' ') + '\n\n';
        }
      }
      result.layers.content = content.trim() || 'No text content found in PowerPoint.';
    }

    if (mode === 'metadata' || mode === 'all') {
      const presEntry = zip.getEntry('ppt/presentation.xml');
      let slideCount = 0;
      if (presEntry) {
        const presXml = presEntry.getData().toString('utf8');
        const sldIdLst = presXml.match(/<p:sldId /g);
        slideCount = sldIdLst ? sldIdLst.length : 0;
      }
      result.layers.metadata = { type: 'PowerPoint', slides: slideCount };
    }

    if (mode === 'aesthetic' || mode === 'all') {
      const tableStyles = new Set<string>();

      const tableStylesEntry = zip.getEntry('ppt/tableStyles.xml');
      if (tableStylesEntry) {
        const tsXml = tableStylesEntry.getData().toString('utf8');
        const styleMatches = tsXml.match(/styleName="([^"]+)"/g);
        if (styleMatches) {
          styleMatches.forEach((m) => tableStyles.add(m.replace(/styleName="|"/g, '')));
        }
      }

      const slides = zip
        .getEntries()
        .filter((e) => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/));
      for (const slide of slides) {
        const xml = slide.getData().toString('utf8');
        const styleIdMatches = xml.match(/<a:tblStyleId>([^<]+)<\/a:tblStyleId>/g);
        if (styleIdMatches) {
          styleIdMatches.forEach((m) => tableStyles.add(m.replace(/<\/?a:tblStyleId>/g, '')));
        }
      }

      result.layers.aesthetic = {
        layout: 'grid',
        table_styles: Array.from(tableStyles),
        branding: { logo_presence: false, tone: 'professional' },
      };
    }
  } catch (e: any) {
    result.layers.content = 'PowerPoint content extraction failed: ' + e.message;
    result.layers.metadata = { type: 'PowerPoint' };
    result.layers.aesthetic = { layout: 'unknown' };
  }
}
async function processImage(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  if (mode === 'content' || mode === 'all') {
    const {
      data: { text },
    } = await Tesseract.recognize(buffer, 'eng+jpn');
    result.layers.content = text;
  }
  if (mode === 'aesthetic' || mode === 'all') {
    result.layers.aesthetic = { colors: [], branding: { logo_presence: true } };
  }
}
