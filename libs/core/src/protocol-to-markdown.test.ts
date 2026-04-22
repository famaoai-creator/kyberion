import { describe, it, expect } from 'vitest';
import {
  protocolToMarkdown,
  pdfToMarkdown,
  docxToMarkdown,
  xlsxToMarkdown,
  pptxToMarkdown,
  extractTablesFromPage,
} from './protocol-to-markdown.js';
import type { PdfDesignProtocol, PdfPage } from './types/pdf-protocol.js';
import type { DocxDesignProtocol } from './types/docx-protocol.js';
import type { XlsxDesignProtocol } from './types/xlsx-protocol.js';
import type { PptxDesignProtocol } from './types/pptx-protocol.js';

// ─── PDF ────────────────────────────────────────────────────

describe('pdfToMarkdown', () => {
  it('renders metadata and page text', () => {
    const protocol: PdfDesignProtocol = {
      version: '4.0',
      generatedAt: '2026-04-10',
      source: { format: 'markdown', body: '' },
      metadata: { title: 'Invoice #123', author: 'ACME Corp', pageCount: 1 },
      content: {
        text: 'Total: ¥100,000',
        pages: [{ pageNumber: 1, width: 595, height: 842, text: 'Total: ¥100,000' }],
      },
    };
    const md = pdfToMarkdown(protocol);
    expect(md).toContain('# Invoice #123');
    expect(md).toContain('Author: ACME Corp');
    expect(md).toContain('Total: ¥100,000');
  });

  it('renders outlines as table of contents', () => {
    const protocol: PdfDesignProtocol = {
      version: '4.0',
      generatedAt: '2026-04-10',
      source: { format: 'markdown', body: '' },
      outlines: [
        { title: 'Chapter 1', pageIndex: 0, children: [{ title: 'Section 1.1', pageIndex: 1 }] },
        { title: 'Chapter 2', pageIndex: 2 },
      ],
      content: { text: '', pages: [] },
    };
    const md = pdfToMarkdown(protocol);
    expect(md).toContain('## Table of Contents');
    expect(md).toContain('- Chapter 1');
    expect(md).toContain('  - Section 1.1');
    expect(md).toContain('- Chapter 2');
  });

  it('renders AcroForm fields', () => {
    const protocol: PdfDesignProtocol = {
      version: '4.0',
      generatedAt: '2026-04-10',
      source: { format: 'markdown', body: '' },
      content: { text: '', pages: [] },
      acroForm: {
        fields: [
          { name: 'name', type: 'text', rect: [0, 0, 100, 20], value: 'Tanaka' },
          { name: 'approved', type: 'checkbox', rect: [0, 20, 20, 40], checked: true },
        ],
      },
    };
    const md = pdfToMarkdown(protocol);
    expect(md).toContain('| name | text | Tanaka |');
  });
});

describe('extractTablesFromPage', () => {
  it('extracts a simple table from aligned layout elements', () => {
    const page: PdfPage = {
      pageNumber: 1, width: 595, height: 842, text: '',
      elements: [
        // Row 1 (header)
        { type: 'text', x: 50, y: 100, width: 100, height: 12, text: 'Item' },
        { type: 'text', x: 200, y: 100, width: 100, height: 12, text: 'Price' },
        { type: 'text', x: 350, y: 100, width: 100, height: 12, text: 'Qty' },
        // Row 2
        { type: 'text', x: 50, y: 120, width: 100, height: 12, text: 'Widget' },
        { type: 'text', x: 200, y: 120, width: 100, height: 12, text: '¥1,000' },
        { type: 'text', x: 350, y: 120, width: 100, height: 12, text: '5' },
        // Row 3
        { type: 'text', x: 50, y: 140, width: 100, height: 12, text: 'Gadget' },
        { type: 'text', x: 200, y: 140, width: 100, height: 12, text: '¥2,500' },
        { type: 'text', x: 350, y: 140, width: 100, height: 12, text: '3' },
      ],
    };
    const result = extractTablesFromPage(page);
    expect(result).not.toBeNull();
    expect(result).toContain('| Item | Price | Qty |');
    expect(result).toContain('|---|---|---|');
    expect(result).toContain('| Widget | ¥1,000 | 5 |');
    expect(result).toContain('| Gadget | ¥2,500 | 3 |');
  });

  it('returns null for fewer than 4 elements', () => {
    const page: PdfPage = {
      pageNumber: 1, width: 595, height: 842, text: 'Hello',
      elements: [
        { type: 'text', x: 50, y: 100, width: 100, height: 12, text: 'Hello' },
      ],
    };
    expect(extractTablesFromPage(page)).toBeNull();
  });

  it('returns null for non-tabular scattered elements', () => {
    const page: PdfPage = {
      pageNumber: 1, width: 595, height: 842, text: '',
      elements: [
        { type: 'text', x: 50, y: 100, width: 100, height: 12, text: 'A' },
        { type: 'text', x: 50, y: 200, width: 100, height: 12, text: 'B' },
        { type: 'text', x: 50, y: 300, width: 100, height: 12, text: 'C' },
        { type: 'text', x: 50, y: 400, width: 100, height: 12, text: 'D' },
      ],
    };
    // Single column — not a table (median cols = 1)
    expect(extractTablesFromPage(page)).toBeNull();
  });
});

