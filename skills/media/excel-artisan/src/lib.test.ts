import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  extractRowsFromArtifact,
  applySpecsToWorkbook,
  ExcelSheetDef,
  ExcelMasterSpecs,
} from './lib.js';

describe('excel-artisan lib', () => {
  it('should extract rows from DocumentArtifact (HTML)', () => {
    const artifact = {
      title: 'Stats',
      body: '<table><tr><th>ID</th><th>Name</th></tr><tr><td>1</td><td>Test</td></tr></table>',
      format: 'html' as const,
    };
    const rows = extractRowsFromArtifact(artifact);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(['ID', 'Name']);
    expect(rows[1]).toEqual(['1', 'Test']);
  });

  it('should apply master specs to workbook', () => {
    const workbook = new ExcelJS.Workbook();
    const sheets: ExcelSheetDef[] = [
      {
        name: 'Financials',
        rows: [
          ['Item', 'Amount'],
          ['Sales', 1000],
        ],
      },
    ];
    const specs: ExcelMasterSpecs = {
      master_name: 'Standard',
      layout: { hide_gridlines: true, default_column_width: 15 },
      styles: {
        header: { font: { bold: true } },
        currency_cell: { numFmt: '"$"#,##0.00' },
      },
    };

    applySpecsToWorkbook(workbook, sheets, specs);
    const sheet = workbook.getWorksheet('Financials');
    expect(sheet).toBeDefined();
    expect(sheet?.getRow(1).getCell(1).font?.bold).toBe(true);
    expect(sheet?.getRow(2).getCell(2).numFmt).toBe('"$"#,##0.00');
  });

  it('should auto-detect and format date strings', () => {
    const workbook = new ExcelJS.Workbook();
    const sheets: ExcelSheetDef[] = [
      {
        name: 'Dates',
        rows: [
          ['Event', 'Date'],
          ['Launch', '2026-02-21'],
        ],
      },
    ];
    const specs: ExcelMasterSpecs = {
      master_name: 'Standard',
      layout: { hide_gridlines: false, default_column_width: 10 },
      styles: {},
    };

    applySpecsToWorkbook(workbook, sheets, specs);
    const sheet = workbook.getWorksheet('Dates');
    const dateCell = sheet?.getRow(2).getCell(2);

    expect(dateCell?.value).toBeInstanceOf(Date);
    expect(dateCell?.numFmt).toBe('yyyy-mm-dd');
  });
});
