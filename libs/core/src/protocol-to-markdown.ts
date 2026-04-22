/**
 * Protocol-to-Markdown converter
 * Converts DesignProtocol objects into concise, LLM-friendly Markdown.
 * Strips aesthetic/design details and preserves only content structure.
 */

import type { PdfDesignProtocol, PdfPage, PdfLayoutElement } from './types/pdf-protocol.js';
import type { DocxDesignProtocol, DocxBlockContent, DocxParagraph, DocxRun, DocxTable, DocxTableRow } from './types/docx-protocol.js';
import type { XlsxDesignProtocol, XlsxWorksheet, XlsxRow, XlsxCell } from './types/xlsx-protocol.js';
import type { PptxDesignProtocol, PptxSlide, PptxElement } from './types/pptx-protocol.js';

// ─── Public API ──────────────────────────────────────────────

/**
 * Convert any DesignProtocol to LLM-friendly Markdown.
 * Auto-detects the protocol type from its shape.
 */
export function protocolToMarkdown(
  protocol: PdfDesignProtocol | DocxDesignProtocol | XlsxDesignProtocol | PptxDesignProtocol,
): string {
  if (isPdf(protocol)) return pdfToMarkdown(protocol);
  if (isDocx(protocol)) return docxToMarkdown(protocol);
  if (isXlsx(protocol)) return xlsxToMarkdown(protocol);
  if (isPptx(protocol)) return pptxToMarkdown(protocol);
  return '(Unknown protocol format)';
}