// ─── DOCX ───────────────────────────────────────────────────

describe('docxToMarkdown', () => {
  const minimalProtocol = (body: DocxDesignProtocol['body']): DocxDesignProtocol => ({
    version: '1.0',
    generatedAt: '2026-04-10',
    theme: { colors: {} },
    styles: { definitions: [] },
    body,
    sections: [],
    headersFooters: [],
    relationships: [],
  });

  it('renders paragraphs with heading detection', () => {
    const protocol = minimalProtocol([
      {
        type: 'paragraph',
        paragraph: {
          pPr: { outlineLevel: 0 },
          content: [{ type: 'run', run: { content: [{ type: 'text', text: 'Introduction' }] } }],
        },
      },
      {
        type: 'paragraph',
        paragraph: {
          content: [{ type: 'run', run: { content: [{ type: 'text', text: 'This is body text.' }] } }],
        },
      },
    ]);
    const md = docxToMarkdown(protocol);
    expect(md).toContain('# Introduction');
    expect(md).toContain('This is body text.');
  });

  it('renders tables', () => {
    const protocol = minimalProtocol([
      {
        type: 'table',
        table: {
          tblGrid: [2000, 2000],
          rows: [
            { cells: [
              { content: [{ type: 'paragraph', paragraph: { content: [{ type: 'run', run: { content: [{ type: 'text', text: 'Name' }] } }] } }] },
              { content: [{ type: 'paragraph', paragraph: { content: [{ type: 'run', run: { content: [{ type: 'text', text: 'Age' }] } }] } }] },
            ] },
            { cells: [
              { content: [{ type: 'paragraph', paragraph: { content: [{ type: 'run', run: { content: [{ type: 'text', text: 'Tanaka' }] } }] } }] },
              { content: [{ type: 'paragraph', paragraph: { content: [{ type: 'run', run: { content: [{ type: 'text', text: '30' }] } }] } }] },
            ] },
          ],
        },
      },
    ]);
    const md = docxToMarkdown(protocol);
    expect(md).toContain('| Name | Age |');
    expect(md).toContain('|---|---|');
    expect(md).toContain('| Tanaka | 30 |');
  });

  it('renders bold and italic inline formatting', () => {
    const protocol = minimalProtocol([
      {
        type: 'paragraph',
        paragraph: {
          content: [
            { type: 'run', run: { rPr: { bold: true }, content: [{ type: 'text', text: 'important' }] } },
            { type: 'run', run: { content: [{ type: 'text', text: ' text' }] } },
          ],
        },
      },
    ]);
    const md = docxToMarkdown(protocol);
    expect(md).toContain('**important** text');
  });
});

// ─── XLSX ───────────────────────────────────────────────────

describe('xlsxToMarkdown', () => {
  it('renders a sheet as a Markdown table', () => {
    const protocol: XlsxDesignProtocol = {
      version: '1.0',
      generatedAt: '2026-04-10',
      theme: { colors: {} },
      styles: { fonts: [], fills: [], borders: [], numFmts: [], cellXfs: [], namedStyles: [] },
      sharedStrings: ['Product', 'Revenue', 'Widget', 'Gadget'],
      definedNames: [],
      sheets: [{
        id: 'sheet1',
        name: 'Sales',
        columns: [],
        rows: [
          { index: 1, cells: [
            { ref: 'A1', type: 's', value: 0 },
            { ref: 'B1', type: 's', value: 1 },
          ] },
          { index: 2, cells: [
            { ref: 'A2', type: 's', value: 2 },
            { ref: 'B2', type: 'n', value: 50000 },
          ] },
          { index: 3, cells: [
            { ref: 'A3', type: 's', value: 3 },
            { ref: 'B3', type: 'n', value: 30000 },
          ] },
        ],
        mergeCells: [],
        tables: [],
        conditionalFormats: [],
        dataValidations: [],
      }],
    };
    const md = xlsxToMarkdown(protocol);
    expect(md).toContain('| Product | Revenue |');
    expect(md).toContain('| Widget | 50000 |');
    expect(md).toContain('| Gadget | 30000 |');
  });

  it('skips hidden sheets', () => {
    const protocol: XlsxDesignProtocol = {
      version: '1.0',
      generatedAt: '2026-04-10',
      theme: { colors: {} },
      styles: { fonts: [], fills: [], borders: [], numFmts: [], cellXfs: [], namedStyles: [] },
      sharedStrings: ['Secret'],
      definedNames: [],
      sheets: [{
        id: 'sheet1',
        name: 'Hidden',
        state: 'hidden',
        columns: [],
        rows: [{ index: 1, cells: [{ ref: 'A1', type: 's', value: 0 }] }],
        mergeCells: [],
        tables: [],
        conditionalFormats: [],
        dataValidations: [],
      }],
    };
    const md = xlsxToMarkdown(protocol);
    expect(md).not.toContain('Secret');
  });
});

