import { describe, it, expect, vi, beforeEach } from 'vitest';

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

describe('extractThemePalette()', () => {
  it('テーマパレットを返す', async () => {
    const { extractThemePalette } = await import('./excel-theme-resolver.js');
    const result = await extractThemePalette('/mock/file.xlsx');

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
  });
});
