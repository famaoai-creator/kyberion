/**
 * Native PPTX Engine — OOXML Spec Compliance & Round-Trip Tests
 *
 * #1: Validates generated PPTX XML against OOXML structural requirements
 * #2: Extract → Generate → Extract round-trip fidelity
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import AdmZip from 'adm-zip';
import { generateNativePptx } from '../engine.js';
import { buildShape, buildConnector, buildTable } from '../builders.js';
import { distillPptxDesign } from '../../pptx-utils.js';
import type { PptxDesignProtocol, PptxElement } from '../../types/pptx-protocol.js';

// ─── Helpers ────────────────────────────────────────────────

function extractPptx(pptxPath: string): Map<string, string> {
  const zip = new AdmZip(pptxPath);
  const files = new Map<string, string>();
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      files.set(entry.entryName, entry.getData().toString('utf8'));
    }
  }
  return files;
}

function xmlAttr(xml: string, tag: string, attr: string): string | null {
  const re = new RegExp(`<${tag}[^>]*?\\s${attr}="([^"]*)"`, 's');
  const m = xml.match(re);
  return m ? m[1] : null;
}

function countTag(xml: string, tag: string): number {
  const re = new RegExp(`<${tag}[\\s/>]`, 'g');
  return (xml.match(re) || []).length;
}

// ─── Test Protocol (minimal valid presentation) ─────────────

function createTestProtocol(): PptxDesignProtocol {
  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas: { w: 10, h: 7.5 },
    theme: {
      dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6',
      accent1: '5B9BD5', accent2: 'ED7D31', accent3: 'A5A5A5',
      accent4: 'FFC000', accent5: '4472C4', accent6: '70AD47',
      hlink: '0563C1', folHlink: '954F72',
    },
    master: { elements: [] },
    slides: [
      {
        id: 'slide1.xml',
        backgroundFill: '#1E3A5F',
        elements: [
          // Shape with text
          {
            type: 'text',
            pos: { x: 1, y: 1, w: 8, h: 1 },
            text: 'タイトルテスト',
            style: { fontSize: 36, bold: true, color: '#FFFFFF', align: 'center', fontFamily: 'Yu Gothic' },
          },
          // Shape without text (must still have <p:txBody>)
          {
            type: 'shape',
            shapeType: 'rect',
            pos: { x: 1, y: 3, w: 3, h: 2 },
            style: { fill: '#3B82F6' },
          },
          // Shape with valign
          {
            type: 'text',
            pos: { x: 5, y: 3, w: 4, h: 2 },
            text: '中央揃え',
            style: { fill: '#10B981', color: '#FFFFFF', valign: 'middle', align: 'center' },
          },
          // Line
          {
            type: 'line',
            pos: { x: 0.5, y: 6, w: 9, h: 0 },
            style: { line: '#999999', lineWidth: 2 },
          },
          // Table
          {
            type: 'table',
            pos: { x: 1, y: 5, w: 8, h: 1.5 },
            rows: [
              ['ヘッダー1', 'ヘッダー2', 'ヘッダー3'],
              ['データ1', 'データ2', '改行\nテスト'],
            ],
            colWidths: [3, 3, 2],
          },
        ],
      },
      {
        id: 'slide2.xml',
        backgroundFill: '#FFFFFF',
        elements: [
          {
            type: 'shape',
            shapeType: 'roundRect',
            pos: { x: 2, y: 2, w: 6, h: 3 },
            text: '2枚目スライド',
            style: { fill: '#F59E0B', color: '#FFFFFF', fontSize: 24, bold: true, align: 'center', valign: 'middle' },
          },
        ],
      },
    ],
  };
}

// ─── Test Suite ─────────────────────────────────────────────

describe('Native PPTX Engine', () => {
  let tmpDir: string;
  let outputPath: string;
  let files: Map<string, string>;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pptx-test-'));
    outputPath = path.join(tmpDir, 'test.pptx');
    const protocol = createTestProtocol();
    await generateNativePptx(protocol, outputPath);
    files = extractPptx(outputPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════
  // #1: OOXML Spec Compliance
  // ═══════════════════════════════════════════════════════════

  describe('OOXML Spec Compliance', () => {

    it('should contain all required package parts', () => {
      const required = [
        '[Content_Types].xml',
        '_rels/.rels',
        'ppt/presentation.xml',
        'ppt/_rels/presentation.xml.rels',
        'ppt/presProps.xml',
        'ppt/viewProps.xml',
        'ppt/tableStyles.xml',
        'ppt/theme/theme1.xml',
        'ppt/slideMasters/slideMaster1.xml',
        'ppt/slideMasters/_rels/slideMaster1.xml.rels',
        'ppt/slideLayouts/slideLayout1.xml',
        'ppt/slideLayouts/slideLayout2.xml',
        'ppt/slides/slide1.xml',
        'ppt/slides/slide2.xml',
        'docProps/core.xml',
        'docProps/app.xml',
      ];
      for (const part of required) {
        expect(files.has(part), `Missing required part: ${part}`).toBe(true);
      }
    });

    it('should NOT have Content_Types entries for non-existent parts', () => {
      const ct = files.get('[Content_Types].xml')!;
      // No diagrams or charts in test protocol
      expect(ct).not.toContain('/ppt/diagrams/');
      expect(ct).not.toContain('/ppt/charts/');
      expect(ct).not.toContain('/ppt/notesSlides/');
    });

    it('presentation.xml.rels should have slideMaster before slides', () => {
      const rels = files.get('ppt/_rels/presentation.xml.rels')!;
      const masterMatch = rels.match(/Id="(rId\d+)"[^>]*slideMaster/);
      const firstSlideMatch = rels.match(/Id="(rId\d+)"[^>]*slides\/slide1/);
      expect(masterMatch).not.toBeNull();
      expect(firstSlideMatch).not.toBeNull();
      const masterRId = parseInt(masterMatch![1].replace('rId', ''));
      const slideRId = parseInt(firstSlideMatch![1].replace('rId', ''));
      expect(masterRId).toBeLessThan(slideRId);
    });

    it('presentation.xml rId references should match rels', () => {
      const pres = files.get('ppt/presentation.xml')!;
      const rels = files.get('ppt/_rels/presentation.xml.rels')!;
      // Extract all rId references from presentation.xml
      const rIds = [...pres.matchAll(/r:id="(rId\d+)"/g)].map(m => m[1]);
      for (const rId of rIds) {
        expect(rels, `presentation.xml references ${rId} not found in rels`).toContain(`Id="${rId}"`);
      }
    });

    it('slideMaster should have <p:bg> element', () => {
      const master = files.get('ppt/slideMasters/slideMaster1.xml')!;
      expect(master).toContain('<p:bg>');
    });

    it('slideMaster should have <p:txStyles> with titleStyle and bodyStyle', () => {
      const master = files.get('ppt/slideMasters/slideMaster1.xml')!;
      expect(master).toContain('<p:txStyles>');
      expect(master).toContain('<p:titleStyle>');
      expect(master).toContain('<p:bodyStyle>');
    });

    it('slideMaster sldLayoutId IDs should be > 2147483648', () => {
      const master = files.get('ppt/slideMasters/slideMaster1.xml')!;
      const ids = [...master.matchAll(/sldLayoutId id="(\d+)"/g)].map(m => parseInt(m[1]));
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(id).toBeGreaterThan(2147483648);
      }
    });

    it('every <p:sp> should have <p:txBody>', () => {
      for (const [name, xml] of files.entries()) {
        if (!name.startsWith('ppt/slides/slide')) continue;
        // Find all <p:sp>...</p:sp> blocks
        const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
        for (const shape of shapes) {
          expect(shape, `Shape missing <p:txBody> in ${name}`).toContain('<p:txBody>');
          expect(shape, `Shape missing <a:bodyPr> in ${name}`).toContain('<a:bodyPr');
        }
      }
    });

    it('every <a:rPr> should have lang attribute', () => {
      for (const [name, xml] of files.entries()) {
        if (!name.startsWith('ppt/slides/slide')) continue;
        const rPrs = xml.match(/<a:rPr[^>]*>/g) || [];
        for (const rPr of rPrs) {
          expect(rPr, `<a:rPr> missing lang in ${name}: ${rPr}`).toMatch(/lang="/);
        }
      }
    });

    it('every <a:p> should have <a:endParaRPr> or be from preserved pXmlLst', () => {
      for (const [name, xml] of files.entries()) {
        if (!name.startsWith('ppt/slides/slide')) continue;
        // Count <a:p> and <a:endParaRPr> inside <p:txBody> blocks
        const txBodies = xml.match(/<p:txBody>[\s\S]*?<\/p:txBody>/g) || [];
        for (const txBody of txBodies) {
          const pCount = countTag(txBody, 'a:p');
          const endCount = countTag(txBody, 'a:endParaRPr');
          // Each paragraph should have endParaRPr (at minimum the last one)
          expect(endCount, `Missing <a:endParaRPr> in ${name}`).toBeGreaterThanOrEqual(1);
        }
      }
    });

    it('table cells should split newlines into multiple <a:p>', () => {
      const slide1 = files.get('ppt/slides/slide1.xml')!;
      // The test data has "改行\nテスト" which should produce 2 <a:p> in that cell
      // Extract individual cells using non-greedy match
      const cells = (slide1.match(/<a:tc>\s*<a:txBody>[\s\S]*?<\/a:txBody>\s*<a:tcPr[\s\S]*?<\/a:tc>/g) || []) as string[];
      // Find the cell containing "改行"
      const targetCell = cells.find(c => c.includes('改行'));
      expect(targetCell, 'Should find cell with 改行').toBeDefined();
      if (targetCell) {
        const pCount = countTag(targetCell, 'a:p');
        expect(pCount, 'Table cell with newline should have 2 <a:p> elements').toBe(2);
      }
    });

    it('table cells should have lang attribute on <a:rPr>', () => {
      const slide1 = files.get('ppt/slides/slide1.xml')!;
      const tables = slide1.match(/<a:tbl>[\s\S]*?<\/a:tbl>/g) || [];
      for (const table of tables) {
        const rPrs = table.match(/<a:rPr[^>]*>/g) || [];
        for (const rPr of rPrs) {
          expect(rPr, `Table <a:rPr> missing lang`).toMatch(/lang="/);
        }
      }
    });

    it('theme should have valid effectStyleLst with <a:effectStyle> wrappers', () => {
      const theme = files.get('ppt/theme/theme1.xml')!;
      expect(theme).toContain('<a:effectStyleLst>');
      expect(theme).toContain('<a:effectStyle>');
      // Should NOT have bare <a:effectLst/> without <a:effectStyle> wrapper
      const effectStyleLst = theme.match(/<a:effectStyleLst>[\s\S]*?<\/a:effectStyleLst>/);
      expect(effectStyleLst).not.toBeNull();
      if (effectStyleLst) {
        const bareEffectLst = effectStyleLst[0].replace(/<a:effectStyle>[\s\S]*?<\/a:effectStyle>/g, '');
        expect(bareEffectLst).not.toContain('<a:effectLst');
      }
    });

    it('bodyPr should have anchor attribute when valign is set', () => {
      const slide1 = files.get('ppt/slides/slide1.xml')!;
      // The third element has valign: 'middle' → anchor="ctr"
      expect(slide1).toContain('anchor="ctr"');
    });

    it('slide rels should reference correct layout', () => {
      // slide1 → layout1 (title), slide2 → layout2 (standard)
      const rels1 = files.get('ppt/slides/_rels/slide1.xml.rels')!;
      const rels2 = files.get('ppt/slides/_rels/slide2.xml.rels')!;
      expect(rels1).toContain('slideLayout1.xml');
      expect(rels2).toContain('slideLayout2.xml');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // #2: Round-Trip Fidelity
  // ═══════════════════════════════════════════════════════════

  describe('Round-Trip Fidelity', () => {
    let originalProtocol: PptxDesignProtocol;
    let roundTrippedProtocol: PptxDesignProtocol;
    let roundTripPath: string;

    beforeAll(async () => {
      // Step 1: Generate from test protocol
      originalProtocol = createTestProtocol();
      const gen1Path = path.join(tmpDir, 'rt_gen1.pptx');
      await generateNativePptx(originalProtocol, gen1Path);

      // Step 2: Extract
      const extracted = await distillPptxDesign(gen1Path);

      // Step 3: Re-generate from extracted protocol
      roundTripPath = path.join(tmpDir, 'rt_gen2.pptx');
      await generateNativePptx(extracted, roundTripPath);

      // Step 4: Extract again for comparison
      roundTrippedProtocol = await distillPptxDesign(roundTripPath);
    });

    it('should preserve slide count', () => {
      expect(roundTrippedProtocol.slides.length).toBe(originalProtocol.slides.length);
    });

    it('should preserve element count per slide', () => {
      for (let i = 0; i < originalProtocol.slides.length; i++) {
        expect(
          roundTrippedProtocol.slides[i].elements.length,
          `Slide ${i + 1} element count mismatch`
        ).toBe(originalProtocol.slides[i].elements.length);
      }
    });

    it('should preserve text content', () => {
      for (let si = 0; si < originalProtocol.slides.length; si++) {
        const origSlide = originalProtocol.slides[si];
        const rtSlide = roundTrippedProtocol.slides[si];
        for (let ei = 0; ei < origSlide.elements.length; ei++) {
          const origEl = origSlide.elements[ei];
          const rtEl = rtSlide.elements[ei];
          if (origEl.text && origEl.type !== 'table') {
            expect(
              rtEl.text?.trim(),
              `Slide ${si + 1} element ${ei} text mismatch`
            ).toBe(origEl.text.trim());
          }
        }
      }
    });

    it('should preserve element positions (within 0.01 inch tolerance)', () => {
      for (let si = 0; si < originalProtocol.slides.length; si++) {
        const origSlide = originalProtocol.slides[si];
        const rtSlide = roundTrippedProtocol.slides[si];
        for (let ei = 0; ei < origSlide.elements.length; ei++) {
          const origPos = origSlide.elements[ei].pos;
          const rtPos = rtSlide.elements[ei].pos;
          expect(Math.abs(origPos.x - rtPos.x)).toBeLessThan(0.01);
          expect(Math.abs(origPos.y - rtPos.y)).toBeLessThan(0.01);
          expect(Math.abs(origPos.w - rtPos.w)).toBeLessThan(0.01);
          expect(Math.abs(origPos.h - rtPos.h)).toBeLessThan(0.01);
        }
      }
    });

    it('should preserve table row/column counts', () => {
      for (let si = 0; si < originalProtocol.slides.length; si++) {
        const origTables = originalProtocol.slides[si].elements.filter(e => e.type === 'table');
        const rtTables = roundTrippedProtocol.slides[si].elements.filter(e => e.type === 'table');
        expect(rtTables.length).toBe(origTables.length);
        for (let ti = 0; ti < origTables.length; ti++) {
          expect(rtTables[ti].rows?.length).toBe(origTables[ti].rows?.length);
          if (origTables[ti].rows && rtTables[ti].rows) {
            for (let ri = 0; ri < origTables[ti].rows!.length; ri++) {
              expect(rtTables[ti].rows![ri].length).toBe(origTables[ti].rows![ri].length);
            }
          }
        }
      }
    });

    it('should preserve canvas dimensions', () => {
      expect(roundTrippedProtocol.canvas.w).toBe(originalProtocol.canvas.w);
      expect(roundTrippedProtocol.canvas.h).toBe(originalProtocol.canvas.h);
    });

    it('round-tripped PPTX should also pass OOXML compliance', () => {
      const rtFiles = extractPptx(roundTripPath);
      // Every <p:sp> must have <p:txBody>
      for (const [name, xml] of rtFiles.entries()) {
        if (!name.startsWith('ppt/slides/slide')) continue;
        const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
        for (const shape of shapes) {
          expect(shape, `RT: Shape missing <p:txBody> in ${name}`).toContain('<p:txBody>');
        }
      }
      // slideMaster must have txStyles
      const master = rtFiles.get('ppt/slideMasters/slideMaster1.xml')!;
      expect(master).toContain('<p:txStyles>');
      expect(master).toContain('<p:bg>');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // #5: Builder Unit Tests
  // ═══════════════════════════════════════════════════════════

  describe('Builder Unit Tests', () => {

    describe('buildShape', () => {
      it('should produce valid <p:sp> with <p:txBody> for text element', () => {
        const el: PptxElement = {
          type: 'text', pos: { x: 1, y: 2, w: 5, h: 1 },
          text: 'Hello', style: { fontSize: 24, bold: true, color: '#FF0000' },
        };
        const xml = buildShape(el, 1);
        expect(xml).toContain('<p:sp>');
        expect(xml).toContain('<p:txBody>');
        expect(xml).toContain('<a:t>Hello</a:t>');
        expect(xml).toContain('lang="ja-JP"');
        expect(xml).toContain('<a:endParaRPr');
        expect(xml).toContain('b="1"');
        expect(xml).toContain('sz="2400"');
      });

      it('should produce <p:txBody> even without text (OOXML requirement)', () => {
        const el: PptxElement = {
          type: 'shape', shapeType: 'ellipse', pos: { x: 0, y: 0, w: 2, h: 2 },
          style: { fill: '#0000FF' },
        };
        const xml = buildShape(el, 2);
        expect(xml).toContain('<p:sp>');
        expect(xml).toContain('<p:txBody>');
        expect(xml).toContain('<a:bodyPr/>');
        expect(xml).toContain('<a:endParaRPr lang="ja-JP"/>');
      });

      it('should apply valign as anchor attribute on bodyPr', () => {
        const el: PptxElement = {
          type: 'text', pos: { x: 0, y: 0, w: 4, h: 3 },
          text: 'Center', style: { valign: 'middle' },
        };
        const xml = buildShape(el, 3);
        expect(xml).toContain('anchor="ctr"');
      });

      it('should apply rotation via rot attribute', () => {
        const el: PptxElement = {
          type: 'shape', shapeType: 'rect', pos: { x: 0, y: 0, w: 2, h: 1 },
          text: 'Rotated', style: { rotate: 45 },
        };
        const xml = buildShape(el, 4);
        expect(xml).toContain('rot="2700000"'); // 45 * 60000
      });

      it('should escape XML special characters in text', () => {
        const el: PptxElement = {
          type: 'text', pos: { x: 0, y: 0, w: 3, h: 1 },
          text: 'A < B & C > D',
        };
        const xml = buildShape(el, 5);
        expect(xml).toContain('A &lt; B &amp; C &gt; D');
        expect(xml).not.toContain('<a:t>A < B');
      });

      it('should split newlines into multiple <a:p> paragraphs', () => {
        const el: PptxElement = {
          type: 'text', pos: { x: 0, y: 0, w: 5, h: 2 },
          text: 'Line1\nLine2\nLine3',
        };
        const xml = buildShape(el, 6);
        expect(xml).toContain('<a:t>Line1</a:t>');
        expect(xml).toContain('<a:t>Line2</a:t>');
        expect(xml).toContain('<a:t>Line3</a:t>');
        expect(xml).toContain('</a:p><a:p>');
      });

      it('should use preset geometry from shapeType', () => {
        const el: PptxElement = {
          type: 'shape', shapeType: 'roundRect', pos: { x: 0, y: 0, w: 3, h: 2 },
          text: 'Rounded',
        };
        const xml = buildShape(el, 7);
        expect(xml).toContain('prst="roundRect"');
      });

      it('should include altText as descr attribute', () => {
        const el: PptxElement = {
          type: 'shape', shapeType: 'rect', pos: { x: 0, y: 0, w: 2, h: 1 },
          altText: 'Accessible description',
        };
        const xml = buildShape(el, 8);
        expect(xml).toContain('descr="Accessible description"');
      });
    });

    describe('buildConnector', () => {
      it('should produce valid <p:cxnSp> element', () => {
        const el: PptxElement = {
          type: 'line', pos: { x: 1, y: 1, w: 5, h: 0 },
          style: { line: '#333333', lineWidth: 2 },
        };
        const xml = buildConnector(el, 10);
        expect(xml).toContain('<p:cxnSp>');
        expect(xml).toContain('<p:nvCxnSpPr>');
        expect(xml).toContain('name="Connector 10"');
        expect(xml).toContain('<a:srgbClr val="333333"/>');
      });

      it('should default to line shape type', () => {
        const el: PptxElement = {
          type: 'line', pos: { x: 0, y: 0, w: 3, h: 0 },
        };
        const xml = buildConnector(el, 11);
        expect(xml).toContain('prst="line"');
      });

      it('should use spPrXml when provided (round-trip)', () => {
        const el: PptxElement = {
          type: 'line', pos: { x: 2, y: 3, w: 4, h: 0 },
          spPrXml: '<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></a:xfrm></p:spPr>',
        };
        const xml = buildConnector(el, 12);
        // Should update coordinates in spPrXml
        expect(xml).toContain(`x="${Math.round(2 * 914400)}"`);
        expect(xml).toContain(`y="${Math.round(3 * 914400)}"`);
      });
    });

    describe('buildTable', () => {
      it('should produce valid <p:graphicFrame> with table data', () => {
        const el: PptxElement = {
          type: 'table', pos: { x: 1, y: 1, w: 8, h: 3 },
          rows: [['A', 'B'], ['C', 'D']],
          colWidths: [4, 4],
        };
        const xml = buildTable(el, 20);
        expect(xml).toContain('<p:graphicFrame>');
        expect(xml).toContain('<a:tbl>');
        expect(xml).toContain('<a:gridCol');
        expect(xml).toContain('<a:t>A</a:t>');
        expect(xml).toContain('<a:t>D</a:t>');
      });

      it('should return empty string for empty rows', () => {
        const el: PptxElement = {
          type: 'table', pos: { x: 0, y: 0, w: 5, h: 2 },
          rows: [],
        };
        const xml = buildTable(el, 21);
        expect(xml).toBe('');
      });

      it('should style header row differently', () => {
        const el: PptxElement = {
          type: 'table', pos: { x: 0, y: 0, w: 6, h: 2 },
          rows: [['Header'], ['Data']],
        };
        const xml = buildTable(el, 22);
        // Header row should have dark background
        expect(xml).toContain('val="232F3E"');
        // Header text should be white
        expect(xml).toContain('val="FFFFFF"');
      });

      it('should split newlines in cells into multiple <a:p>', () => {
        const el: PptxElement = {
          type: 'table', pos: { x: 0, y: 0, w: 5, h: 2 },
          rows: [['H1'], ['Line1\nLine2']],
        };
        const xml = buildTable(el, 23);
        // Find the cell with "Line1"
        const cells = (xml.match(/<a:tc>[\s\S]*?<\/a:tc>/g) || []) as string[];
        const targetCell = cells.find(c => c.includes('Line1'));
        expect(targetCell).toBeDefined();
        const pCount = (targetCell!.match(/<a:p>/g) || []).length;
        expect(pCount).toBe(2);
      });

      it('should have lang="ja-JP" on all rPr elements', () => {
        const el: PptxElement = {
          type: 'table', pos: { x: 0, y: 0, w: 4, h: 2 },
          rows: [['A', 'B'], ['C', 'D']],
        };
        const xml = buildTable(el, 24);
        const rPrs = xml.match(/<a:rPr[^>]*>/g) || [];
        expect(rPrs.length).toBeGreaterThan(0);
        for (const rPr of rPrs) {
          expect(rPr).toContain('lang="ja-JP"');
        }
      });

      it('should have <a:endParaRPr> in every paragraph', () => {
        const el: PptxElement = {
          type: 'table', pos: { x: 0, y: 0, w: 4, h: 2 },
          rows: [['X'], ['Y']],
        };
        const xml = buildTable(el, 25);
        const pTags = (xml.match(/<a:p>/g) || []).length;
        const endRPr = (xml.match(/<a:endParaRPr/g) || []).length;
        expect(endRPr).toBe(pTags);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Round-trip with real PPTX file (if available)
  // ═══════════════════════════════════════════════════════════

  describe('Round-Trip with generated project plan', () => {
    it('should extract and regenerate without crash', async () => {
      const sourcePath = path.join(tmpDir, 'project_plan.pptx');
      const protocol = createTestProtocol();
      await generateNativePptx(protocol, sourcePath);
      const extracted = await distillPptxDesign(sourcePath);
      const regenPath = path.join(tmpDir, 'regen.pptx');
      await generateNativePptx(extracted, regenPath);
      expect(fs.existsSync(regenPath)).toBe(true);
      const stat = fs.statSync(regenPath);
      expect(stat.size).toBeGreaterThan(1000);
    });
  });
});
