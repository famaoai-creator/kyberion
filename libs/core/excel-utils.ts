/**
 * Excel Utilities - Advanced Design Distillation and Tailored Re-generation.
 */

import * as ExcelJS from 'exceljs';
import type { ExcelDesignProtocol, SheetDesign } from './src/types/excel-protocol.js';
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
    theme,
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

    for (let i = 1; i <= (sheet.columnCount || 0); i += 1) {
      const col = sheet.getColumn(i);
      sheetInfo.columns.push({ index: i, width: col.width || 12 });
    }

    const internalSheet = sheet as any;
    if (internalSheet._merges) {
      sheetInfo.merges = Object.keys(internalSheet._merges).map((key) => internalSheet._merges[key].model);
    }

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

/**
 * Re-generates Excel from dynamic data using a Design Protocol as a template.
 */
export async function generateExcelWithDesign(
  data: any[][],
  protocol: ExcelDesignProtocol,
  sheetName = 'Output',
  headerRowIdx = 1,
  dataRowIdx = 2,
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();

  const templateSheet =
    protocol?.sheets?.find((sheet) => sheet.name === sheetName) ||
    (protocol?.sheets && protocol.sheets.length > 0 ? protocol.sheets[0] : null);

  const sheet = workbook.addWorksheet(templateSheet?.name || sheetName || 'Sheet1');

  if (templateSheet && Array.isArray((templateSheet as any).columns)) {
    sheet.columns = (templateSheet as any).columns.map((c: any) => ({ width: c.width || 15 }));
  } else if (data && data.length > 0 && Array.isArray(data[0])) {
    sheet.columns = data[0].map(() => ({ width: 25 }));
  }

  const resolveStyle = (style: any) => {
    if (!style) return style;
    try {
      const cloned = JSON.parse(JSON.stringify(style));
      if (cloned.fill && cloned.fill.fgColor && cloned.fill.fgColor.theme !== undefined && protocol?.theme) {
        const argb = protocol.theme[cloned.fill.fgColor.theme];
        if (argb) cloned.fill.fgColor = { argb };
      }
      return cloned;
    } catch (_) {
      return style;
    }
  };

  const headerRowDef = templateSheet?.rows?.find((row: any) => row.number === headerRowIdx);
  const dataRowDef = templateSheet?.rows?.find((row: any) => row.number === dataRowIdx);

  if (Array.isArray(data)) {
    data.forEach((rowData, idx) => {
      const rowNumber = headerRowIdx + idx;
      const targetRow = sheet.getRow(rowNumber);
      if (!Array.isArray(rowData)) return;

      rowData.forEach((val, cIdx) => {
        const cell = targetRow.getCell(cIdx + 1);
        cell.value = val;

        const templateRow = idx === 0 ? headerRowDef : dataRowDef;
        if (templateRow && templateRow.cells && templateRow.cells[cIdx + 1]) {
          cell.style = resolveStyle(templateRow.cells[cIdx + 1].style);
        }
      });
    });
  }

  return workbook;
}
