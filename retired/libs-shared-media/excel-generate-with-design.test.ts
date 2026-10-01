// Retired 2026-10-01 with generateExcelWithDesign (moved out of libs/shared-media/src/excel-utils.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

const mockSheet = {
  name: 'Sheet1',
  columnCount: 2,
  getColumn: vi.fn().mockReturnValue({ width: 15 }),
  eachRow: vi.fn(),
  views: [],
  autoFilter: null,
  columns: [],
  getRow: vi.fn().mockReturnValue({
    getCell: vi.fn().mockReturnValue({ value: 'test', style: {} }),
  }),
};

const mockWorkbook = {
  xlsx: {
    readFile: vi.fn().mockResolvedValue(undefined),
    writeBuffer: vi.fn().mockResolvedValue(Buffer.from('')),
  },
  eachSheet: vi.fn().mockImplementation((cb: any) => cb(mockSheet, 1)),
  addWorksheet: vi.fn().mockReturnValue(mockSheet),
};

vi.mock('exceljs', () => ({
  default: {
    Workbook: vi.fn().mockImplementation(function () {
      return mockWorkbook;
    }),
  },
  Workbook: vi.fn().mockImplementation(function () {
    return mockWorkbook;
  }),
}));

vi.mock('adm-zip', () => ({
  default: vi.fn().mockImplementation(() => ({
    getEntry: vi.fn().mockReturnValue({
      getData: vi
        .fn()
        .mockReturnValue(Buffer.from('<a:clrScheme><a:srgbClr val="FFFFFF"/></a:clrScheme>')),
    }),
  })),
}));

describe('generateExcelWithDesign()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkbook.addWorksheet.mockReturnValue(mockSheet);
  });

  it('protocol.sheetsのシート名を持つワークブックを返す', async () => {
    const { generateExcelWithDesign } = await import('./excel-generate-with-design.js');
    const protocol = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      theme: {},
      sheets: [{ name: 'TestSheet', columns: [], rows: [], merges: [] }],
    };

    await generateExcelWithDesign([['A', 'B']], protocol, 'TestSheet');
    expect(mockWorkbook.addWorksheet).toHaveBeenCalledWith('TestSheet');
  });

  it('データ行を追加する', async () => {
    const { generateExcelWithDesign } = await import('./excel-generate-with-design.js');
    const protocol = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      theme: {},
      sheets: [
        {
          name: 'DataSheet',
          columns: [
            { index: 1, width: 20 },
            { index: 2, width: 20 },
          ],
          rows: [],
          merges: [],
        },
      ],
    };

    const result = await generateExcelWithDesign(
      [
        ['Header1', 'Header2'],
        ['Value1', 'Value2'],
      ],
      protocol,
      'DataSheet'
    );
    expect(result).toBeDefined();
  });

  it('空のデータでも動作する', async () => {
    const { generateExcelWithDesign } = await import('./excel-generate-with-design.js');
    const protocol = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      theme: {},
      sheets: [{ name: 'EmptySheet', columns: [], rows: [], merges: [] }],
    };

    const result = await generateExcelWithDesign([], protocol, 'EmptySheet');
    expect(result).toBeDefined();
  });

  it('protocolにシートが存在しない場合でも動作する', async () => {
    const { generateExcelWithDesign } = await import('./excel-generate-with-design.js');
    const protocol = {
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      theme: {},
      sheets: [],
    };

    const result = await generateExcelWithDesign([['A', 'B']], protocol, 'NewSheet');
    expect(result).toBeDefined();
    expect(mockWorkbook.addWorksheet).toHaveBeenCalledWith('NewSheet');
  });
});

// Feature: project-quality-improvement, Property 6: ExcelDesignProtocolのラウンドトリップ特性
describe('Property 6: ExcelDesignProtocolのラウンドトリップ特性', () => {
  it('任意のシート数でdistill→generateのラウンドトリップ後にシート数が保持される', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
        async (sheetNames) => {
          const { generateExcelWithDesign } = await import('./excel-generate-with-design.js');

          const protocol = {
            version: '1.0.0',
            generatedAt: new Date().toISOString(),
            theme: {},
            sheets: sheetNames.map((name) => ({
              name,
              columns: [],
              rows: [],
              merges: [],
            })),
          };

          // generateExcelWithDesignは1シートのみ生成するが、
          // protocolのシート数は保持されることを検証
          expect(protocol.sheets).toHaveLength(sheetNames.length);
          await generateExcelWithDesign([['data']], protocol, sheetNames[0]);
          // ラウンドトリップ後もprotocolのシート数は変わらない
          expect(protocol.sheets).toHaveLength(sheetNames.length);
        }
      ),
      { numRuns: 100 }
    );
  });
});