export function pdfToMarkdown(protocol: PdfDesignProtocol): string {
  const lines: string[] = [];

  // Metadata header
  const meta = protocol.metadata;
  if (meta) {
    if (meta.title) lines.push(`# ${meta.title}`, '');
    const attrs: string[] = [];
    if (meta.author) attrs.push(`Author: ${meta.author}`);
    if (meta.pageCount) attrs.push(`Pages: ${meta.pageCount}`);
    if (meta.creationDate) attrs.push(`Created: ${meta.creationDate}`);
    if (attrs.length) lines.push(attrs.join(' | '), '');
  }

  // Outlines as TOC
  if (protocol.outlines?.length) {
    lines.push('## Table of Contents', '');
    for (const item of protocol.outlines) {
      renderOutline(item, 0, lines);
    }
    lines.push('');
  }

  // Page content
  const pages = protocol.content?.pages ?? [];
  for (const page of pages) {
    if (pages.length > 1) {
      lines.push(`---`, `<!-- Page ${page.pageNumber} -->`, '');
    }
    const tableMarkdown = extractTablesFromPage(page);
    if (tableMarkdown) {
      lines.push(tableMarkdown, '');
    } else if (page.text.trim()) {
      lines.push(page.text.trim(), '');
    }
    // Links from annotations
    const links = (page.annotations ?? []).filter(a => a.type === 'Link' && 'uri' in a && a.uri);
    if (links.length) {
      for (const link of links) {
        if ('uri' in link && link.uri) {
          lines.push(`- Link: ${link.uri}`);
        }
      }
      lines.push('');
    }
  }

  // AcroForm fields summary
  if (protocol.acroForm?.fields?.length) {
    lines.push('## Form Fields', '');
    lines.push('| Field | Type | Value |', '|---|---|---|');
    for (const f of protocol.acroForm.fields) {
      const val = f.value ?? f.defaultValue ?? '';
      lines.push(`| ${f.name} | ${f.type} | ${val} |`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function docxToMarkdown(protocol: DocxDesignProtocol): string {
  const lines: string[] = [];

  // Title from source or first heading
  if (protocol.source?.title) {
    lines.push(`# ${protocol.source.title}`, '');
  }

  // Walk block content
  for (const block of protocol.body) {
    renderDocxBlock(block, lines, protocol);
  }

  return lines.join('\n').trim();
}

export function xlsxToMarkdown(protocol: XlsxDesignProtocol): string {
  const lines: string[] = [];

  for (const sheet of protocol.sheets) {
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') continue;
    if (protocol.sheets.length > 1) {
      lines.push(`## ${sheet.name}`, '');
    }
    renderXlsxSheet(sheet, protocol.sharedStrings, lines);
    lines.push('');
  }

  return lines.join('\n').trim();
}

export function pptxToMarkdown(protocol: PptxDesignProtocol): string {
  const lines: string[] = [];

  for (let i = 0; i < protocol.slides.length; i++) {
    const slide = protocol.slides[i];
    lines.push(`## Slide ${i + 1}`, '');
    renderPptxSlide(slide, lines);
    lines.push('');
  }

  return lines.join('\n').trim();
}

// ─── Type Guards ────────────────────────────────────────────

function isPdf(p: unknown): p is PdfDesignProtocol {
  return p != null && typeof p === 'object' && 'content' in p && 'source' in p && typeof (p as PdfDesignProtocol).source?.format === 'string';
}

function isDocx(p: unknown): p is DocxDesignProtocol {
  return p != null && typeof p === 'object' && 'body' in p && 'styles' in p && Array.isArray((p as DocxDesignProtocol).body);
}

function isXlsx(p: unknown): p is XlsxDesignProtocol {
  return p != null && typeof p === 'object' && 'sheets' in p && 'sharedStrings' in p && Array.isArray((p as XlsxDesignProtocol).sheets);
}

function isPptx(p: unknown): p is PptxDesignProtocol {
  return p != null && typeof p === 'object' && 'slides' in p && 'canvas' in p && Array.isArray((p as PptxDesignProtocol).slides);
}

// ─── PDF Helpers ────────────────────────────────────────────

function renderOutline(item: { title: string; children?: { title: string; children?: any[] }[] }, depth: number, lines: string[]) {
  lines.push(`${'  '.repeat(depth)}- ${item.title}`);
  if (item.children) {
    for (const child of item.children) {
      renderOutline(child, depth + 1, lines);
    }
  }
}

/**
 * Attempt to reconstruct Markdown tables from PDF layout elements.
 * Groups text elements by Y-coordinate (rows) and X-coordinate (columns).
 */
export function extractTablesFromPage(page: PdfPage): string | null {
  const elements = (page.elements ?? []).filter(e => e.type === 'text' && e.text?.trim());
  if (elements.length < 4) return null; // Need enough elements to form a table

  // Cluster by Y position (rows) with tolerance
  const Y_TOLERANCE = 5;
  const rows = clusterByAxis(elements, 'y', Y_TOLERANCE);
  if (rows.length < 2) return null;

  // Check if rows have consistent column count (table signature)
  const colCounts = rows.map(r => r.length);
  const medianCols = colCounts.sort((a, b) => a - b)[Math.floor(colCounts.length / 2)];
  if (medianCols < 2) return null;

  // Check that at least 60% of rows have the median column count (±1)
  const consistentRows = colCounts.filter(c => Math.abs(c - medianCols) <= 1).length;
  if (consistentRows / rows.length < 0.6) return null;

  // Build Markdown table
  const lines: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].sort((a, b) => a.x - b.x).map(e => (e.text ?? '').trim());
    lines.push(`| ${cells.join(' | ')} |`);
    if (i === 0) {
      lines.push(`|${cells.map(() => '---').join('|')}|`);
    }
  }

  // Also include any remaining non-table text
  const tableElementSet = new Set(rows.flat());
  const remaining = elements.filter(e => !tableElementSet.has(e));
  const extraText = remaining.map(e => (e.text ?? '').trim()).filter(Boolean).join('\n');

  return lines.join('\n') + (extraText ? '\n\n' + extraText : '');
}

function clusterByAxis(elements: PdfLayoutElement[], axis: 'x' | 'y', tolerance: number): PdfLayoutElement[][] {
  const sorted = [...elements].sort((a, b) => a[axis] - b[axis]);
  const clusters: PdfLayoutElement[][] = [];
  let current: PdfLayoutElement[] = [sorted[0]];
  let anchor = sorted[0][axis];

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i][axis] - anchor) <= tolerance) {
      current.push(sorted[i]);
    } else {
      clusters.push(current);
      current = [sorted[i]];
      anchor = sorted[i][axis];
    }
  }
  clusters.push(current);
  return clusters;
}

// ─── DOCX Helpers ───────────────────────────────────────────

function renderDocxBlock(block: DocxBlockContent, lines: string[], protocol: DocxDesignProtocol) {
  switch (block.type) {
    case 'paragraph':
      renderDocxParagraph(block.paragraph, lines, protocol);
      break;
    case 'table':
      renderDocxTable(block.table, lines, protocol);
      break;
    case 'sdt':
      for (const child of block.content) {
        renderDocxBlock(child, lines, protocol);
      }
      break;
  }
}

