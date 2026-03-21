/**
 * Table XML generator for XLSX packages
 */
import type { XlsxTable } from '../types/xlsx-protocol.js';

function escXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateTable(table: XlsxTable): string {
  if (table.rawXml) return table.rawXml;

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="${table.id}" name="${escXml(table.name)}" displayName="${escXml(table.displayName)}" ref="${table.ref}"`;
  if (table.totalsRowShown) xml += ' totalsRowShown="1"';
  if (table.headerRowCount !== undefined) xml += ` headerRowCount="${table.headerRowCount}"`;
  xml += '>';

  // Auto filter
  xml += `<autoFilter ref="${table.ref}"/>`;

  // Table columns
  xml += `<tableColumns count="${table.columns.length}">`;
  for (const col of table.columns) {
    xml += `<tableColumn id="${col.id}" name="${escXml(col.name)}"`;
    if (col.totalsRowFunction) xml += ` totalsRowFunction="${col.totalsRowFunction}"`;
    if (col.totalsRowLabel) xml += ` totalsRowLabel="${escXml(col.totalsRowLabel)}"`;
    xml += '/>';
  }
  xml += '</tableColumns>';

  // Table style
  if (table.styleInfo) {
    xml += `<tableStyleInfo name="${escXml(table.styleInfo.name)}"`;
    if (table.styleInfo.showFirstColumn) xml += ' showFirstColumn="1"';
    if (table.styleInfo.showLastColumn) xml += ' showLastColumn="1"';
    if (table.styleInfo.showRowStripes) xml += ' showRowStripes="1"';
    if (table.styleInfo.showColumnStripes) xml += ' showColumnStripes="1"';
    xml += '/>';
  }

  xml += '</table>';
  return xml;
}
