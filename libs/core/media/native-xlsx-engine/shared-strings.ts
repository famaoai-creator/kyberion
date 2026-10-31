/**
 * sharedStrings.xml generator for XLSX packages
 */
import type {
  XlsxDesignProtocol,
  XlsxPhoneticString,
  XlsxTextRun,
} from '../../contracts/xlsx-protocol.js';
import { escapeXlsxAttr, escapeXlsxText } from '../xlsx-xstring.js';

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
    if (run.font.name) xml += `<name val="${escapeXlsxAttr(run.font.name)}"/>`;
    if (run.font.family !== undefined) xml += `<family val="${run.font.family}"/>`;
    if (run.font.scheme) xml += `<scheme val="${run.font.scheme}"/>`;
    xml += '</rPr>';
  }
  xml += `<t xml:space="preserve">${escapeXlsxText(run.text)}</t>`;
  xml += '</r>';
  return xml;
}

function phoneticXml(phonetic: XlsxPhoneticString | undefined): string {
  if (!phonetic?.runs?.length) return '';
  let xml = '';
  for (const run of phonetic.runs) {
    xml += `<rPh sb="${run.sb}" eb="${run.eb}"><t>${escapeXlsxText(run.text)}</t></rPh>`;
  }
  if (phonetic.props) {
    xml += '<phoneticPr';
    if (phonetic.props.fontId !== undefined) xml += ` fontId="${phonetic.props.fontId}"`;
    if (phonetic.props.type) xml += ` type="${escapeXlsxAttr(phonetic.props.type)}"`;
    if (phonetic.props.alignment) xml += ` alignment="${escapeXlsxAttr(phonetic.props.alignment)}"`;
    xml += '/>';
  }
  return xml;
}

function countSharedStringUsages(protocol: XlsxDesignProtocol): number {
  let uses = 0;
  for (const sheet of protocol.sheets) {
    for (const row of sheet.rows) {
      for (const cell of row.cells) {
        if (cell.type === 's') uses += 1;
      }
    }
  }
  return uses;
}

export function generateSharedStrings(protocol: XlsxDesignProtocol): string {
  const uniqueCount = protocol.sharedStrings.length;
  const richEntries = protocol.sharedStringsRich || [];
  // `count` = cell usages, `uniqueCount` = SST length (GridCraft write.rs `Sst`)
  const count = Math.max(uniqueCount, countSharedStringUsages(protocol));

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${count}" uniqueCount="${uniqueCount}">`;

  const phoneticEntries = protocol.sharedStringsPhonetic || [];
  for (let i = 0; i < uniqueCount; i++) {
    const richRuns = richEntries[i];
    const phonetic = phoneticXml(phoneticEntries[i]);
    const isRich = richRuns && richRuns.length > 0 && !(richRuns.length === 1 && !richRuns[0].font);
    if (isRich) {
      // Rich text entry
      xml += '<si>';
      for (const run of richRuns!) {
        xml += richTextRunXml(run);
      }
      xml += phonetic;
      xml += '</si>';
    } else {
      // Plain text entry — ST_Xstring so CRs / controls round-trip
      xml += `<si><t xml:space="preserve">${escapeXlsxText(protocol.sharedStrings[i])}</t>${phonetic}</si>`;
    }
  }

  xml += '</sst>';
  return xml;
}
