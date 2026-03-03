/**
 * Excel Utilities - Advanced Design Distillation and Tailored Re-generation.
 */

import * as ExcelJS from 'exceljs';
import { ExcelDesignProtocol } from './types/excel-protocol';
import { extractThemePalette, ThemePalette } from './excel-theme-resolver';

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
    sheets: []
  };

  workbook.eachSheet((sheet) => {
    const sheetInfo: any = {
      name: sheet.name,
      columns: [],
      rows: [],
      merges: [],
      autoFilter: sheet.autoFilter,
      views: sheet.views
    };

    // Extract columns
    for (let i = 1; i <= (sheet.columnCount || 0); i++) {
      const col = sheet.getColumn(i);
      sheetInfo.columns.push({ index: i, width: col.width });
    }

    // Extract merges (using any cast for internal property)
    const internalSheet = sheet as any;
    if (internalSheet._merges) {
      sheetInfo.merges = Object.keys(internalSheet._merges).map(key => internalSheet._merges[key].model);
    }

    // Extract styles (limit to first 100 rows for templates)
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber > 100) return;
      const rowInfo: any = { number: rowNumber, height: row.height, cells: {} };
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        rowInfo.cells[colNumber] = {
          value: cell.value,
          style: JSON.parse(JSON.stringify(cell.style))
        };
      });
      sheetInfo.rows.push(rowInfo);
    });

    protocol.sheets.push(sheetInfo);
  });

  return protocol;
}

/**
 * Re-generates Excel from dynamic data using a Design Protocol as a "template".
 */
export async function generateExcelWithDesign(
  data: any[][], // 2D data array (header included or separate)
  protocol: ExcelDesignProtocol,
  sheetName: string = 'Output',
  headerRowIdx: number = 3,
  dataRowIdx: number = 4
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const templateSheet = protocol.sheets.find(s => s.name === sheetName) || protocol.sheets[0];
  const sheet = workbook.addWorksheet(templateSheet.name);

  // Apply column widths
  sheet.columns = templateSheet.columns.map(c => ({ width: c.width }));

  // Resolve Theme Colors Helper
  const resolveStyle = (style: any) => {
    if (!style) return style;
    const s = JSON.parse(JSON.stringify(style));
    if (s.fill && s.fill.fgColor && s.fill.fgColor.theme !== undefined) {
      const argb = protocol.theme[s.fill.fgColor.theme];
      if (argb) s.fill.fgColor = { argb };
    }
    return s;
  };

  // Find styles from template rows
  const headerRowDef = templateSheet.rows.find(r => r.number === headerRowIdx);
  const dataRowDef = templateSheet.rows.find(r => r.number === dataRowIdx);

  // Apply dynamic data
  data.forEach((rowData, idx) => {
    const rowNumber = headerRowIdx + idx;
    const targetRow = sheet.getRow(rowNumber);
    rowData.forEach((val, cIdx) => {
      const cell = targetRow.getCell(cIdx + 1);
      cell.value = val;
      
      // Apply style based on role
      const templateRow = (idx === 0) ? headerRowDef : dataRowDef;
      if (templateRow && templateRow.cells[cIdx + 1]) {
        cell.style = resolveStyle(templateRow.cells[cIdx + 1].style);
      }
    });
  });

  // Re-apply merges from template if they are static/header areas
  templateSheet.merges.forEach(range => {
    // Only apply if the merge is within the header area (rough heuristic)
    const startRow = parseInt(range.match(/\d+/)[0]);
    if (startRow <= headerRowIdx) {
      try { sheet.mergeCells(range); } catch(e){}
    }
  });

  // Expand AutoFilter
  if (templateSheet.autoFilter) {
    sheet.autoFilter = {
      from: 'A' + headerRowIdx,
      to: { row: headerRowIdx + data.length - 1, column: data[0].length }
    };
  }

  return workbook;
}
