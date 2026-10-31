/**
 * Native XLSX Engine
 * Generates complete XLSX files from XlsxDesignProtocol (ADF).
 * Follows the same architecture pattern as native-pptx-engine.
 */
import AdmZip from 'adm-zip';
import * as path from 'path';
import { nowIso } from '../../foundation/time.js';
import { safeExistsSync, safeMkdir, safeReadFile } from '../../secure-io.js';
import { sanitizeXmlText } from '../../text-escaping.js';
import type { XlsxDesignProtocol } from '../../contracts/xlsx-protocol.js';
import { parseOoxmlCorePropertiesXml } from '../ooxml-core-props.js';
import { generateContentTypes } from './content-types.js';
import { generateGlobalRels, generateWorkbookRels, generateSheetRels } from './rels.js';
import { generateStyles } from './styles.js';
import { generateSharedStrings } from './shared-strings.js';
import { generateWorkbook } from './workbook.js';
import { generateWorksheet } from './worksheet.js';
import { generateDrawing, collectDrawingImageRels } from './drawing.js';
import { generateTable } from './table.js';
import { generateCommentsXml, generateVmlDrawing } from './comments.js';
import { escapeXlsxAttr } from '../xlsx-xstring.js';

// Re-use PPTX engine's theme generator (DrawingML theme is identical)
import { generateTheme } from '../native-pptx-engine/theme.js';

