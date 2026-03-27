import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import Tesseract from 'tesseract.js';
import { safeWriteFile, safeReadFile } from '@agent/core';
import AdmZip from 'adm-zip';
// @ts-ignore
import * as PDFJS from 'pdfjs-dist/legacy/build/pdf.mjs';
import { distillPdfDesign } from '@agent/core/media-contracts';

/**
 * doc-to-text Reborn (Digital Archaeologist)
 * 3-Layer Extraction Model: Content (Soul), Aesthetic (Mask), Metadata (Context).
 */

export type ExtractionMode = 'content' | 'aesthetic' | 'metadata' | 'all';

export interface ExtractionResult {
  file: string;
  layers: {
    content?: string;      // High-fidelity Markdown/Structure
    aesthetic?: Aesthetic; // Design, Layout, Branding
    metadata?: any;        // Context, Properties
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
export async function extract(filePath: string, mode: ExtractionMode = 'all'): Promise<ExtractionResult> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = safeReadFile(filePath) as Buffer;
  const result: ExtractionResult = {
    file: path.basename(filePath),
    layers: {}
  };

  try {
    if (ext === '.pdf') {
      await processPDF(buffer, mode, result);
    } else if (ext === '.docx') {
      await processDocx(buffer, mode, result);
    } else if (ext === '.xlsx') {
      await processXlsx(buffer, mode, result);
    } else if (ext === '.pptx') {
      await processPptx(buffer, mode, result);
    } else if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
      await processImage(buffer, mode, result);
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
      // Write buffer to temp file for distillPdfDesign (which takes a file path)
      const tmpPath = path.join(os.tmpdir(), `pdf-extract-${Date.now()}.pdf`);
      fs.writeFileSync(tmpPath, buffer);
      const protocol = await distillPdfDesign(tmpPath, { aesthetic: true });
      fs.unlinkSync(tmpPath);

      // Map PdfAesthetic to legacy Aesthetic format
      const aesthetic = protocol.aesthetic;
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

async function processXlsx(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  if (mode === 'content' || mode === 'all') {
    let content = '';
    workbook.SheetNames.forEach(name => {
      content += `### Sheet: ${name}\n\n`;
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
      content += csv + '\n\n';
    });
    result.layers.content = content;
  }
  if (mode === 'metadata' || mode === 'all') {
    result.layers.metadata = { sheets: workbook.SheetNames, props: workbook.Props };
  }
  if (mode === 'aesthetic' || mode === 'all') {
    const tableStyles = new Set<string>();
    try {
      const zip = new AdmZip(buffer);
      const stylesEntry = zip.getEntry('xl/styles.xml');
      if (stylesEntry) {
        const stylesXml = stylesEntry.getData().toString('utf8');
        const defaultTableStyle = stylesXml.match(/defaultTableStyle="([^"]+)"/);
        if (defaultTableStyle) {
          tableStyles.add(defaultTableStyle[1]);
        }
        const customTableStyles = stylesXml.match(/<tableStyle name="([^"]+)"/g);
        if (customTableStyles) {
          customTableStyles.forEach(m => tableStyles.add(m.replace(/<tableStyle name="|"/g, '')));
        }
      }
    } catch (e) {
      // Ignore ZIP parsing errors
    }
    result.layers.aesthetic = { 
      layout: 'grid', 
      branding: { logo_presence: false, tone: 'technical' },
      table_styles: Array.from(tableStyles)
    };
  }
}

async function processPptx(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  try {
    const zip = new AdmZip(buffer);
    
    if (mode === 'content' || mode === 'all') {
      let content = '';
      const slides = zip.getEntries().filter(e => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/));
      for (const slide of slides) {
        const xml = slide.getData().toString('utf8');
        const textMatches = xml.match(/<a:t>([^<]*)<\/a:t>/g);
        if (textMatches) {
          content += textMatches.map(t => t.replace(/<\/?a:t>/g, '')).join(' ') + '\n\n';
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
          styleMatches.forEach(m => tableStyles.add(m.replace(/styleName="|"/g, '')));
        }
      }
      
      const slides = zip.getEntries().filter(e => e.entryName.match(/^ppt\/slides\/slide\d+\.xml$/));
      for (const slide of slides) {
        const xml = slide.getData().toString('utf8');
        const styleIdMatches = xml.match(/<a:tblStyleId>([^<]+)<\/a:tblStyleId>/g);
        if (styleIdMatches) {
          styleIdMatches.forEach(m => tableStyles.add(m.replace(/<\/?a:tblStyleId>/g, '')));
        }
      }

      result.layers.aesthetic = { 
        layout: 'grid',
        table_styles: Array.from(tableStyles),
        branding: { logo_presence: false, tone: 'professional' }
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
    const { data: { text } } = await Tesseract.recognize(buffer, 'eng+jpn');
    result.layers.content = text;
  }
  if (mode === 'aesthetic' || mode === 'all') {
    result.layers.aesthetic = { colors: [], branding: { logo_presence: true } };
  }
}
