import { JSDOM } from 'jsdom';
import ExcelJS from 'exceljs';
import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface ExcelSheetDef {
  name: string;
  rows: any[][];
}

export interface ExcelStyles {
  header?: Partial<ExcelJS.Style>;
  currency_cell?: { numFmt: string };
}

export interface ExcelMasterSpecs {
  master_name: string;
  layout: { hide_gridlines: boolean; default_column_width: number };
  styles: ExcelStyles;
}

/**
 * Extracts table rows from HTML content.
 */
export function extractRowsFromHtml(html: string): string[][] {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const table = document.querySelector('table');

  if (!table) {
    throw new Error('No <table> tag found in the provided HTML.');
  }

  const rows: string[][] = [];
  const trElements = table.querySelectorAll('tr');
  for (const tr of Array.from(trElements)) {
    const cells: string[] = [];
    const tdElements = tr.querySelectorAll('th, td');
    for (const td of Array.from(tdElements)) {
      cells.push(td.textContent?.trim() || '');
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Extracts table rows from a DocumentArtifact (HTML or Markdown).
 */
export function extractRowsFromArtifact(artifact: DocumentArtifact): string[][] {
  if (artifact.format === 'html' || artifact.body.includes('<table')) {
    return extractRowsFromHtml(artifact.body);
  }
  // Basic Markdown table parser
  const lines = artifact.body.trim().split('\n');
  return lines
    .filter((line) => line.includes('|') && !line.includes('---'))
    .map((line) =>
      line
        .split('|')
        .filter((cell) => cell.trim() !== '')
        .map((cell) => cell.trim())
    );
}

/**
 * Creates a new Excel workbook from HTML table content.
 */
export async function createWorkbookFromHTML(html: string): Promise<ExcelJS.Workbook> {
  const artifact: DocumentArtifact = {
    title: 'Imported Table',
    body: html,
    format: 'html',
  };
  const rows = extractRowsFromArtifact(artifact);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sheet 1');
  sheet.addRows(rows);
  return workbook;
}

export function applySpecsToWorkbook(
  workbook: ExcelJS.Workbook,
  sheets: ExcelSheetDef[],
  specs: ExcelMasterSpecs
): void {
  sheets.forEach((sheetDef) => {
    let sheet = workbook.getWorksheet(sheetDef.name);
    if (!sheet) {
      sheet = workbook.addWorksheet(sheetDef.name);
    }

    if (specs.layout.hide_gridlines) {
      sheet.views = [{ showGridLines: false }];
    }

    sheet.addRows(sheetDef.rows);

    // Apply header styles
    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      if (specs.styles.header) {
        Object.assign(cell, specs.styles.header);
      }
    });

    // Apply column widths
    if (sheetDef.rows.length > 0) {
      sheet.columns = sheetDef.rows[0].map(() => ({ width: specs.layout.default_column_width }));
    }

    // Dynamic formatting for numbers and dates
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber > 1) {
        row.eachCell((cell) => {
          if (typeof cell.value === 'number' && specs.styles.currency_cell) {
            cell.numFmt = specs.styles.currency_cell.numFmt;
          } else if (typeof cell.value === 'string') {
            // Attempt to detect date strings
            if (/^\d{4}-\d{2}-\d{2}(T|\s|$)/.test(cell.value)) {
              const date = new Date(cell.value);
              if (!isNaN(date.getTime())) {
                cell.value = date;
                cell.numFmt = 'yyyy-mm-dd';
              }
            }
          }
        });
      }
    });
  });
}
