/**
 * Native DOCX Engine — OOXML Spec Compliance & Round-Trip Tests
 *
 * Validates generated DOCX XML against ECMA-376 WordprocessingML requirements
 * and tests extract → generate → extract round-trip fidelity.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { pathResolver } from '../../../index.js';
import { generateNativeDocx } from '../engine';
import { distillDocxDesign } from '../../docx-utils.js';
import type { DocxDesignProtocol } from '../../types/docx-protocol.js';

// ─── Helpers ────────────────────────────────────────────────

function extractDocx(docxPath: string): Map<string, string> {
  const zip = new AdmZip(docxPath);
  const files = new Map<string, string>();
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      files.set(entry.entryName, entry.getData().toString('utf8'));
    }
  }
  return files;
}

function countTag(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}[\\s/>]`, 'g');
  return (xml.match(re) || []).length;
}

// ─── Test Protocol (minimal valid document) ──────────────────

function createTestProtocol(): DocxDesignProtocol {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      colors: {
        dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6',
        accent1: '5B9BD5', accent2: 'ED7D31', accent3: 'A5A5A5',
        accent4: 'FFC000', accent5: '4472C4', accent6: '70AD47',
        hlink: '0563C1', folHlink: '954F72',
      },
    },
    styles: {
      docDefaults: {
        rPrDefault: {
          rFonts: { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: 'MS Mincho' },
          sz: 22,
          szCs: 22,
        },
        pPrDefault: {
          spacing: { after: 160, line: 259, lineRule: 'auto' },
        },
      },
      definitions: [
        {
          styleId: 'Normal',
          type: 'paragraph',
          name: 'Normal',
          isDefault: true,
        },
        {
          styleId: 'Heading1',
          type: 'paragraph',
          name: 'heading 1',
          basedOn: 'Normal',
          next: 'Normal',
          pPr: {
            keepNext: true,
            keepLines: true,
            spacing: { before: 240, after: 0 },
            outlineLevel: 0,
          },
          rPr: {
            rFonts: { ascii: 'Calibri Light', hAnsi: 'Calibri Light', eastAsia: 'MS Gothic' },
            color: { val: '2E74B5' },
            sz: 32,
          },
        },
        {
          styleId: 'Heading2',
          type: 'paragraph',
          name: 'heading 2',
          basedOn: 'Normal',
          next: 'Normal',
          pPr: {
            keepNext: true,
            spacing: { before: 40, after: 0 },
            outlineLevel: 1,
          },
          rPr: {
            rFonts: { ascii: 'Calibri Light', hAnsi: 'Calibri Light' },
            color: { val: '2E74B5' },
            sz: 26,
          },
        },
      ],
    },
    numbering: {
      abstractNums: [
        {
          abstractNumId: 0,
          levels: [
            { ilvl: 0, numFmt: 'bullet', lvlText: '●', start: 1, jc: 'left' },
            { ilvl: 1, numFmt: 'bullet', lvlText: '○', start: 1, jc: 'left' },
          ],
        },
      ],
      nums: [
        { numId: 1, abstractNumId: 0 },
      ],
    },
    body: [
      // Heading 1
      {
        type: 'paragraph',
        paragraph: {
          pPr: { pStyle: 'Heading1' },
          content: [
            {
              type: 'run',
              run: {
                content: [{ type: 'text', text: 'テスト文書タイトル' }],
              },
            },
          ],
        },
      },
      // Normal paragraph with bold and colored text
      {
        type: 'paragraph',
        paragraph: {
          content: [
            {
              type: 'run',
              run: {
                rPr: { bold: true, color: { val: 'FF0000' } },
                content: [{ type: 'text', text: '太字赤テキスト' }],
              },
            },
            {
              type: 'run',
              run: {
                content: [{ type: 'text', text: 'と通常テキスト' }],
              },
            },
          ],
        },
      },
      // Paragraph with line break
      {
        type: 'paragraph',
        paragraph: {
          content: [
            {
              type: 'run',
              run: {
                content: [
                  { type: 'text', text: '改行前' },
                  { type: 'break' },
                  { type: 'text', text: '改行後' },
                ],
              },
            },
          ],
        },
      },
      // Bullet list items
      {
        type: 'paragraph',
        paragraph: {
          pPr: { numPr: { ilvl: 0, numId: 1 } },
          content: [
            { type: 'run', run: { content: [{ type: 'text', text: '箇条書き項目1' }] } },
          ],
        },
      },
      {
        type: 'paragraph',
        paragraph: {
          pPr: { numPr: { ilvl: 0, numId: 1 } },
          content: [
            { type: 'run', run: { content: [{ type: 'text', text: '箇条書き項目2' }] } },
          ],
        },
      },
      // Heading 2
      {
        type: 'paragraph',
        paragraph: {
          pPr: { pStyle: 'Heading2' },
          content: [
            { type: 'run', run: { content: [{ type: 'text', text: 'テーブルセクション' }] } },
          ],
        },
      },
      // Table
      {
        type: 'table',
        table: {
          tblPr: {
            tblStyle: 'TableGrid',
            tblW: { w: 5000, type: 'pct' },
            tblBorders: {
              top: { val: 'single', sz: 4, color: '000000' },
              left: { val: 'single', sz: 4, color: '000000' },
              bottom: { val: 'single', sz: 4, color: '000000' },
              right: { val: 'single', sz: 4, color: '000000' },
              insideH: { val: 'single', sz: 4, color: '000000' },
              insideV: { val: 'single', sz: 4, color: '000000' },
            },
          },
          tblGrid: [2500, 2500, 2500],
          rows: [
            {
              trPr: { tblHeader: true },
              cells: [
                {
                  tcPr: { tcW: { w: 2500, type: 'dxa' }, shd: { val: 'clear', fill: '232F3E' } },
                  content: [{
                    type: 'paragraph',
                    paragraph: {
                      content: [{
                        type: 'run',
                        run: {
                          rPr: { bold: true, color: { val: 'FFFFFF' } },
                          content: [{ type: 'text', text: '列A' }],
                        },
                      }],
                    },
                  }],
                },
                {
                  tcPr: { tcW: { w: 2500, type: 'dxa' }, shd: { val: 'clear', fill: '232F3E' } },
                  content: [{
                    type: 'paragraph',
                    paragraph: {
                      content: [{
                        type: 'run',
                        run: {
                          rPr: { bold: true, color: { val: 'FFFFFF' } },
                          content: [{ type: 'text', text: '列B' }],
                        },
                      }],
                    },
                  }],
                },
                {
                  tcPr: { tcW: { w: 2500, type: 'dxa' }, shd: { val: 'clear', fill: '232F3E' } },
                  content: [{
                    type: 'paragraph',
                    paragraph: {
                      content: [{
                        type: 'run',
                        run: {
                          rPr: { bold: true, color: { val: 'FFFFFF' } },
                          content: [{ type: 'text', text: '列C' }],
                        },
                      }],
                    },
                  }],
                },
              ],
            },
            {
              cells: [
                {
                  tcPr: { tcW: { w: 2500, type: 'dxa' } },
                  content: [{
                    type: 'paragraph',
                    paragraph: {
                      content: [{ type: 'run', run: { content: [{ type: 'text', text: 'データ1' }] } }],
                    },
                  }],
                },
                {
                  tcPr: { tcW: { w: 2500, type: 'dxa' } },
                  content: [{
                    type: 'paragraph',
                    paragraph: {
                      content: [{ type: 'run', run: { content: [{ type: 'text', text: 'データ2' }] } }],
                    },
                  }],
                },
                {
                  tcPr: { tcW: { w: 2500, type: 'dxa' } },
                  content: [{
                    type: 'paragraph',
                    paragraph: {
                      content: [{ type: 'run', run: { content: [{ type: 'text', text: 'データ3' }] } }],
                    },
                  }],
                },
              ],
            },
          ],
        },
      },
      // Paragraph with hyperlink
      {
        type: 'paragraph',
        paragraph: {
          content: [
            {
              type: 'hyperlink',
              hyperlink: {
                anchor: 'bookmark1',
                runs: [{
                  rPr: { color: { val: '0563C1' }, underline: 'single' },
                  content: [{ type: 'text', text: '内部リンク' }],
                }],
              },
            },
          ],
        },
      },
    ],
    sections: [
      {
        pgSz: { w: 11906, h: 16838 },  // A4
        pgMar: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720 },
        docGrid: { linePitch: 360 },
      },
    ],
    headersFooters: [],
    relationships: [],
  };
}

// ─── Test Suite ─────────────────────────────────────────────

describe('Native DOCX Engine', () => {
  let tmpDir: string;
  let outputPath: string;
  let files: Map<string, string>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(pathResolver.sharedTmp('docx-test-')));
    outputPath = path.join(tmpDir, 'test.docx');
    const protocol = createTestProtocol();
    await generateNativeDocx(protocol, outputPath);
    files = extractDocx(outputPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════
  // OOXML Spec Compliance
  // ═══════════════════════════════════════════════════════════

  describe('OOXML Spec Compliance', () => {

    it('should contain all required package parts', () => {
      const required = [
        '[Content_Types].xml',
        '_rels/.rels',
        'word/document.xml',
        'word/_rels/document.xml.rels',
        'word/styles.xml',
        'word/fontTable.xml',
        'word/theme/theme1.xml',
        'docProps/core.xml',
        'docProps/app.xml',
      ];
      for (const part of required) {
        expect(files.has(part), `Missing required part: ${part}`).toBe(true);
      }
    });

    it('should include numbering.xml when numbering definitions exist', () => {
      expect(files.has('word/numbering.xml')).toBe(true);
    });

    it('Content_Types should declare all required content types', () => {
      const ct = files.get('[Content_Types].xml')!;
      expect(ct).toContain('wordprocessingml.document.main+xml');
      expect(ct).toContain('wordprocessingml.styles+xml');
      expect(ct).toContain('wordprocessingml.fontTable+xml');
      expect(ct).toContain('theme+xml');
      expect(ct).toContain('core-properties+xml');
      expect(ct).toContain('wordprocessingml.numbering+xml');
    });

    it('global .rels should reference document.xml', () => {
      const rels = files.get('_rels/.rels')!;
      expect(rels).toContain('word/document.xml');
      expect(rels).toContain('officeDocument');
    });

    it('document.xml.rels should reference styles, theme, fontTable', () => {
      const rels = files.get('word/_rels/document.xml.rels')!;
      expect(rels).toContain('/styles');
      expect(rels).toContain('/theme');
      expect(rels).toContain('/fontTable');
    });

    it('document.xml should have proper namespace declarations', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('xmlns:w=');
      expect(doc).toContain('xmlns:r=');
      expect(doc).toContain('<w:body>');
      expect(doc).toContain('</w:body>');
      expect(doc).toContain('</w:document>');
    });

    it('document.xml should end with <w:sectPr>', () => {
      const doc = files.get('word/document.xml')!;
      // sectPr should be inside body, before </w:body>
      expect(doc).toMatch(/<w:sectPr>[\s\S]*<\/w:sectPr>\s*<\/w:body>/);
    });

    it('sectPr should contain page size and margins', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('w:pgSz');
      expect(doc).toContain('w:w="11906"'); // A4 width
      expect(doc).toContain('w:h="16838"'); // A4 height
      expect(doc).toContain('w:pgMar');
    });

    it('styles.xml should contain docDefaults', () => {
      const styles = files.get('word/styles.xml')!;
      expect(styles).toContain('<w:docDefaults>');
      expect(styles).toContain('<w:rPrDefault>');
      expect(styles).toContain('<w:pPrDefault>');
    });

    it('styles.xml should contain Normal style definition', () => {
      const styles = files.get('word/styles.xml')!;
      expect(styles).toContain('w:styleId="Normal"');
      expect(styles).toContain('w:default="1"');
    });

    it('styles.xml should contain heading styles', () => {
      const styles = files.get('word/styles.xml')!;
      expect(styles).toContain('w:styleId="Heading1"');
      expect(styles).toContain('w:styleId="Heading2"');
    });

    it('text content should be wrapped in <w:t> with xml:space="preserve"', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('xml:space="preserve"');
      expect(doc).toContain('<w:t xml:space="preserve">テスト文書タイトル</w:t>');
    });

    it('bold run should have <w:b/> in run properties', () => {
      const doc = files.get('word/document.xml')!;
      // Find a run with bold
      const boldRuns = doc.match(/<w:r>[\s\S]*?<w:b\/>[\s\S]*?<\/w:r>/g) || [];
      expect(boldRuns.length).toBeGreaterThan(0);
    });

    it('colored text should have <w:color> element', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('w:val="FF0000"');
    });

    it('line break should produce <w:br/>', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('<w:br/>');
    });

    it('numbered paragraphs should have <w:numPr>', () => {
      const doc = files.get('word/document.xml')!;
      const numPrs = doc.match(/<w:numPr>/g) || [];
      expect(numPrs.length).toBe(2); // Two bullet items
      expect(doc).toContain('<w:ilvl w:val="0"/>');
      expect(doc).toContain('<w:numId w:val="1"/>');
    });

    it('numbering.xml should contain abstractNum and num definitions', () => {
      const numbering = files.get('word/numbering.xml')!;
      expect(numbering).toContain('<w:abstractNum');
      expect(numbering).toContain('w:abstractNumId="0"');
      expect(numbering).toContain('<w:num w:numId="1"');
      expect(numbering).toContain('<w:numFmt w:val="bullet"');
    });

    it('table should have proper structure: tbl > tblPr > tblGrid > tr > tc', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('<w:tbl>');
      expect(doc).toContain('<w:tblPr>');
      expect(doc).toContain('<w:tblGrid>');
      expect(doc).toContain('<w:gridCol');
      expect(doc).toContain('<w:tr>');
      expect(doc).toContain('<w:tc>');
      expect(doc).toContain('</w:tbl>');
    });

    it('table should have correct number of columns in grid', () => {
      const doc = files.get('word/document.xml')!;
      const gridCols = doc.match(/<w:gridCol/g) || [];
      expect(gridCols.length).toBe(3);
    });

    it('table header row should have <w:tblHeader/>', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('<w:tblHeader/>');
    });

    it('table cell shading should use <w:shd> element', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('w:fill="232F3E"');
    });

    it('table cells should contain at least one <w:p>', () => {
      const doc = files.get('word/document.xml')!;
      const cells = doc.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell, 'Table cell must contain <w:p>').toMatch(/<w:p[>/]/);
      }
    });

    it('hyperlink should have anchor attribute', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('<w:hyperlink');
      expect(doc).toContain('w:anchor="bookmark1"');
      expect(doc).toContain('内部リンク');
    });

    it('table borders should be properly structured', () => {
      const doc = files.get('word/document.xml')!;
      expect(doc).toContain('<w:tblBorders>');
      expect(doc).toContain('w:val="single"');
      expect(doc).toContain('<w:insideH');
      expect(doc).toContain('<w:insideV');
    });

    it('fontTable.xml should contain font definitions', () => {
      const fontTable = files.get('word/fontTable.xml')!;
      expect(fontTable).toContain('<w:fonts');
      expect(fontTable).toContain('w:name="Calibri"');
      expect(fontTable).toContain('w:name="Times New Roman"');
      expect(fontTable).toContain('w:name="MS Gothic"');
    });

    it('theme should have valid effectStyleLst', () => {
      const theme = files.get('word/theme/theme1.xml')!;
      expect(theme).toContain('<a:effectStyleLst>');
      expect(theme).toContain('<a:effectStyle>');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Round-Trip Fidelity
  // ═══════════════════════════════════════════════════════════

  describe('Round-Trip Fidelity', () => {
    let originalProtocol: DocxDesignProtocol;
    let roundTrippedProtocol: DocxDesignProtocol;
    let roundTripPath: string;

    beforeAll(async () => {
      originalProtocol = createTestProtocol();
      const gen1Path = path.join(tmpDir, 'rt_gen1.docx');
      await generateNativeDocx(originalProtocol, gen1Path);

      const extracted = await distillDocxDesign(gen1Path);

      roundTripPath = path.join(tmpDir, 'rt_gen2.docx');
      await generateNativeDocx(extracted, roundTripPath);

      roundTrippedProtocol = await distillDocxDesign(roundTripPath);
    });

    it('should produce a valid DOCX file after round-trip', () => {
      expect(fs.existsSync(roundTripPath)).toBe(true);
      const stat = fs.statSync(roundTripPath);
      expect(stat.size).toBeGreaterThan(1000);
    });

    it('should preserve body block count', () => {
      expect(roundTrippedProtocol.body.length).toBe(originalProtocol.body.length);
    });

    it('should preserve heading text content', () => {
      const getFirstText = (block: DocxDesignProtocol['body'][0]): string => {
        if (block.type !== 'paragraph') return '';
        for (const pc of block.paragraph.content) {
          if (pc.type === 'run') {
            for (const c of pc.run.content) {
              if (c.type === 'text') return c.text;
            }
          }
        }
        return '';
      };
      const origHeading = getFirstText(originalProtocol.body[0]);
      const rtHeading = getFirstText(roundTrippedProtocol.body[0]);
      expect(rtHeading).toBe(origHeading);
    });

    it('should preserve table structure', () => {
      const origTables = originalProtocol.body.filter(b => b.type === 'table');
      const rtTables = roundTrippedProtocol.body.filter(b => b.type === 'table');
      expect(rtTables.length).toBe(origTables.length);
      if (origTables.length > 0 && rtTables.length > 0) {
        expect(rtTables[0].table.rows.length).toBe(origTables[0].table.rows.length);
        expect(rtTables[0].table.rows[0].cells.length).toBe(origTables[0].table.rows[0].cells.length);
      }
    });

    it('should preserve section properties (page size)', () => {
      expect(roundTrippedProtocol.sections.length).toBeGreaterThan(0);
      const origSect = originalProtocol.sections[0];
      const rtSect = roundTrippedProtocol.sections[0];
      if (origSect.pgSz && rtSect.pgSz) {
        expect(rtSect.pgSz.w).toBe(origSect.pgSz.w);
        expect(rtSect.pgSz.h).toBe(origSect.pgSz.h);
      }
    });

    it('should preserve style definitions count', () => {
      // Round-trip may add extra styles from Word's default inference,
      // but should have at least as many as the original
      expect(roundTrippedProtocol.styles.definitions.length)
        .toBeGreaterThanOrEqual(originalProtocol.styles.definitions.length);
    });

    it('round-tripped DOCX should pass basic OOXML compliance', () => {
      const rtFiles = extractDocx(roundTripPath);
      // All required parts present
      expect(rtFiles.has('[Content_Types].xml')).toBe(true);
      expect(rtFiles.has('word/document.xml')).toBe(true);
      expect(rtFiles.has('word/styles.xml')).toBe(true);
      // Document has proper structure
      const doc = rtFiles.get('word/document.xml')!;
      expect(doc).toContain('<w:body>');
      expect(doc).toContain('</w:body>');
      // Table cells have paragraphs
      const cells = doc.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
      for (const cell of cells) {
        expect(cell).toMatch(/<w:p[>/]/);
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Edge Cases
  // ═══════════════════════════════════════════════════════════

  describe('Edge Cases', () => {

    it('should generate valid DOCX without numbering', async () => {
      const protocol = createTestProtocol();
      delete protocol.numbering;
      // Remove bullet paragraphs
      protocol.body = protocol.body.filter(b =>
        b.type !== 'paragraph' || !b.paragraph.pPr?.numPr
      );

      const noNumPath = path.join(tmpDir, 'no_numbering.docx');
      await generateNativeDocx(protocol, noNumPath);
      const noNumFiles = extractDocx(noNumPath);

      expect(noNumFiles.has('word/document.xml')).toBe(true);
      expect(noNumFiles.has('word/numbering.xml')).toBe(false);

      const ct = noNumFiles.get('[Content_Types].xml')!;
      expect(ct).not.toContain('numbering+xml');
    });

    it('should handle empty table cells (must still have <w:p>)', async () => {
      const protocol: DocxDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        theme: { colors: { dk1: '000000', lt1: 'FFFFFF', accent1: '5B9BD5' } },
        styles: { definitions: [{ styleId: 'Normal', type: 'paragraph', name: 'Normal', isDefault: true }] },
        body: [{
          type: 'table',
          table: {
            tblGrid: [5000],
            rows: [{
              cells: [{
                content: [],  // Empty cell — engine should add <w:p/>
              }],
            }],
          },
        }],
        sections: [{ pgSz: { w: 11906, h: 16838 } }],
        headersFooters: [],
        relationships: [],
      };

      const emptyPath = path.join(tmpDir, 'empty_cell.docx');
      await generateNativeDocx(protocol, emptyPath);
      const emptyFiles = extractDocx(emptyPath);
      const doc = emptyFiles.get('word/document.xml')!;

      const cells = doc.match(/<w:tc>[\s\S]*?<\/w:tc>/g) || [];
      expect(cells.length).toBe(1);
      expect(cells[0]).toMatch(/<w:p\s*\/>/);
    });

    it('should preserve intermediate section breaks (multi-section)', async () => {
      const protocol: DocxDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        theme: { colors: { dk1: '000000', lt1: 'FFFFFF', accent1: '5B9BD5' } },
        styles: { definitions: [{ styleId: 'Normal', type: 'paragraph', name: 'Normal', isDefault: true }] },
        body: [
          // Section 1 content
          {
            type: 'paragraph',
            paragraph: {
              content: [{ type: 'run', run: { content: [{ type: 'text', text: 'セクション1の内容' }] } }],
            },
          },
          // Section break paragraph (intermediate sectPr in pPr)
          {
            type: 'paragraph',
            paragraph: {
              pPr: {
                sectPr: {
                  pgSz: { w: 16838, h: 11906, orient: 'landscape' },
                  pgMar: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720 },
                },
              },
              content: [],
            },
          },
          // Section 2 content (landscape)
          {
            type: 'paragraph',
            paragraph: {
              content: [{ type: 'run', run: { content: [{ type: 'text', text: 'セクション2（横向き）' }] } }],
            },
          },
        ],
        sections: [
          // Final section (portrait)
          {
            pgSz: { w: 11906, h: 16838 },
            pgMar: { top: 1440, right: 1440, bottom: 1440, left: 1440, header: 720, footer: 720 },
          },
        ],
        headersFooters: [],
        relationships: [],
      };

      const msPath = path.join(tmpDir, 'multi_section.docx');
      await generateNativeDocx(protocol, msPath);
      const msFiles = extractDocx(msPath);
      const doc = msFiles.get('word/document.xml')!;

      // Should have TWO sectPr: one inside pPr (intermediate) and one at body level (final)
      const allSectPrs = doc.match(/<w:sectPr>/g) || [];
      expect(allSectPrs.length).toBe(2);

      // Intermediate sectPr should be inside pPr
      expect(doc).toMatch(/<w:pPr>[\s\S]*?<w:sectPr>[\s\S]*?<\/w:sectPr>[\s\S]*?<\/w:pPr>/);

      // Landscape orientation should appear
      expect(doc).toContain('w:orient="landscape"');
      expect(doc).toContain('w:w="16838"'); // Landscape width

      // Round-trip: extract and verify sections are preserved
      const { distillDocxDesign } = await import('../../docx-utils.js');
      const extracted = await distillDocxDesign(msPath);

      // sections array should have 1 (body-level final section only)
      expect(extracted.sections.length).toBe(1);
      // Intermediate section should be in paragraph pPr
      const sectBreakPara = extracted.body.find(
        b => b.type === 'paragraph' && b.paragraph.pPr?.sectPr
      );
      expect(sectBreakPara).toBeDefined();
      expect( (sectBreakPara as any)!.paragraph.pPr!.sectPr!.pgSz?.orient).toBe('landscape');
    });

    it('should escape XML special characters in text', async () => {
      const protocol: DocxDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        theme: { colors: { dk1: '000000', lt1: 'FFFFFF', accent1: '5B9BD5' } },
        styles: { definitions: [{ styleId: 'Normal', type: 'paragraph', name: 'Normal', isDefault: true }] },
        body: [{
          type: 'paragraph',
          paragraph: {
            content: [{
              type: 'run',
              run: { content: [{ type: 'text', text: 'A < B & C > D "quoted"' }] },
            }],
          },
        }],
        sections: [],
        headersFooters: [],
        relationships: [],
      };

      const escPath = path.join(tmpDir, 'escaped.docx');
      await generateNativeDocx(protocol, escPath);
      const escFiles = extractDocx(escPath);
      const doc = escFiles.get('word/document.xml')!;

      expect(doc).toContain('A &lt; B &amp; C &gt; D &quot;quoted&quot;');
      expect(doc).not.toContain('A < B');
    });

    it('should reject empty body', async () => {
      const protocol: DocxDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        theme: { colors: {} },
        styles: { definitions: [] },
        body: [],
        sections: [],
        headersFooters: [],
        relationships: [],
      };
      await expect(
        generateNativeDocx(protocol, path.join(tmpDir, 'empty.docx'))
      ).rejects.toThrow('at least one body block');
    });

    it('should reject non-existent output directory', async () => {
      const protocol = createTestProtocol();
      await expect(
        generateNativeDocx(protocol, '/nonexistent/dir/test.docx')
      ).rejects.toThrow('output directory');
    });

    it('should generate Content_Types with header/footer overrides', async () => {
      const protocol: DocxDesignProtocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        theme: { colors: { dk1: '000000', lt1: 'FFFFFF', accent1: '5B9BD5' } },
        styles: { definitions: [{ styleId: 'Normal', type: 'paragraph', name: 'Normal', isDefault: true }] },
        body: [{
          type: 'paragraph',
          paragraph: { content: [{ type: 'run', run: { content: [{ type: 'text', text: 'Test' }] } }] },
        }],
        sections: [{
          pgSz: { w: 11906, h: 16838 },
          headerRefs: [{ type: 'default', rId: 'rId10' }],
          footerRefs: [{ type: 'default', rId: 'rId11' }],
        }],
        headersFooters: [
          {
            type: 'header', rId: 'rId10', headerType: 'default',
            content: [{ type: 'paragraph', paragraph: { content: [{ type: 'run', run: { content: [{ type: 'text', text: 'ヘッダー' }] } }] } }],
          },
          {
            type: 'footer', rId: 'rId11', headerType: 'default',
            content: [{ type: 'paragraph', paragraph: { content: [{ type: 'run', run: { content: [{ type: 'text', text: 'フッター' }] } }] } }],
          },
        ],
        relationships: [
          { id: 'rId10', type: 'header', target: 'header1.xml' },
          { id: 'rId11', type: 'footer', target: 'footer1.xml' },
        ],
      };

      const hfPath = path.join(tmpDir, 'header_footer.docx');
      await generateNativeDocx(protocol, hfPath);
      const hfFiles = extractDocx(hfPath);

      // Content_Types should have header and footer overrides
      const ct = hfFiles.get('[Content_Types].xml')!;
      expect(ct).toContain('header+xml');
      expect(ct).toContain('footer+xml');
      expect(ct).toContain('/word/header1.xml');
      expect(ct).toContain('/word/footer1.xml');

      // Header and footer parts should exist
      expect(hfFiles.has('word/header1.xml')).toBe(true);
      expect(hfFiles.has('word/footer1.xml')).toBe(true);

      // Header should contain text
      const headerXml = hfFiles.get('word/header1.xml')!;
      expect(headerXml).toContain('ヘッダー');
      const footerXml = hfFiles.get('word/footer1.xml')!;
      expect(footerXml).toContain('フッター');
    });
  });
});
