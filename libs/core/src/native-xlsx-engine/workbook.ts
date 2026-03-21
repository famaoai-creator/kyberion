/**
 * workbook.xml generator for XLSX packages
 */
import type { XlsxDesignProtocol } from '../types/xlsx-protocol.js';

function escXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateWorkbook(protocol: XlsxDesignProtocol): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x15 xr xr6 xr10 xr2" xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xmlns:xr6="http://schemas.microsoft.com/office/spreadsheetml/2014/revision6" xmlns:xr10="http://schemas.microsoft.com/office/spreadsheetml/2016/revision10" xmlns:xr2="http://schemas.microsoft.com/office/spreadsheetml/2015/revision2">`;

  // Workbook properties
  if (protocol.workbookProperties?.rawXml) {
    xml += protocol.workbookProperties.rawXml;
  } else {
    xml += '<workbookPr';
    if (protocol.workbookProperties?.date1904) xml += ' date1904="1"';
    if (protocol.workbookProperties?.defaultThemeVersion) xml += ` defaultThemeVersion="${protocol.workbookProperties.defaultThemeVersion}"`;
    xml += '/>';
  }

  // Sheets
  xml += '<sheets>';
  protocol.sheets.forEach((sheet, i) => {
    xml += `<sheet name="${escXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"`;
    if (sheet.state === 'hidden') xml += ' state="hidden"';
    if (sheet.state === 'veryHidden') xml += ' state="veryHidden"';
    xml += '/>';
  });
  xml += '</sheets>';

  // Defined names
  if (protocol.definedNames.length > 0) {
    xml += '<definedNames>';
    for (const dn of protocol.definedNames) {
      xml += `<definedName name="${escXml(dn.name)}"`;
      if (dn.localSheetId !== undefined) xml += ` localSheetId="${dn.localSheetId}"`;
      if (dn.hidden) xml += ' hidden="1"';
      xml += `>${escXml(dn.value)}</definedName>`;
    }
    xml += '</definedNames>';
  }

  if (protocol.extensions) xml += protocol.extensions;

  xml += '</workbook>';
  return xml;
}
