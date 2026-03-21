/**
 * Native XLSX Engine
 * Generates complete XLSX files from XlsxDesignProtocol (ADF).
 * Follows the same architecture pattern as native-pptx-engine.
 */
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import type { XlsxDesignProtocol } from '../types/xlsx-protocol.js';
import { generateContentTypes } from './content-types.js';
import { generateGlobalRels, generateWorkbookRels, generateSheetRels } from './rels.js';
import { generateStyles } from './styles.js';
import { generateSharedStrings } from './shared-strings.js';
import { generateWorkbook } from './workbook.js';
import { generateWorksheet } from './worksheet.js';
import { generateDrawing } from './drawing.js';
import { generateTable } from './table.js';

// Re-use PPTX engine's theme generator (DrawingML theme is identical)
import { generateTheme } from '../native-pptx-engine/theme.js';

export async function generateNativeXlsx(protocol: XlsxDesignProtocol, outputPath: string): Promise<void> {
  if (!protocol?.sheets?.length) {
    throw new Error('generateNativeXlsx: protocol must have at least one sheet');
  }
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    throw new Error(`generateNativeXlsx: output directory does not exist: ${dir}`);
  }
  const zip = new AdmZip();
  const sheetCount = protocol.sheets.length;

  // Count drawings and tables across all sheets
  let totalDrawings = 0;
  let totalTables = 0;
  const sheetDrawingIndex: number[] = [];     // per-sheet: drawing index (1-based) or 0
  const sheetTableIndices: number[][] = [];   // per-sheet: array of table indices (1-based)

  for (const sheet of protocol.sheets) {
    if (sheet.drawing && sheet.drawing.elements.length > 0) {
      totalDrawings++;
      sheetDrawingIndex.push(totalDrawings);
    } else {
      sheetDrawingIndex.push(0);
    }

    const tableIds: number[] = [];
    for (const _table of sheet.tables) {
      totalTables++;
      tableIds.push(totalTables);
    }
    sheetTableIndices.push(tableIds);
  }

  // 1. Core package files
  zip.addFile('[Content_Types].xml', Buffer.from(generateContentTypes(sheetCount, totalDrawings, totalTables), 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(generateGlobalRels(), 'utf8'));
  zip.addFile('docProps/core.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Kyberion Native Spreadsheet</dc:title>
  <dcterms:created xsi:type="dcterms:W3CDTF">${protocol.generatedAt || new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`, 'utf8'));
  zip.addFile('docProps/app.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Kyberion Native XLSX Engine</Application>
</Properties>`, 'utf8'));

  // 2. Workbook
  zip.addFile('xl/workbook.xml', Buffer.from(generateWorkbook(protocol), 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(generateWorkbookRels(sheetCount), 'utf8'));

  // 3. Theme
  const themeColors: Record<string, string> = {};
  for (const [key, val] of Object.entries(protocol.theme.colors)) {
    themeColors[key] = val;
  }
  zip.addFile('xl/theme/theme1.xml', Buffer.from(
    protocol.theme.rawXml || generateTheme(themeColors), 'utf8'));

  // 4. Styles
  zip.addFile('xl/styles.xml', Buffer.from(generateStyles(protocol), 'utf8'));

  // 5. Shared Strings
  // Build SST map for cell value → index lookup
  const sstMap = new Map<string, number>();
  protocol.sharedStrings.forEach((s, i) => { sstMap.set(s, i); });
  zip.addFile('xl/sharedStrings.xml', Buffer.from(generateSharedStrings(protocol), 'utf8'));

  // 6. Worksheets, Drawings, Tables
  protocol.sheets.forEach((sheet, sheetIdx) => {
    const sheetNum = sheetIdx + 1;
    const drawingIdx = sheetDrawingIndex[sheetIdx];
    const tableIds = sheetTableIndices[sheetIdx];

    // Build sheet relationships
    const sheetExtras: Array<{ id: string; type: string; target: string }> = [];
    let rIdCounter = 1;

    if (drawingIdx > 0) {
      sheetExtras.push({
        id: `rId${rIdCounter++}`,
        type: 'drawing',
        target: `../drawings/drawing${drawingIdx}.xml`,
      });
    }

    for (const tableId of tableIds) {
      sheetExtras.push({
        id: `rId${rIdCounter++}`,
        type: 'table',
        target: `../tables/table${tableId}.xml`,
      });
    }

    // Worksheet XML
    const drawingRId = drawingIdx > 0 ? 'rId1' : undefined;
    zip.addFile(`xl/worksheets/sheet${sheetNum}.xml`,
      Buffer.from(generateWorksheet(sheet, drawingRId, sstMap), 'utf8'));

    // Sheet rels (only if there are relationships)
    if (sheetExtras.length > 0) {
      zip.addFile(`xl/worksheets/_rels/sheet${sheetNum}.xml.rels`,
        Buffer.from(generateSheetRels(sheetExtras), 'utf8'));
    }

    // Drawing XML
    if (drawingIdx > 0 && sheet.drawing) {
      zip.addFile(`xl/drawings/drawing${drawingIdx}.xml`,
        Buffer.from(generateDrawing(sheet.drawing), 'utf8'));
    }

    // Table XMLs
    sheet.tables.forEach((table, tableLocalIdx) => {
      const globalTableId = tableIds[tableLocalIdx];
      zip.addFile(`xl/tables/table${globalTableId}.xml`,
        Buffer.from(generateTable(table), 'utf8'));
    });
  });

  // Write ZIP to output
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  zip.writeZip(outputPath);
}
