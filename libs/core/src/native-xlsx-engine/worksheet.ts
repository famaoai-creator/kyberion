/**
 * worksheet XML generator for XLSX packages
 */
import type { XlsxWorksheet, XlsxCell, XlsxRow, XlsxColumn } from '../types/xlsx-protocol.js';

function escXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cellXml(cell: XlsxCell, sstMap?: Map<string, number>): string {
  // If raw XML preserved, use it
  if (cell.rawXml) return cell.rawXml;

  // Determine effective type: if type is 's' (shared string) and we have an SST map,
  // look up the index. If type is 's' without SST map, convert to inlineStr.
  let effectiveType = cell.type;
  let sstIndex: number | undefined;

  if (cell.type === 's' && typeof cell.value === 'string') {
    if (sstMap) {
      sstIndex = sstMap.get(cell.value);
      if (sstIndex === undefined) {
        // Not in SST — use inlineStr
        effectiveType = 'inlineStr';
      }
    } else {
      // No SST map — use inlineStr for safety
      effectiveType = 'inlineStr';
    }
  }

  let xml = `<c r="${cell.ref}"`;
  if (cell.styleIndex !== undefined) xml += ` s="${cell.styleIndex}"`;
  if (effectiveType && effectiveType !== 'n') xml += ` t="${effectiveType}"`;
  xml += '>';

  if (cell.formula) {
    xml += `<f>${escXml(cell.formula)}</f>`;
    if (cell.value !== undefined) xml += `<v>${escXml(String(cell.value))}</v>`;
  } else if (effectiveType === 'inlineStr') {
    // Inline string: use <is><t> format
    xml += `<is><t xml:space="preserve">${escXml(String(cell.value ?? ''))}</t></is>`;
  } else if (cell.richText && cell.richText.length > 0) {
    xml += '<is>';
    for (const run of cell.richText) {
      xml += '<r>';
      if (run.font) {
        xml += '<rPr>';
        if (run.font.bold) xml += '<b/>';
        if (run.font.italic) xml += '<i/>';
        if (run.font.size) xml += `<sz val="${run.font.size}"/>`;
        if (run.font.name) xml += `<name val="${escXml(run.font.name)}"/>`;
        xml += '</rPr>';
      }
      xml += `<t xml:space="preserve">${escXml(run.text)}</t>`;
      xml += '</r>';
    }
    xml += '</is>';
  } else if (cell.type === 's' && sstIndex !== undefined) {
    // Shared string reference
    xml += `<v>${sstIndex}</v>`;
  } else if (cell.value !== undefined) {
    xml += `<v>${escXml(String(cell.value))}</v>`;
  }

  xml += '</c>';
  return xml;
}

function rowXml(row: XlsxRow, sstMap?: Map<string, number>): string {
  let xml = `<row r="${row.index}"`;
  if (row.height !== undefined) xml += ` ht="${row.height}"`;
  if (row.customHeight) xml += ' customHeight="1"';
  if (row.hidden) xml += ' hidden="1"';
  if (row.outlineLevel) xml += ` outlineLevel="${row.outlineLevel}"`;
  if (row.collapsed) xml += ' collapsed="1"';
  if (row.styleIndex !== undefined) xml += ` s="${row.styleIndex}" customFormat="1"`;

  if (row.cells.length === 0) {
    xml += '/>';
  } else {
    xml += '>';
    for (const cell of row.cells) {
      xml += cellXml(cell, sstMap);
    }
    xml += '</row>';
  }
  return xml;
}

function colXml(col: XlsxColumn): string {
  let xml = `<col min="${col.min}" max="${col.max}"`;
  if (col.width !== undefined) xml += ` width="${col.width}"`;
  if (col.customWidth) xml += ' customWidth="1"';
  if (col.hidden) xml += ' hidden="1"';
  if (col.outlineLevel) xml += ` outlineLevel="${col.outlineLevel}"`;
  if (col.collapsed) xml += ' collapsed="1"';
  if (col.styleIndex !== undefined) xml += ` style="${col.styleIndex}"`;
  if (col.bestFit) xml += ' bestFit="1"';
  xml += '/>';
  return xml;
}

