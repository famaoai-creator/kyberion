/**
 * sharedStrings.xml generator for XLSX packages
 */
import type { XlsxDesignProtocol, XlsxTextRun } from '../types/xlsx-protocol.js';

function escXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function richTextRunXml(run: XlsxTextRun): string {
  let xml = '<r>';
  if (run.font) {
    xml += '<rPr>';
    if (run.font.bold) xml += '<b/>';
    if (run.font.italic) xml += '<i/>';
    if (run.font.strike) xml += '<strike/>';
    if (run.font.underline) xml += '<u/>';
    if (run.font.size) xml += `<sz val="${run.font.size}"/>`;
    if (run.font.color?.rgb) xml += `<color rgb="${run.font.color.rgb.replace('#', 'FF')}"/>`;
    if (run.font.color?.theme !== undefined) xml += `<color theme="${run.font.color.theme}"/>`;
    if (run.font.name) xml += `<name val="${escXml(run.font.name)}"/>`;
    if (run.font.family !== undefined) xml += `<family val="${run.font.family}"/>`;
    if (run.font.scheme) xml += `<scheme val="${run.font.scheme}"/>`;
    xml += '</rPr>';
  }
  xml += `<t xml:space="preserve">${escXml(run.text)}</t>`;
  xml += '</r>';
  return xml;
}

export function generateSharedStrings(protocol: XlsxDesignProtocol): string {
  const count = protocol.sharedStrings.length;
  const richEntries = protocol.sharedStringsRich || [];

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${count}" uniqueCount="${count}">`;

  for (let i = 0; i < count; i++) {
    const richRuns = richEntries[i];
    if (richRuns && richRuns.length > 0) {
      // Rich text entry
      xml += '<si>';
      for (const run of richRuns) {
        xml += richTextRunXml(run);
      }
      xml += '</si>';
    } else {
      // Plain text entry
      xml += `<si><t xml:space="preserve">${escXml(protocol.sharedStrings[i])}</t></si>`;
    }
  }

  xml += '</sst>';
  return xml;
}