function renderDocxParagraph(para: DocxParagraph, lines: string[], protocol: DocxDesignProtocol) {
  const text = extractDocxParagraphText(para);
  if (!text.trim()) {
    lines.push('');
    return;
  }

  // Detect heading level from style or outlineLevel
  const headingLevel = detectHeadingLevel(para, protocol);
  if (headingLevel > 0 && headingLevel <= 6) {
    lines.push(`${'#'.repeat(headingLevel)} ${text}`, '');
    return;
  }

  // Detect list items
  if (para.pPr?.numPr) {
    const level = para.pPr.numPr.ilvl ?? 0;
    const numDef = findNumberingDef(para.pPr.numPr.numId, para.pPr.numPr.ilvl, protocol);
    const isBullet = !numDef || numDef === 'bullet';
    const prefix = isBullet ? '-' : `1.`;
    lines.push(`${'  '.repeat(level)}${prefix} ${text}`);
    return;
  }

  lines.push(text, '');
}

function extractDocxParagraphText(para: DocxParagraph): string {
  const parts: string[] = [];
  for (const item of para.content) {
    if (item.type === 'run') {
      parts.push(extractDocxRunText(item.run));
    } else if (item.type === 'hyperlink') {
      const linkText = item.hyperlink.runs.map(r => extractDocxRunText(r)).join('');
      if (linkText) parts.push(linkText);
    }
  }
  return parts.join('');
}

function extractDocxRunText(run: DocxRun): string {
  const parts: string[] = [];
  for (const c of run.content) {
    switch (c.type) {
      case 'text':
        parts.push(c.text);
        break;
      case 'tab':
        parts.push('\t');
        break;
      case 'break':
        if (c.breakType === 'textWrapping') parts.push('\n');
        break;
    }
  }
  let text = parts.join('');
  // Apply inline formatting
  if (run.rPr?.bold) text = `**${text}**`;
  if (run.rPr?.italic) text = `*${text}*`;
  if (run.rPr?.strike) text = `~~${text}~~`;
  return text;
}

function detectHeadingLevel(para: DocxParagraph, protocol: DocxDesignProtocol): number {
  // Check outlineLevel
  if (para.pPr?.outlineLevel != null && para.pPr.outlineLevel >= 0) {
    return para.pPr.outlineLevel + 1;
  }
  // Check style name
  const styleId = para.pPr?.pStyle;
  if (styleId) {
    const styleDef = protocol.styles.definitions.find(s => s.styleId === styleId);
    if (styleDef) {
      const match = styleDef.name.match(/^[Hh]eading\s*(\d)/);
      if (match) return parseInt(match[1], 10);
      // Japanese heading styles
      const jaMatch = styleDef.name.match(/見出し\s*(\d)/);
      if (jaMatch) return parseInt(jaMatch[1], 10);
    }
  }
  return 0;
}

function findNumberingDef(numId: number, ilvl: number, protocol: DocxDesignProtocol): string | null {
  if (!protocol.numbering) return null;
  const num = protocol.numbering.nums.find(n => n.numId === numId);
  if (!num) return null;
  const abstractNum = protocol.numbering.abstractNums.find(a => a.abstractNumId === num.abstractNumId);
  if (!abstractNum) return null;
  const level = abstractNum.levels.find(l => l.ilvl === ilvl);
  return level?.numFmt ?? null;
}

function renderDocxTable(table: DocxTable, lines: string[], protocol: DocxDesignProtocol) {
  if (!table.rows.length) return;

  const allRows = table.rows.map(row => extractDocxTableRowCells(row, protocol));
  const maxCols = Math.max(...allRows.map(r => r.length));

  for (let i = 0; i < allRows.length; i++) {
    const cells = allRows[i];
    // Pad to maxCols
    while (cells.length < maxCols) cells.push('');
    lines.push(`| ${cells.join(' | ')} |`);
    if (i === 0) {
      lines.push(`|${cells.map(() => '---').join('|')}|`);
    }
  }
  lines.push('');
}