export function generateWorksheet(sheet: XlsxWorksheet, drawingRId?: string, sstMap?: Map<string, number>): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr xr2 xr3" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2" xmlns:xr3="http://schemas.microsoft.com/office/spreadsheetml/2016/revision3">`;

  // Sheet properties
  if (sheet.sheetPrXml) {
    xml += sheet.sheetPrXml;
  }

  // Dimension
  if (sheet.dimension) {
    xml += `<dimension ref="${sheet.dimension}"/>`;
  }

  // Sheet views
  if (sheet.sheetView) {
    if (sheet.sheetView.rawXml) {
      xml += sheet.sheetView.rawXml;
    } else {
      xml += '<sheetViews><sheetView';
      if (sheet.sheetView.tabSelected) xml += ' tabSelected="1"';
      if (sheet.sheetView.showGridLines === false) xml += ' showGridLines="0"';
      if (sheet.sheetView.showRowColHeaders === false) xml += ' showRowColHeaders="0"';
      if (sheet.sheetView.zoomScale) xml += ` zoomScale="${sheet.sheetView.zoomScale}"`;
      xml += ' workbookViewId="0"';
      if (sheet.sheetView.frozenRows || sheet.sheetView.frozenCols) {
        xml += '><pane';
        if (sheet.sheetView.frozenCols) xml += ` xSplit="${sheet.sheetView.frozenCols}"`;
        if (sheet.sheetView.frozenRows) xml += ` ySplit="${sheet.sheetView.frozenRows}"`;
        const topLeft = `${colLetter((sheet.sheetView.frozenCols || 0) + 1)}${(sheet.sheetView.frozenRows || 0) + 1}`;
        xml += ` topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/>`;
        xml += '</sheetView>';
      } else {
        xml += '/>';
      }
      xml += '</sheetViews>';
    }
  }

  xml += '<sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/>';

  // Columns
  if (sheet.columns.length > 0) {
    xml += '<cols>';
    for (const col of sheet.columns) xml += colXml(col);
    xml += '</cols>';
  }

  // Sheet data (rows)
  xml += '<sheetData>';
  for (const row of sheet.rows) {
    xml += rowXml(row, sstMap);
  }
  xml += '</sheetData>';

  // Auto filter
  if (sheet.autoFilter) {
    if (sheet.autoFilter.rawXml) {
      xml += sheet.autoFilter.rawXml;
    } else {
      xml += `<autoFilter ref="${sheet.autoFilter.ref}"/>`;
    }
  }

  // Merge cells
  if (sheet.mergeCells.length > 0) {
    xml += `<mergeCells count="${sheet.mergeCells.length}">`;
    for (const mc of sheet.mergeCells) {
      xml += `<mergeCell ref="${mc.ref}"/>`;
    }
    xml += '</mergeCells>';
  }

  // Conditional formatting
  for (const cf of sheet.conditionalFormats) {
    xml += `<conditionalFormatting sqref="${cf.sqref}">`;
    for (const rule of cf.rules) {
      if (rule.rawXml) {
        xml += rule.rawXml;
      } else {
        xml += `<cfRule type="${rule.type}" priority="${rule.priority}"`;
        if (rule.dxfId !== undefined) xml += ` dxfId="${rule.dxfId}"`;
        if (rule.operator) xml += ` operator="${rule.operator}"`;
        xml += '>';
        if (rule.formula) xml += `<formula>${escXml(rule.formula)}</formula>`;
        xml += '</cfRule>';
      }
    }
    xml += '</conditionalFormatting>';
  }

  // Data validations
  if (sheet.dataValidations.length > 0) {
    xml += `<dataValidations count="${sheet.dataValidations.length}">`;
    for (const dv of sheet.dataValidations) {
      if (dv.rawXml) {
        xml += dv.rawXml;
      } else {
        xml += `<dataValidation sqref="${dv.sqref}"`;
        if (dv.type) xml += ` type="${dv.type}"`;
        if (dv.operator) xml += ` operator="${dv.operator}"`;
        if (dv.showDropDown) xml += ' showDropDown="1"';
        if (dv.showErrorMessage) xml += ' showErrorMessage="1"';
        if (dv.errorTitle) xml += ` errorTitle="${escXml(dv.errorTitle)}"`;
        if (dv.error) xml += ` error="${escXml(dv.error)}"`;
        xml += '>';
        if (dv.formula1) xml += `<formula1>${escXml(dv.formula1)}</formula1>`;
        if (dv.formula2) xml += `<formula2>${escXml(dv.formula2)}</formula2>`;
        xml += '</dataValidation>';
      }
    }
    xml += '</dataValidations>';
  }

  // Page setup
  if (sheet.pageSetup) {
    if (sheet.pageSetup.rawXml) {
      xml += sheet.pageSetup.rawXml;
    } else {
      if (sheet.pageSetup.margins) {
        const m = sheet.pageSetup.margins;
        xml += `<pageMargins left="${m.left}" right="${m.right}" top="${m.top}" bottom="${m.bottom}" header="${m.header}" footer="${m.footer}"/>`;
      } else {
        xml += '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';
      }
      xml += '<pageSetup';
      if (sheet.pageSetup.paperSize) xml += ` paperSize="${sheet.pageSetup.paperSize}"`;
      if (sheet.pageSetup.orientation) xml += ` orientation="${sheet.pageSetup.orientation}"`;
      if (sheet.pageSetup.scale) xml += ` scale="${sheet.pageSetup.scale}"`;
      if (sheet.pageSetup.fitToWidth !== undefined) xml += ` fitToWidth="${sheet.pageSetup.fitToWidth}"`;
      if (sheet.pageSetup.fitToHeight !== undefined) xml += ` fitToHeight="${sheet.pageSetup.fitToHeight}"`;
      xml += '/>';
    }
  } else {
    xml += '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';
  }

  // Drawing reference
  if (drawingRId) {
    xml += `<drawing r:id="${drawingRId}"/>`;
  }

  // Extensions
  if (sheet.extensions) xml += sheet.extensions;

  xml += '</worksheet>';
  return xml;
}

function colLetter(colIndex: number): string {
  if (colIndex <= 0) return 'A';
  let result = '';
  let n = colIndex;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result || 'A';
}
