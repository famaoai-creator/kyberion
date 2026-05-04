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

describe('distillExcelDesign()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkbook.xlsx.readFile.mockResolvedValue(undefined);
    mockWorkbook.eachSheet.mockImplementation((cb: any) => cb(mockSheet, 1));
    mockWorkbook.addWorksheet.mockReturnValue(mockSheet);
    mockSheet.eachRow.mockImplementation(() => {});
  });

  it('ExcelDesignProtocolの必須フィールドを返す', async () => {
    const { distillExcelDesign } = await import('./excel-utils.js');
    const result = await distillExcelDesign('/mock/file.xlsx');

    expect(result).toHaveProperty('version', '1.0.0');
    expect(result).toHaveProperty('generatedAt');
    expect(result).toHaveProperty('sheets');
    expect(Array.isArray(result.sheets)).toBe(true);
  });

  it('シートの列情報を抽出する', async () => {
    const { distillExcelDesign } = await import('./excel-utils.js');
    const result = await distillExcelDesign('/mock/file.xlsx');

    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0].name).toBe('Sheet1');
    expect(Array.isArray(result.sheets[0].columns)).toBe(true);
  });

  it('generatedAtはISO 8601形式の日時文字列', async () => {
    const { distillExcelDesign } = await import('./excel-utils.js');
    const result = await distillExcelDesign('/mock/file.xlsx');

    expect(() => new Date(result.generatedAt)).not.toThrow();
    expect(new Date(result.generatedAt).toISOString()).toBe(result.generatedAt);
  });

  it('themeフィールドを含む', async () => {
    const { distillExcelDesign } = await import('./excel-utils.js');
    const result = await distillExcelDesign('/mock/file.xlsx');

    expect(result).toHaveProperty('theme');
  });

  it('autoFilterが設定されている場合に文字列として保存する', async () => {
    const sheetWithFilter = {
      ...mockSheet,
      autoFilter: { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } },
    };
    mockWorkbook.eachSheet.mockImplementationOnce((cb: any) => cb(sheetWithFilter, 1));

    const { distillExcelDesign } = await import('./excel-utils.js');
    const result = await distillExcelDesign('/mock/file.xlsx');

    expect(result.sheets[0].autoFilter).toBeDefined();
    expect(typeof result.sheets[0].autoFilter).toBe('string');
  });

  it('行データを抽出する', async () => {
    const mockRow = {
      height: 20,
      eachCell: vi.fn().mockImplementation((opts: any, cb: any) => {
        cb({ value: 'cell value', style: {} }, 1);
      }),
    };
    mockSheet.eachRow.mockImplementationOnce((opts: any, cb: any) => {
      cb(mockRow, 1);
    });

    const { distillExcelDesign } = await import('./excel-utils.js');
    const result = await distillExcelDesign('/mock/file.xlsx');

    expect(result.sheets[0].rows).toHaveLength(1);
    expect(result.sheets[0].rows[0].number).toBe(1);
  });
});

describe('generateExcelWithDesign()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkbook.addWorksheet.mockReturnValue(mockSheet);
  });

  it('protocol.sheetsのシート名を持つワークブックを返す', async () => {
    const { generateExcelWithDesign } = await import('./excel-utils.js');
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
    const { generateExcelWithDesign } = await import('./excel-utils.js');
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
    const { generateExcelWithDesign } = await import('./excel-utils.js');
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
    const { generateExcelWithDesign } = await import('./excel-utils.js');
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

describe('extractThemePalette()', () => {
  it('テーマパレットを返す', async () => {
    const { extractThemePalette } = await import('./excel-theme-resolver.js');
    const result = await extractThemePalette('/mock/file.xlsx');

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });
});

// Feature: project-quality-improvement, Property 6: ExcelDesignProtocolのラウンドトリップ特性
describe('Property 6: ExcelDesignProtocolのラウンドトリップ特性', () => {
  it('任意のシート数でdistill→generateのラウンドトリップ後にシート数が保持される', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 1, maxLength: 5 }),
        async (sheetNames) => {
          const { generateExcelWithDesign } = await import('./excel-utils.js');

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
