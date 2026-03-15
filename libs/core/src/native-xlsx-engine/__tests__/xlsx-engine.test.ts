/**
 * Native XLSX Engine — OOXML Spec Compliance & Round-Trip Tests
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import { generateNativeXlsx } from '../engine';
import { distillXlsxDesign } from '../../xlsx-utils.js';
import type { XlsxDesignProtocol } from '../../types/xlsx-protocol.js';

// ─── Helpers ────────────────────────────────────────────────

function extractXlsx(xlsxPath: string): Map<string, string> {
  const zip = new AdmZip(xlsxPath);
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

// ─── Test Protocol ──────────────────────────────────────────

function createTestProtocol(): XlsxDesignProtocol {
  const fonts = [
    { name: 'Yu Gothic', size: 11, scheme: 'minor' as const },
    { name: 'Yu Gothic', size: 11, bold: true, color: { rgb: '#FFFFFF' } },
    { name: 'Yu Gothic', size: 11, color: { rgb: '#333333' } },
  ];
  const fills = [
    { patternType: 'none' as const },
    { patternType: 'gray125' as const },
    { patternType: 'solid' as const, fgColor: { rgb: '#1E3A5F' } },
    { patternType: 'solid' as const, fgColor: { rgb: '#FFFFFF' } },
    { patternType: 'solid' as const, fgColor: { rgb: '#D1FAE5' } },
  ];
  const borders = [
    {},
    { left: { style: 'thin' as const, color: { rgb: '#D1D5DB' } }, right: { style: 'thin' as const, color: { rgb: '#D1D5DB' } }, top: { style: 'thin' as const, color: { rgb: '#D1D5DB' } }, bottom: { style: 'thin' as const, color: { rgb: '#D1D5DB' } } },
  ];
  const cellXfs = [
    { font: fonts[0], fill: fills[0], border: borders[0] },
    { font: fonts[1], fill: fills[2], border: borders[1], alignment: { horizontal: 'center' as const, vertical: 'center' as const } },
    { font: fonts[2], fill: fills[3], border: borders[1], alignment: { vertical: 'center' as const, wrapText: true } },
  ];

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      colors: {
        dk1: '000000', lt1: 'FFFFFF', dk2: '1F2937', lt2: 'E5E7EB',
        accent1: '1E3A5F', accent2: '10B981', accent3: '3B82F6',
        accent4: 'F59E0B', accent5: '8B5CF6', accent6: 'EF4444',
        hlink: '2563EB', folHlink: '7C3AED',
      },
    },
    styles: {
      fonts,
      fills,
      borders,
      numFmts: [],
      cellXfs,
      dxfs: [
        { font: { bold: true, color: { rgb: '#006600' } }, fill: { patternType: 'solid', fgColor: { rgb: '#D1FAE5' }, bgColor: { rgb: '#D1FAE5' } } },
      ],
      namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0, style: cellXfs[0] }],
    },
    sharedStrings: [],
    definedNames: [],
    sheets: [{
      id: 'sheet1',
      name: 'テストシート',
      state: 'visible',
      dimension: 'A1:E5',
      sheetView: {
        tabSelected: true,
        zoomScale: 100,
        frozenRows: 1,
        frozenCols: 1,
      },
      columns: [
        { min: 1, max: 1, width: 10, customWidth: true },
        { min: 2, max: 2, width: 20, customWidth: true },
        { min: 3, max: 3, width: 15, customWidth: true },
        { min: 4, max: 4, width: 12, customWidth: true },
        { min: 5, max: 5, width: 12, customWidth: true },
      ],
      rows: [
        {
          index: 1, height: 24, customHeight: true,
          cells: [
            { ref: 'A1', type: 's', value: 'No', styleIndex: 1 },
            { ref: 'B1', type: 's', value: '項目名', styleIndex: 1 },
            { ref: 'C1', type: 's', value: '値', styleIndex: 1 },
            { ref: 'D1', type: 's', value: '状態', styleIndex: 1 },
            { ref: 'E1', type: 's', value: '備考', styleIndex: 1 },
          ],
        },
        {
          index: 2,
          cells: [
            { ref: 'A2', type: 'n', value: 1, styleIndex: 2 },
            { ref: 'B2', type: 's', value: 'テスト項目A', styleIndex: 2 },
            { ref: 'C2', type: 'n', value: 100, styleIndex: 2 },
            { ref: 'D2', type: 's', value: '完了', styleIndex: 2 },
            { ref: 'E2', type: 's', value: '', styleIndex: 2 },
          ],
        },
        {
          index: 3,
          cells: [
            { ref: 'A3', type: 'n', value: 2, styleIndex: 2 },
            { ref: 'B3', type: 's', value: 'テスト項目B', styleIndex: 2 },
            { ref: 'C3', type: 'n', value: 200, styleIndex: 2 },
            { ref: 'D3', type: 's', value: '進行中', styleIndex: 2 },
            { ref: 'E3', type: 's', value: 'メモ', styleIndex: 2 },
          ],
        },
      ],
      mergeCells: [{ ref: 'D2:E2' }],
      tables: [],
      conditionalFormats: [{
        sqref: 'A2:E3',
        rules: [
          { type: 'expression', priority: 1, dxfId: 0, formula: '$D2="完了"' },
        ],
      }],
      dataValidations: [{
        sqref: 'D2:D10',
        type: 'list',
        showDropDown: false,
        showErrorMessage: true,
        formula1: '"未着手,進行中,完了"',
      }],
      pageSetup: {
        orientation: 'landscape',
        paperSize: 9,
      },
    }],
  };
}

// ─── Test Suite ─────────────────────────────────────────────

describe('Native XLSX Engine', () => {
  let tmpDir: string;
  let outputPath: string;
  let files: Map<string, string>;

  beforeAll(async () => {
    const tmpRoot = path.join(process.cwd(), 'active/shared/tmp');
    fs.mkdirSync(tmpRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'xlsx-test-'));
    outputPath = path.join(tmpDir, 'test.xlsx');
    await generateNativeXlsx(createTestProtocol(), outputPath);
    files = extractXlsx(outputPath);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════
  // #1: OOXML Spec Compliance
  // ═══════════════════════════════════════════════════════════

  describe('OOXML Spec Compliance', () => {

    it('should contain all required parts', () => {
      const required = [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
        'xl/styles.xml',
        'xl/theme/theme1.xml',
        'xl/worksheets/sheet1.xml',
        'xl/sharedStrings.xml',
      ];
      for (const part of required) {
        expect(files.has(part), `Missing: ${part}`).toBe(true);
      }
    });

    it('styles.xml should have correct fill count (min 2: none + gray125)', () => {
      const styles = files.get('xl/styles.xml')!;
      const fillCount = styles.match(/fills count="(\d+)"/);
      expect(fillCount).not.toBeNull();
      expect(parseInt(fillCount![1])).toBeGreaterThanOrEqual(2);
    });

    it('styles.xml should have dxfs with correct count', () => {
      const styles = files.get('xl/styles.xml')!;
      expect(styles).toContain('<dxfs count="1">');
      expect(styles).toContain('<dxf>');
    });

    it('styles.xml should have RGB colors with alpha prefix', () => {
      const styles = files.get('xl/styles.xml')!;
      // All rgb values should be 8 chars (AARRGGBB)
      const rgbValues = [...styles.matchAll(/rgb="([A-Fa-f0-9]+)"/g)].map(m => m[1]);
      for (const rgb of rgbValues) {
        expect(rgb.length, `RGB ${rgb} should be 8 chars`).toBe(8);
      }
    });

    it('worksheet should have frozen pane with correct topLeftCell', () => {
      const sheet = files.get('xl/worksheets/sheet1.xml')!;
      expect(sheet).toContain('<pane');
      // frozenRows=1, frozenCols=1 → topLeftCell="B2"
      expect(sheet).toContain('topLeftCell="B2"');
    });

    it('worksheet should have pageMargins', () => {
      const sheet = files.get('xl/worksheets/sheet1.xml')!;
      expect(sheet).toContain('<pageMargins');
    });

    it('worksheet should have conditionalFormatting with dxfId', () => {
      const sheet = files.get('xl/worksheets/sheet1.xml')!;
      expect(sheet).toContain('<conditionalFormatting');
      expect(sheet).toContain('dxfId="0"');
    });

    it('worksheet should have dataValidation', () => {
      const sheet = files.get('xl/worksheets/sheet1.xml')!;
      expect(sheet).toContain('<dataValidation');
      expect(sheet).toContain('type="list"');
    });

    it('theme effectStyleLst should have effectStyle wrappers', () => {
      const theme = files.get('xl/theme/theme1.xml')!;
      expect(theme).toContain('<a:effectStyle>');
      const effectStyleLst = theme.match(/<a:effectStyleLst>[\s\S]*?<\/a:effectStyleLst>/);
      expect(effectStyleLst).not.toBeNull();
      if (effectStyleLst) {
        const inner = effectStyleLst[0].replace(/<a:effectStyle>[\s\S]*?<\/a:effectStyle>/g, '');
        expect(inner).not.toContain('<a:effectLst');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // #2: Round-Trip Fidelity
  // ═══════════════════════════════════════════════════════════

  describe('Round-Trip Fidelity', () => {
    let original: XlsxDesignProtocol;
    let roundTripped: XlsxDesignProtocol;

    beforeAll(async () => {
      original = createTestProtocol();
      const gen1 = path.join(tmpDir, 'rt1.xlsx');
      await generateNativeXlsx(original, gen1);

      const extracted = await distillXlsxDesign(gen1);
      const gen2 = path.join(tmpDir, 'rt2.xlsx');
      await generateNativeXlsx(extracted, gen2);

      roundTripped = await distillXlsxDesign(gen2);
    });

    it('should preserve sheet count', () => {
      expect(roundTripped.sheets.length).toBe(original.sheets.length);
    });

    it('should preserve sheet name', () => {
      expect(roundTripped.sheets[0].name).toBe(original.sheets[0].name);
    });

    it('should preserve row count', () => {
      expect(roundTripped.sheets[0].rows.length).toBe(original.sheets[0].rows.length);
    });

    it('should preserve cell values', () => {
      const origRows = original.sheets[0].rows;
      const rtRows = roundTripped.sheets[0].rows;
      for (let ri = 0; ri < origRows.length; ri++) {
        for (let ci = 0; ci < origRows[ri].cells.length; ci++) {
          const origCell = origRows[ri].cells[ci];
          const rtCell = rtRows[ri]?.cells[ci];
          expect(rtCell, `Missing cell at row ${ri} col ${ci}`).toBeDefined();
          if (rtCell) {
            expect(rtCell.ref).toBe(origCell.ref);
            // Compare values (numbers may be strings after extraction)
            if (origCell.value !== '' && origCell.value !== undefined) {
              expect(String(rtCell.value)).toBe(String(origCell.value));
            }
          }
        }
      }
    });

    it('should preserve column count', () => {
      expect(roundTripped.sheets[0].columns.length).toBe(original.sheets[0].columns.length);
    });

    it('should preserve merge cells', () => {
      expect(roundTripped.sheets[0].mergeCells.length).toBe(original.sheets[0].mergeCells.length);
      expect(roundTripped.sheets[0].mergeCells[0].ref).toBe(original.sheets[0].mergeCells[0].ref);
    });

    it('should preserve dimension', () => {
      expect(roundTripped.sheets[0].dimension).toBe(original.sheets[0].dimension);
    });

    it('should preserve frozen pane settings', () => {
      expect(roundTripped.sheets[0].sheetView?.frozenRows).toBe(original.sheets[0].sheetView?.frozenRows);
      expect(roundTripped.sheets[0].sheetView?.frozenCols).toBe(original.sheets[0].sheetView?.frozenCols);
    });
  });
});