function extractDocxTableRowCells(row: DocxTableRow, protocol: DocxDesignProtocol): string[] {
  return row.cells.map(cell => {
    const parts = cell.content
      .filter((b): b is DocxBlockContent & { type: 'paragraph' } => b.type === 'paragraph')
      .map(b => extractDocxParagraphText(b.paragraph).trim());
    return parts.join(' ');
  });
}

// ─── XLSX Helpers ───────────────────────────────────────────

function renderXlsxSheet(sheet: XlsxWorksheet, sharedStrings: string[], lines: string[]) {
  if (!sheet.rows.length) {
    lines.push('(Empty sheet)');
    return;
  }

  // Determine column range
  let maxCol = 0;
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const colIdx = cellRefToColIndex(cell.ref);
      if (colIdx > maxCol) maxCol = colIdx;
    }
  }
  if (maxCol === 0 && sheet.rows[0]?.cells.length === 0) {
    lines.push('(Empty sheet)');
    return;
  }

  const colCount = maxCol + 1;

  // Build rows as string arrays
  const tableRows: string[][] = [];
  for (const row of sheet.rows) {
    if (row.hidden) continue;
    const cells: string[] = new Array(colCount).fill('');
    for (const cell of row.cells) {
      const colIdx = cellRefToColIndex(cell.ref);
      cells[colIdx] = resolveXlsxCellValue(cell, sharedStrings);
    }
    tableRows.push(cells);
  }

  if (!tableRows.length) return;

  // Render as Markdown table
  for (let i = 0; i < tableRows.length; i++) {
    lines.push(`| ${tableRows[i].join(' | ')} |`);
    if (i === 0) {
      lines.push(`|${tableRows[i].map(() => '---').join('|')}|`);
    }
  }
}

function resolveXlsxCellValue(cell: XlsxCell, sharedStrings: string[]): string {
  if (cell.type === 's' && typeof cell.value === 'number') {
    return sharedStrings[cell.value] ?? '';
  }
  if (cell.richText) {
    return cell.richText.map(r => r.text).join('');
  }
  if (cell.value != null) return String(cell.value);
  return '';
}

function cellRefToColIndex(ref: string): number {
  const match = ref.match(/^([A-Z]+)/);
  if (!match) return 0;
  const letters = match[1];
  let index = 0;
  for (let i = 0; i < letters.length; i++) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1; // 0-based
}

// ─── PPTX Helpers ───────────────────────────────────────────

function renderPptxSlide(slide: PptxSlide, lines: string[]) {
  // Sort elements top-to-bottom, left-to-right
  const sorted = [...slide.elements].sort((a, b) => a.pos.y - b.pos.y || a.pos.x - b.pos.x);

  for (const el of sorted) {
    renderPptxElement(el, lines);
  }
}

function renderPptxElement(el: PptxElement, lines: string[]) {
  switch (el.type) {
    case 'text':
    case 'shape': {
      const text = extractPptxElementText(el);
      if (!text.trim()) break;
      // Title placeholders become headings
      if (el.placeholderType === 'title' || el.placeholderType === 'ctrTitle') {
        lines.push(`### ${text.trim()}`, '');
      } else if (el.placeholderType === 'subTitle') {
        lines.push(`*${text.trim()}*`, '');
      } else {
        lines.push(text.trim(), '');
      }
      break;
    }
    case 'table': {
      const data = el.tableData ?? el.rows;
      if (!data?.length) break;
      for (let i = 0; i < data.length; i++) {
        const cells = (data[i] as (string | number | boolean | null)[]).map(c => String(c ?? ''));
        lines.push(`| ${cells.join(' | ')} |`);
        if (i === 0) {
          lines.push(`|${cells.map(() => '---').join('|')}|`);
        }
      }
      lines.push('');
      break;
    }
    case 'image': {
      const alt = el.altText ?? el.name ?? 'image';
      lines.push(`[Image: ${alt}]`, '');
      break;
    }
    case 'chart': {
      lines.push(`[Chart: ${el.name ?? 'chart'}]`, '');
      break;
    }
    case 'smartart': {
      lines.push(`[SmartArt: ${el.name ?? 'diagram'}]`, '');
      break;
    }
  }
}

function extractPptxElementText(el: PptxElement): string {
  if (el.textRuns?.length) {
    return el.textRuns.map(r => r.text).join('');
  }
  return el.text ?? '';
}