export async function generateNativeXlsx(
  protocol: XlsxDesignProtocol,
  outputPath: string
): Promise<void> {
  if (!protocol?.sheets?.length) {
    throw new Error('generateNativeXlsx: protocol must have at least one sheet');
  }
  const dir = path.dirname(outputPath);
  if (!safeExistsSync(dir)) {
    throw new Error(`generateNativeXlsx: output directory does not exist: ${dir}`);
  }
  const zip = new AdmZip();
  const sheetCount = protocol.sheets.length;

  // Count drawings, tables, and comment parts across all sheets
  let totalDrawings = 0;
  let totalTables = 0;
  let totalComments = 0;
  const sheetDrawingIndex: number[] = []; // per-sheet: drawing index (1-based) or 0
  const sheetTableIndices: number[][] = []; // per-sheet: array of table indices (1-based)
  const sheetCommentIndex: number[] = []; // per-sheet: comments index (1-based) or 0

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

    if (sheet.comments && sheet.comments.length > 0) {
      totalComments++;
      sheetCommentIndex.push(totalComments);
    } else {
      sheetCommentIndex.push(0);
    }
  }

  // 1. Core package files
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(generateContentTypes(sheetCount, totalDrawings, totalTables, totalComments), 'utf8')
  );
  zip.addFile('_rels/.rels', Buffer.from(generateGlobalRels(), 'utf8'));
  // Preserve a title from raw core.xml when present; otherwise omit dc:title
  // (do not invent "Kyberion Native Spreadsheet" — the reader treats that as empty).
  const packageTitle = (() => {
    const raw = protocol.rawParts?.['docProps/core.xml'];
    if (!raw) return undefined;
    try {
      return parseOoxmlCorePropertiesXml(Buffer.from(raw, 'base64').toString('utf8')).title;
    } catch {
      return undefined;
    }
  })();
  const titleXml = packageTitle ? `  <dc:title>${sanitizeXmlText(packageTitle)}</dc:title>\n` : '';
  zip.addFile(
    'docProps/core.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${titleXml}<dcterms:created xsi:type="dcterms:W3CDTF">${protocol.generatedAt || nowIso()}</dcterms:created>
</cp:coreProperties>`,
      'utf8'
    )
  );
  zip.addFile(
    'docProps/app.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Kyberion Native XLSX Engine</Application>
</Properties>`,
      'utf8'
    )
  );

  // 2. Workbook
  zip.addFile('xl/workbook.xml', Buffer.from(generateWorkbook(protocol), 'utf8'));
  zip.addFile('xl/_rels/workbook.xml.rels', Buffer.from(generateWorkbookRels(sheetCount), 'utf8'));

  // 3. Theme
  const themeColors: Record<string, string> = {};
  for (const [key, val] of Object.entries(protocol.theme.colors)) {
    themeColors[key] = val;
  }
  zip.addFile(
    'xl/theme/theme1.xml',
    Buffer.from(protocol.theme.rawXml || generateTheme(themeColors), 'utf8')
  );

  // 4. Styles
  zip.addFile('xl/styles.xml', Buffer.from(generateStyles(protocol), 'utf8'));

  // 5. Shared Strings
  // Build SST map for cell value → index lookup
  const sstMap = new Map<string, number>();
  protocol.sharedStrings.forEach((s, i) => {
    sstMap.set(s, i);
  });
  zip.addFile('xl/sharedStrings.xml', Buffer.from(generateSharedStrings(protocol), 'utf8'));

  // 6. Worksheets, Drawings, Tables, Comments
  protocol.sheets.forEach((sheet, sheetIdx) => {
    const sheetNum = sheetIdx + 1;
    const drawingIdx = sheetDrawingIndex[sheetIdx];
    const tableIds = sheetTableIndices[sheetIdx];
    const commentIdx = sheetCommentIndex[sheetIdx];

    // Build sheet relationships
    const sheetExtras: Array<{
      id: string;
      type: string;
      target: string;
      targetMode?: string;
    }> = [];
    let rIdCounter = 1;

    let drawingRId: string | undefined;
    if (drawingIdx > 0) {
      drawingRId = `rId${rIdCounter}`;
      sheetExtras.push({
        id: drawingRId,
        type: 'drawing',
        target: `../drawings/drawing${drawingIdx}.xml`,
      });
      rIdCounter += 1;
    }

    const tableRIds: string[] = [];
    for (const tableId of tableIds) {
      const id = `rId${rIdCounter++}`;
      tableRIds.push(id);
      sheetExtras.push({
        id,
        type: 'table',
        target: `../tables/table${tableId}.xml`,
      });
    }

    let legacyDrawingRId: string | undefined;
    if (commentIdx > 0) {
      const commentsRId = `rId${rIdCounter++}`;
      sheetExtras.push({
        id: commentsRId,
        type: 'comments',
        target: `../comments${commentIdx}.xml`,
      });
      legacyDrawingRId = `rId${rIdCounter++}`;
      sheetExtras.push({
        id: legacyDrawingRId,
        type: 'vmlDrawing',
        target: `../drawings/vmlDrawing${commentIdx}.vml`,
      });
    }

    const hyperlinkRIds = new Map<string, string>();
    for (const link of sheet.hyperlinks || []) {
      if (!link.external && !/^https?:\/\//i.test(link.target) && !link.target.includes('://')) {
        continue;
      }
      // Strip #fragment for the relationship target
      const href = (link.target.split('#')[0] || link.target).trim();
      if (!href) continue;
      const id = `rId${rIdCounter++}`;
      hyperlinkRIds.set(link.ref, id);
      sheetExtras.push({
        id,
        type: 'hyperlink',
        target: escapeXlsxAttr(href),
        targetMode: 'External',
      });
    }

    zip.addFile(
      `xl/worksheets/sheet${sheetNum}.xml`,
      Buffer.from(
        generateWorksheet(sheet, drawingRId, sstMap, tableRIds, {
          hyperlinkRIds,
          legacyDrawingRId,
        }),
        'utf8'
      )
    );

    // Sheet rels: prefer rawParts version (preserves VML/comment/printerSettings refs)
    // unless we are synthesizing comments/hyperlinks ourselves.
    const sheetRelsPath = `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`;
    const synthesizeRels =
      hyperlinkRIds.size > 0 ||
      commentIdx > 0 ||
      (!protocol.rawParts?.[sheetRelsPath] && sheetExtras.length > 0);
    if (protocol.rawParts?.[sheetRelsPath] && !synthesizeRels) {
      zip.addFile(sheetRelsPath, Buffer.from(protocol.rawParts[sheetRelsPath], 'base64'));
    } else if (sheetExtras.length > 0) {
      zip.addFile(sheetRelsPath, Buffer.from(generateSheetRels(sheetExtras), 'utf8'));
    }

    // Drawing XML — plus image binaries + the drawing's .rels so that
    // r:embed references inside <xdr:pic> actually resolve.
    if (drawingIdx > 0 && sheet.drawing) {
      zip.addFile(
        `xl/drawings/drawing${drawingIdx}.xml`,
        Buffer.from(generateDrawing(sheet.drawing, protocol.locale), 'utf8')
      );

      const imageRels = collectDrawingImageRels(sheet.drawing);
      if (imageRels.length > 0) {
        const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
        let rels = '';
        let imageSeq = 0;
        for (const { rId, element } of imageRels) {
          imageSeq += 1;
          const rawExt =
            (element.imagePath && path.extname(element.imagePath).slice(1).toLowerCase()) || 'png';
          const ext = ['png', 'jpg', 'jpeg'].includes(rawExt) ? rawExt : 'png';
          const mediaName = `sheet${sheetIdx + 1}-img${imageSeq}.${ext}`;
          let binary: Buffer | null = null;
          if (element.imageData) {
            binary = Buffer.from(element.imageData, 'base64');
          } else if (element.imagePath && safeExistsSync(element.imagePath)) {
            binary = safeReadFile(element.imagePath, { encoding: null }) as Buffer;
          }
          if (!binary) continue;
          zip.addFile(`xl/media/${mediaName}`, binary);
          rels += `  <Relationship Id="${rId}" Type="${RT}/image" Target="../media/${mediaName}"/>\n`;
        }
        if (rels) {
          zip.addFile(
            `xl/drawings/_rels/drawing${drawingIdx}.xml.rels`,
            Buffer.from(
              `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
                `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n` +
                `${rels}</Relationships>`,
              'utf8'
            )
          );
        }
      }
    }

    // Table XMLs
    sheet.tables.forEach((table, tableLocalIdx) => {
      const globalTableId = tableIds[tableLocalIdx];
      zip.addFile(`xl/tables/table${globalTableId}.xml`, Buffer.from(generateTable(table), 'utf8'));
    });

    // Comments + VML note shapes
    if (commentIdx > 0 && sheet.comments) {
      zip.addFile(
        `xl/comments${commentIdx}.xml`,
        Buffer.from(generateCommentsXml(sheet.comments), 'utf8')
      );
      zip.addFile(
        `xl/drawings/vmlDrawing${commentIdx}.vml`,
        Buffer.from(generateVmlDrawing(sheet.comments, commentIdx), 'utf8')
      );
    }
  });

  // 7. Inject rawParts (VML drawings, comments, printerSettings, calcChain, etc.)
  if (protocol.rawParts) {
    for (const [entryName, base64Data] of Object.entries(protocol.rawParts)) {
      // Skip entries we already generated
      if (!zip.getEntry(entryName)) {
        zip.addFile(entryName, Buffer.from(base64Data, 'base64'));
      }
    }
  }

  // Write ZIP to output
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  zip.writeZip(outputPath);
}
