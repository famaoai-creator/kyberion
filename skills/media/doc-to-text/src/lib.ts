import * as fs from 'node:fs';
import * as path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import Tesseract from 'tesseract.js';
import { safeWriteFile } from '@agent/core';

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
}

export interface Branding {
  logo_presence: boolean;
  primary_color?: string;
  tone?: 'professional' | 'creative' | 'technical' | 'casual';
}

export interface LayoutElement {
  type: 'text' | 'image' | 'table' | 'heading';
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  text?: string;
  style?: any;
}

/**
 * Universal document extraction core.
 */
export async function extract(filePath: string, mode: ExtractionMode = 'all'): Promise<ExtractionResult> {
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
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
  const data = await pdf(buffer);
  
  if (mode === 'content' || mode === 'all') {
    result.layers.content = data.text;
  }
  
  if (mode === 'metadata' || mode === 'all') {
    result.layers.metadata = data.info;
  }

  if (mode === 'aesthetic' || mode === 'all') {
    // Basic heuristic analysis
    const hasImage = buffer.toString('utf8').includes('/Image');
    result.layers.aesthetic = {
      layout: data.text.length > 5000 ? 'multi-column' : 'single-column',
      elements: [],
      branding: {
        logo_presence: hasImage,
        tone: data.text.includes('規約') || data.text.includes('Agreement') ? 'professional' : 'technical'
      }
    };
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
      fonts: ['Detected via internal styles'],
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
    result.layers.metadata = {
      sheets: workbook.SheetNames,
      props: workbook.Props
    };
  }

  if (mode === 'aesthetic' || mode === 'all') {
    result.layers.aesthetic = {
      layout: 'grid',
      branding: { logo_presence: false, tone: 'technical' }
    };
  }
}

async function processPptx(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  // PPTX extraction is often similar to DOCX but with slide boundaries
  // For now, use a simplified approach
  result.layers.content = 'PowerPoint content extraction pending full implementation.';
  result.layers.metadata = { type: 'PowerPoint' };
  result.layers.aesthetic = { layout: 'unknown' };
}

async function processImage(buffer: Buffer, mode: ExtractionMode, result: ExtractionResult) {
  if (mode === 'content' || mode === 'all') {
    const { data: { text } } = await Tesseract.recognize(buffer, 'eng+jpn');
    result.layers.content = text;
  }

  if (mode === 'aesthetic' || mode === 'all') {
    // Future: Use Sharp to extract dominant colors
    result.layers.aesthetic = {
      colors: [],
      branding: { logo_presence: true }
    };
  }
}
