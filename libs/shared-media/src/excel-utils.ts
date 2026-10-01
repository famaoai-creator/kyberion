/**
 * Excel Utilities - Advanced Design Distillation.
 */

import * as ExcelJS from 'exceljs';
import { ExcelDesignProtocol, SheetDesign } from './types/excel-protocol.js';
import { extractThemePalette } from './excel-theme-resolver.js';

/**
 * Distills an Excel file into a portable Design Protocol (ADF).
 */
export async function distillExcelDesign(filePath: string): Promise<ExcelDesignProtocol> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const theme = await extractThemePalette(filePath);

  const protocol: ExcelDesignProtocol = {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    theme: theme,
    sheets: [],
  };

  workbook.eachSheet((sheet) => {
    const sheetInfo: SheetDesign = {
      name: sheet.name,
      columns: [],
      rows: [],
      merges: [],
      autoFilter: sheet.autoFilter ? JSON.stringify(sheet.autoFilter) : undefined,
      views: sheet.views,
    };

    // Extract columns
    for (let i = 1; i <= (sheet.columnCount || 0); i++) {
      const col = sheet.getColumn(i);
      sheetInfo.columns.push({ index: i, width: col.width || 12 });
    }

    // Extract merges
    const internalSheet = sheet as any;
    if (internalSheet._merges) {
      sheetInfo.merges = Object.keys(internalSheet._merges).map(
        (key) => internalSheet._merges[key].model
      );
    }

    // Extract styles
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > 100) return;
      const rowInfo: any = { number: rowNumber, height: row.height, cells: {} };
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        rowInfo.cells[colNumber] = {
          value: cell.value,
          style: JSON.parse(JSON.stringify(cell.style)),
        };
      });
      sheetInfo.rows.push(rowInfo);
    });

    protocol.sheets.push(sheetInfo);
  });

  return protocol;
}