// ─── PPTX ───────────────────────────────────────────────────

describe('pptxToMarkdown', () => {
  it('renders slides with title and body text', () => {
    const protocol: PptxDesignProtocol = {
      version: '1.0',
      generatedAt: '2026-04-10',
      canvas: { w: 9144000, h: 6858000 },
      theme: {},
      master: { elements: [] },
      slides: [{
        id: 'slide1',
        elements: [
          { type: 'text', placeholderType: 'title', pos: { x: 100, y: 50, w: 500, h: 50 }, text: 'Q1 Results' },
          { type: 'text', pos: { x: 100, y: 150, w: 500, h: 200 }, text: 'Revenue grew by 15%' },
        ],
      }],
    };
    const md = pptxToMarkdown(protocol);
    expect(md).toContain('## Slide 1');
    expect(md).toContain('### Q1 Results');
    expect(md).toContain('Revenue grew by 15%');
  });

  it('renders tables within slides', () => {
    const protocol: PptxDesignProtocol = {
      version: '1.0',
      generatedAt: '2026-04-10',
      canvas: { w: 9144000, h: 6858000 },
      theme: {},
      master: { elements: [] },
      slides: [{
        id: 'slide1',
        elements: [
          {
            type: 'table',
            pos: { x: 100, y: 100, w: 500, h: 200 },
            tableData: [
              ['Region', 'Sales'],
              ['Tokyo', '¥5M'],
              ['Osaka', '¥3M'],
            ],
          },
        ],
      }],
    };
    const md = pptxToMarkdown(protocol);
    expect(md).toContain('| Region | Sales |');
    expect(md).toContain('| Tokyo | ¥5M |');
  });

  it('renders image and chart placeholders', () => {
    const protocol: PptxDesignProtocol = {
      version: '1.0',
      generatedAt: '2026-04-10',
      canvas: { w: 9144000, h: 6858000 },
      theme: {},
      master: { elements: [] },
      slides: [{
        id: 'slide1',
        elements: [
          { type: 'image', pos: { x: 0, y: 0, w: 100, h: 100 }, altText: 'Company Logo' },
          { type: 'chart', pos: { x: 0, y: 100, w: 400, h: 300 }, name: 'Revenue Trend' },
        ],
      }],
    };
    const md = pptxToMarkdown(protocol);
    expect(md).toContain('[Image: Company Logo]');
    expect(md).toContain('[Chart: Revenue Trend]');
  });
});

// ─── Auto-detection ─────────────────────────────────────────

describe('protocolToMarkdown (auto-detect)', () => {
  it('detects PDF protocol', () => {
    const protocol: PdfDesignProtocol = {
      version: '4.0',
      generatedAt: '2026-04-10',
      source: { format: 'markdown', body: '' },
      content: { text: 'Hello PDF', pages: [{ pageNumber: 1, width: 595, height: 842, text: 'Hello PDF' }] },
    };
    const md = protocolToMarkdown(protocol);
    expect(md).toContain('Hello PDF');
  });

  it('detects XLSX protocol', () => {
    const protocol: XlsxDesignProtocol = {
      version: '1.0',
      generatedAt: '2026-04-10',
      theme: { colors: {} },
      styles: { fonts: [], fills: [], borders: [], numFmts: [], cellXfs: [], namedStyles: [] },
      sharedStrings: ['Data'],
      definedNames: [],
      sheets: [{
        id: 's1', name: 'Sheet1', columns: [],
        rows: [{ index: 1, cells: [{ ref: 'A1', type: 's', value: 0 }] }],
        mergeCells: [], tables: [], conditionalFormats: [], dataValidations: [],
      }],
    };
    const md = protocolToMarkdown(protocol);
    expect(md).toContain('Data');
  });
});
