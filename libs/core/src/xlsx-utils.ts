import * as path from 'path';
import JSZip from 'jszip';
import { safeReadFile } from '../secure-io.js';
import {
  XlsxDesignProtocol, XlsxWorksheet, XlsxRow, XlsxCell, XlsxColumn,
  XlsxMergeCell, XlsxFont, XlsxFill, XlsxBorder, XlsxBorderEdge,
  XlsxColor, XlsxNumberFormat, XlsxCellStyle, XlsxAlignment,
  XlsxNamedStyle, XlsxTextRun, XlsxTheme, XlsxDefinedName,
  XlsxSheetView, XlsxPageSetup, XlsxDrawing, XlsxDrawingElement,
  XlsxDrawingAnchor, XlsxConditionalFormat, XlsxDataValidation,
  XlsxAutoFilter, XlsxTable, XlsxTableColumn
} from './types/xlsx-protocol.js';

/**
 * XLSX Utilities v1.0.0 [Native OpenXML Extraction]
 * Distills an XLSX file into the XlsxDesignProtocol ADF.
 * Follows the PPTX pattern: preserve raw XML alongside parsed structures.
 */

// ─── XML Helpers ─────────────────────────────────────────────

function getAttr(xml: string, attr: string): string | undefined {
  const re = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function getTagContent(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function getTagFull(xml: string, tag: string): string | undefined {
  // Handles both self-closing and content tags
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>(?:[\\s\\S]*?<\\/${tag}>)?`, 'i');
  const m = xml.match(re);
  return m ? m[0] : undefined;
}

function getAllTags(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>(?:[\\s\\S]*?<\\/${tag}>)?`, 'gi');
  return xml.match(re) || [];
}

function emuToNum(emu: string | undefined): number {
  if (!emu) return 0;
  return parseInt(emu) || 0;
}

// ─── Color Extraction ────────────────────────────────────────

function extractColor(xml: string): XlsxColor | undefined {
  if (!xml) return undefined;
  const rgb = getAttr(xml, 'rgb');
  const theme = getAttr(xml, 'theme');
  const tint = getAttr(xml, 'tint');
  const indexed = getAttr(xml, 'indexed');
  const auto = getAttr(xml, 'auto');

  if (!rgb && !theme && !indexed && !auto) return undefined;

  const color: XlsxColor = {};
  if (rgb) color.rgb = '#' + (rgb.length === 8 ? rgb.substring(2) : rgb);
  if (theme !== undefined) color.theme = parseInt(theme);
  if (tint) color.tint = parseFloat(tint);
  if (indexed !== undefined) color.indexed = parseInt(indexed);
  if (auto === '1' || auto === 'true') color.auto = true;
  return color;
}

// ─── Theme Extraction ────────────────────────────────────────

function extractTheme(zip: JSZip): XlsxTheme {
  const theme: XlsxTheme = { colors: {} };
  const themeFile = zip.file('xl/theme/theme1.xml');
  if (!themeFile) return theme;

  const xml = (themeFile as any)._data;
  // We need to use async, but store for later
  theme.rawXml = '(deferred)';
  return theme;
}

async function extractThemeAsync(zip: JSZip): Promise<XlsxTheme> {
  const theme: XlsxTheme = { colors: {} };
  const themeFile = zip.file('xl/theme/theme1.xml');
  if (!themeFile) return theme;

  const xml = await themeFile.async('string');
  theme.rawXml = xml;

  const colorTags = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  for (const tag of colorTags) {
    const tagXml = getTagFull(xml, `a:${tag}`);
    if (tagXml) {
      const srgb = getAttr(tagXml, 'lastClr') || getAttr(tagXml, 'val');
      if (srgb) theme.colors[tag] = '#' + srgb;
      const sysClr = getTagFull(tagXml, 'a:sysClr');
      if (sysClr && !theme.colors[tag]) {
        const lastClr = getAttr(sysClr, 'lastClr');
        if (lastClr) theme.colors[tag] = '#' + lastClr;
      }
    }
  }

  // Fonts
  const majorFontXml = getTagFull(xml, 'a:majorFont');
  if (majorFontXml) {
    const latin = getTagFull(majorFontXml, 'a:latin');
    if (latin) theme.majorFont = getAttr(latin, 'typeface');
  }
  const minorFontXml = getTagFull(xml, 'a:minorFont');
  if (minorFontXml) {
    const latin = getTagFull(minorFontXml, 'a:latin');
    if (latin) theme.minorFont = getAttr(latin, 'typeface');
  }

  theme.name = getAttr(xml, 'name') || 'Default';
  return theme;
}

// ─── Shared Strings Extraction ───────────────────────────────

async function extractSharedStrings(zip: JSZip): Promise<{ plain: string[]; rich: XlsxTextRun[][] }> {
  const plain: string[] = [];
  const rich: XlsxTextRun[][] = [];

  const sstFile = zip.file('xl/sharedStrings.xml');
  if (!sstFile) return { plain, rich };

  const xml = await sstFile.async('string');
  const siTags = getAllTags(xml, 'si');

  for (const si of siTags) {
    // Check for rich text runs
    const rTags = getAllTags(si, 'r');
    if (rTags.length > 0) {
      const runs: XlsxTextRun[] = [];
      let plainText = '';
      for (const r of rTags) {
        const tTag = getTagContent(r, 't');
        const text = tTag || '';
        plainText += text;

        const run: XlsxTextRun = { text };
        const rPr = getTagFull(r, 'rPr');
        if (rPr) {
          run.font = extractFontFromXml(rPr);
        }
        runs.push(run);
      }
      plain.push(plainText);
      rich.push(runs);
    } else {
      const tTag = getTagContent(si, 't');
      plain.push(tTag || '');
      rich.push([{ text: tTag || '' }]);
    }
  }

  return { plain, rich };
}

// ─── Style Extraction ────────────────────────────────────────

function extractFontFromXml(xml: string): XlsxFont {
  const font: XlsxFont = {};
  const sz = getTagFull(xml, 'sz') || getTagFull(xml, 'x:sz');
  if (sz) font.size = parseFloat(getAttr(sz, 'val') || '11');

  const name = getTagFull(xml, 'name') || getTagFull(xml, 'rFont') || getTagFull(xml, 'x:name') || getTagFull(xml, 'x:rFont');
  if (name) font.name = getAttr(name, 'val');

  if (xml.includes('<b/>') || xml.includes('<b ') || xml.includes('<x:b/>') || xml.includes('<x:b ')) font.bold = true;
  if (xml.includes('<i/>') || xml.includes('<i ') || xml.includes('<x:i/>') || xml.includes('<x:i ')) font.italic = true;
  if (xml.includes('<u/>') || xml.includes('<u ') || xml.includes('<x:u/>') || xml.includes('<x:u ')) font.underline = true;
  if (xml.includes('<strike/>') || xml.includes('<x:strike/>')) font.strike = true;

  const colorTag = getTagFull(xml, 'color') || getTagFull(xml, 'x:color');
  if (colorTag) font.color = extractColor(colorTag);

  const family = getTagFull(xml, 'family') || getTagFull(xml, 'x:family');
  if (family) font.family = parseInt(getAttr(family, 'val') || '0');

  const scheme = getTagFull(xml, 'scheme') || getTagFull(xml, 'x:scheme');
  if (scheme) font.scheme = getAttr(scheme, 'val') as any;

  return font;
}

function extractFillFromXml(xml: string): XlsxFill {
  const fill: XlsxFill = {};
  const patternFill = getTagFull(xml, 'patternFill') || getTagFull(xml, 'x:patternFill');
  if (patternFill) {
    fill.patternType = getAttr(patternFill, 'patternType') as any;
    const fg = getTagFull(patternFill, 'fgColor') || getTagFull(patternFill, 'x:fgColor');
    if (fg) fill.fgColor = extractColor(fg);
    const bg = getTagFull(patternFill, 'bgColor') || getTagFull(patternFill, 'x:bgColor');
    if (bg) fill.bgColor = extractColor(bg);
  }
  return fill;
}

function extractBorderEdge(xml: string, tag: string): XlsxBorderEdge | undefined {
  const edgeXml = getTagFull(xml, tag) || getTagFull(xml, `x:${tag}`);
  if (!edgeXml) return undefined;
  const style = getAttr(edgeXml, 'style');
  if (!style || style === 'none') return undefined;
  const edge: XlsxBorderEdge = { style: style as any };
  const color = getTagFull(edgeXml, 'color') || getTagFull(edgeXml, 'x:color');
  if (color) edge.color = extractColor(color);
  return edge;
}

function extractBorderFromXml(xml: string): XlsxBorder {
  const border: XlsxBorder = {};
  border.left = extractBorderEdge(xml, 'left');
  border.right = extractBorderEdge(xml, 'right');
  border.top = extractBorderEdge(xml, 'top');
  border.bottom = extractBorderEdge(xml, 'bottom');
  border.diagonal = extractBorderEdge(xml, 'diagonal');
  if (getAttr(xml, 'diagonalUp') === '1') border.diagonalUp = true;
  if (getAttr(xml, 'diagonalDown') === '1') border.diagonalDown = true;
  return border;
}

function extractAlignmentFromXml(xml: string): XlsxAlignment | undefined {
  const alignXml = getTagFull(xml, 'alignment') || getTagFull(xml, 'x:alignment');
  if (!alignXml) return undefined;
  const a: XlsxAlignment = {};
  const h = getAttr(alignXml, 'horizontal');
  if (h) a.horizontal = h as any;
  const v = getAttr(alignXml, 'vertical');
  if (v) a.vertical = v as any;
  if (getAttr(alignXml, 'wrapText') === '1') a.wrapText = true;
  if (getAttr(alignXml, 'shrinkToFit') === '1') a.shrinkToFit = true;
  const rot = getAttr(alignXml, 'textRotation');
  if (rot) a.textRotation = parseInt(rot);
  const indent = getAttr(alignXml, 'indent');
  if (indent) a.indent = parseInt(indent);
  return a;
}

async function extractStyles(zip: JSZip): Promise<XlsxDesignProtocol['styles']> {
  const styles: XlsxDesignProtocol['styles'] = {
    fonts: [], fills: [], borders: [], numFmts: [],
    cellXfs: [], namedStyles: [], tableStyles: []
  };

  const stylesFile = zip.file('xl/styles.xml');
  if (!stylesFile) return styles;

  const xml = await stylesFile.async('string');
  styles.rawStylesXml = xml;

  // Number formats
  const numFmtTags = getAllTags(xml, 'numFmt');
  for (const nf of numFmtTags) {
    const id = parseInt(getAttr(nf, 'numFmtId') || '0');
    const code = getAttr(nf, 'formatCode') || '';
    styles.numFmts.push({ id, formatCode: code });
  }

  // Fonts
  const fontsSection = getTagContent(xml, 'fonts') || getTagContent(xml, 'x:fonts');
  if (fontsSection) {
    const fontTags = getAllTags(fontsSection, 'font');
    if (fontTags.length === 0) {
      // Try with namespace prefix
      const xFontTags = getAllTags(fontsSection, 'x:font');
      for (const f of xFontTags) styles.fonts.push(extractFontFromXml(f));
    } else {
      for (const f of fontTags) styles.fonts.push(extractFontFromXml(f));
    }
  }

  // Fills
  const fillsSection = getTagContent(xml, 'fills') || getTagContent(xml, 'x:fills');
  if (fillsSection) {
    const fillTags = getAllTags(fillsSection, 'fill').length > 0
      ? getAllTags(fillsSection, 'fill')
      : getAllTags(fillsSection, 'x:fill');
    for (const f of fillTags) styles.fills.push(extractFillFromXml(f));
  }

  // Borders
  const bordersSection = getTagContent(xml, 'borders') || getTagContent(xml, 'x:borders');
  if (bordersSection) {
    const borderTags = getAllTags(bordersSection, 'border').length > 0
      ? getAllTags(bordersSection, 'border')
      : getAllTags(bordersSection, 'x:border');
    for (const b of borderTags) styles.borders.push(extractBorderFromXml(b));
  }

  // Cell format index table (cellXfs)
  const xfsSection = getTagContent(xml, 'cellXfs') || getTagContent(xml, 'x:cellXfs');
  if (xfsSection) {
    const xfTags = getAllTags(xfsSection, 'xf').length > 0
      ? getAllTags(xfsSection, 'xf')
      : getAllTags(xfsSection, 'x:xf');
    for (const xf of xfTags) {
      const cs: XlsxCellStyle = { xfXml: xf };
      const fontId = parseInt(getAttr(xf, 'fontId') || '0');
      const fillId = parseInt(getAttr(xf, 'fillId') || '0');
      const borderId = parseInt(getAttr(xf, 'borderId') || '0');
      const numFmtId = parseInt(getAttr(xf, 'numFmtId') || '0');

      if (styles.fonts[fontId]) cs.font = styles.fonts[fontId];
      if (styles.fills[fillId]) cs.fill = styles.fills[fillId];
      if (styles.borders[borderId]) cs.border = styles.borders[borderId];

      const builtinFmt = styles.numFmts.find(n => n.id === numFmtId);
      if (builtinFmt) cs.numFmt = builtinFmt;
      else if (numFmtId > 0) cs.numFmt = { id: numFmtId, formatCode: getBuiltinNumFmt(numFmtId) };

      cs.alignment = extractAlignmentFromXml(xf);

      const prot = getTagFull(xf, 'protection') || getTagFull(xf, 'x:protection');
      if (prot) {
        cs.protection = {};
        if (getAttr(prot, 'locked') === '1') cs.protection.locked = true;
        if (getAttr(prot, 'hidden') === '1') cs.protection.hidden = true;
      }

      styles.cellXfs.push(cs);
    }
  }

  // Named styles
  const cellStylesSection = getTagContent(xml, 'cellStyles') || getTagContent(xml, 'x:cellStyles');
  if (cellStylesSection) {
    const csTags = getAllTags(cellStylesSection, 'cellStyle').length > 0
      ? getAllTags(cellStylesSection, 'cellStyle')
      : getAllTags(cellStylesSection, 'x:cellStyle');
    for (const cs of csTags) {
      const name = getAttr(cs, 'name') || 'Normal';
      const xfId = parseInt(getAttr(cs, 'xfId') || '0');
      const builtinId = getAttr(cs, 'builtinId');
      styles.namedStyles.push({
        name, xfId,
        builtinId: builtinId ? parseInt(builtinId) : undefined,
        style: styles.cellXfs[xfId] || {}
      });
    }
  }

  return styles;
}

function getBuiltinNumFmt(id: number): string {
  const builtins: { [key: number]: string } = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
    9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
    14: 'mm-dd-yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
    18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss',
    22: 'm/d/yy h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)',
    39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
    45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@'
  };
  return builtins[id] || 'General';
}

// ─── Worksheet Extraction ────────────────────────────────────

async function extractWorksheet(zip: JSZip, sheetPath: string, sheetName: string, sheetId: string, sharedStrings: string[]): Promise<XlsxWorksheet> {
  const ws: XlsxWorksheet = {
    id: sheetId,
    name: sheetName,
    columns: [],
    rows: [],
    mergeCells: [],
    tables: [],
    conditionalFormats: [],
    dataValidations: []
  };

  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) return ws;

  const xml = await sheetFile.async('string');

  // Dimension
  const dimTag = getTagFull(xml, 'dimension') || getTagFull(xml, 'x:dimension');
  if (dimTag) ws.dimension = getAttr(dimTag, 'ref');

  // Sheet properties
  const sheetPr = getTagFull(xml, 'sheetPr') || getTagFull(xml, 'x:sheetPr');
  if (sheetPr) ws.sheetPrXml = sheetPr;

  // Sheet view
  const svTag = getTagFull(xml, 'sheetView') || getTagFull(xml, 'x:sheetView');
  if (svTag) {
    ws.sheetView = { rawXml: svTag };
    if (getAttr(svTag, 'tabSelected') === '1') ws.sheetView.tabSelected = true;
    if (getAttr(svTag, 'showGridLines') === '0') ws.sheetView.showGridLines = false;
    const zoom = getAttr(svTag, 'zoomScale');
    if (zoom) ws.sheetView.zoomScale = parseInt(zoom);

    const pane = getTagFull(svTag, 'pane') || getTagFull(svTag, 'x:pane');
    if (pane) {
      const ySplit = getAttr(pane, 'ySplit');
      const xSplit = getAttr(pane, 'xSplit');
      if (ySplit) ws.sheetView.frozenRows = parseInt(ySplit);
      if (xSplit) ws.sheetView.frozenCols = parseInt(xSplit);
    }
  }

  // Columns
  const colTags = getAllTags(xml, 'col');
  if (colTags.length === 0) {
    const xColTags = getAllTags(xml, 'x:col');
    for (const c of xColTags) extractColDef(c, ws);
  } else {
    for (const c of colTags) extractColDef(c, ws);
  }

  // Rows and cells
  const rowTags = getAllTags(xml, 'row');
  const rowSource = rowTags.length > 0 ? rowTags : getAllTags(xml, 'x:row');
  for (const rowXml of rowSource) {
    const row = extractRow(rowXml, sharedStrings);
    if (row) ws.rows.push(row);
  }

  // Merge cells
  const mcTags = getAllTags(xml, 'mergeCell');
  const mcSource = mcTags.length > 0 ? mcTags : getAllTags(xml, 'x:mergeCell');
  for (const mc of mcSource) {
    const ref = getAttr(mc, 'ref');
    if (ref) ws.mergeCells.push({ ref });
  }

  // Auto filter
  const afTag = getTagFull(xml, 'autoFilter') || getTagFull(xml, 'x:autoFilter');
  if (afTag) {
    ws.autoFilter = { ref: getAttr(afTag, 'ref') || '', rawXml: afTag };
  }

  // Conditional formatting
  const cfTags = getAllTags(xml, 'conditionalFormatting');
  const cfSource = cfTags.length > 0 ? cfTags : getAllTags(xml, 'x:conditionalFormatting');
  for (const cf of cfSource) {
    const sqref = getAttr(cf, 'sqref') || '';
    const rules = getAllTags(cf, 'cfRule').length > 0
      ? getAllTags(cf, 'cfRule')
      : getAllTags(cf, 'x:cfRule');
    ws.conditionalFormats.push({
      sqref,
      rules: rules.map(r => ({
        type: getAttr(r, 'type') || '',
        priority: parseInt(getAttr(r, 'priority') || '0'),
        operator: getAttr(r, 'operator'),
        rawXml: r
      }))
    });
  }

  // Data validations
  const dvTags = getAllTags(xml, 'dataValidation');
  const dvSource = dvTags.length > 0 ? dvTags : getAllTags(xml, 'x:dataValidation');
  for (const dv of dvSource) {
    ws.dataValidations.push({
      sqref: getAttr(dv, 'sqref') || '',
      type: getAttr(dv, 'type') as any,
      rawXml: dv
    });
  }

  // Page setup
  const psTag = getTagFull(xml, 'pageSetup') || getTagFull(xml, 'x:pageSetup');
  if (psTag) {
    ws.pageSetup = {
      paperSize: parseInt(getAttr(psTag, 'paperSize') || '0') || undefined,
      orientation: getAttr(psTag, 'orientation') as any,
      rawXml: psTag
    };
  }

  // Drawing reference (extracted separately)
  const drawingTag = getTagFull(xml, 'drawing') || getTagFull(xml, 'x:drawing');
  if (drawingTag) {
    const rId = getAttr(drawingTag, 'r:id');
    if (rId) {
      ws.drawing = await extractDrawing(zip, sheetPath, rId);
    }
  }

  return ws;
}

function extractColDef(xml: string, ws: XlsxWorksheet) {
  const min = parseInt(getAttr(xml, 'min') || '1');
  const max = parseInt(getAttr(xml, 'max') || '1');
  const col: XlsxColumn = { min, max };
  const width = getAttr(xml, 'width');
  if (width) col.width = parseFloat(width);
  if (getAttr(xml, 'customWidth') === '1') col.customWidth = true;
  if (getAttr(xml, 'hidden') === '1') col.hidden = true;
  const style = getAttr(xml, 'style');
  if (style) col.styleIndex = parseInt(style);
  if (getAttr(xml, 'bestFit') === '1') col.bestFit = true;
  ws.columns.push(col);
}

function extractRow(xml: string, sharedStrings: string[]): XlsxRow | null {
  const rNum = getAttr(xml, 'r');
  if (!rNum) return null;

  const row: XlsxRow = {
    index: parseInt(rNum),
    cells: []
  };

  const ht = getAttr(xml, 'ht');
  if (ht) row.height = parseFloat(ht);
  if (getAttr(xml, 'customHeight') === '1') row.customHeight = true;
  if (getAttr(xml, 'hidden') === '1') row.hidden = true;
  const outlineLevel = getAttr(xml, 'outlineLevel');
  if (outlineLevel) row.outlineLevel = parseInt(outlineLevel);
  const s = getAttr(xml, 's');
  if (s) row.styleIndex = parseInt(s);

  // Cells
  const cellTags = getAllTags(xml, 'c');
  const cellSource = cellTags.length > 0 ? cellTags : getAllTags(xml, 'x:c');
  for (const cXml of cellSource) {
    const cell = extractCell(cXml, sharedStrings);
    if (cell) row.cells.push(cell);
  }

  return row;
}

function extractCell(xml: string, sharedStrings: string[]): XlsxCell | null {
  const ref = getAttr(xml, 'r');
  if (!ref) return null;

  const cell: XlsxCell = { ref };
  const t = getAttr(xml, 't');
  if (t) cell.type = t as any;
  const s = getAttr(xml, 's');
  if (s) cell.styleIndex = parseInt(s);

  // Value
  const vContent = getTagContent(xml, 'v') || getTagContent(xml, 'x:v');
  if (vContent !== undefined) {
    if (t === 's') {
      // Shared string reference
      const idx = parseInt(vContent);
      cell.value = sharedStrings[idx] || vContent;
    } else if (t === 'b') {
      cell.value = vContent === '1';
    } else if (t === 'n' || !t) {
      const num = parseFloat(vContent);
      cell.value = isNaN(num) ? vContent : num;
    } else {
      cell.value = vContent;
    }
  }

  // Formula
  const fContent = getTagContent(xml, 'f') || getTagContent(xml, 'x:f');
  if (fContent) cell.formula = fContent;

  // Inline string
  if (t === 'inlineStr') {
    const isTag = getTagFull(xml, 'is') || getTagFull(xml, 'x:is');
    if (isTag) {
      const tContent = getTagContent(isTag, 't') || getTagContent(isTag, 'x:t');
      if (tContent) cell.value = tContent;
    }
  }

  return cell;
}

// ─── Drawing Extraction ──────────────────────────────────────

async function extractDrawing(zip: JSZip, sheetPath: string, rId: string): Promise<XlsxDrawing> {
  const drawing: XlsxDrawing = { elements: [] };

  // Resolve relationship to find drawing path
  const sheetDir = path.dirname(sheetPath);
  const relsPath = sheetDir + '/_rels/' + path.basename(sheetPath) + '.rels';
  const relsFile = zip.file(relsPath);
  if (!relsFile) return drawing;

  const relsXml = await relsFile.async('string');
  const relTags = getAllTags(relsXml, 'Relationship');
  const drawingRel = relTags.find(r => getAttr(r, 'Id') === rId);
  if (!drawingRel) return drawing;

  const drawingTarget = getAttr(drawingRel, 'Target');
  if (!drawingTarget) return drawing;

  const drawingPath = drawingTarget.startsWith('/')
    ? drawingTarget.substring(1)
    : path.join(sheetDir, drawingTarget).replace(/\\/g, '/');

  const normalizedPath = drawingPath.replace(/^xl\/\.\.\//, '');
  const drawingFile = zip.file(normalizedPath) || zip.file(drawingPath) || zip.file('xl/drawings/' + path.basename(drawingPath));
  if (!drawingFile) return drawing;

  const drawingXml = await drawingFile.async('string');
  drawing.rawXml = drawingXml;

  // Extract two-cell anchors
  const twoCellAnchors = getAllTags(drawingXml, 'xdr:twoCellAnchor');
  for (const anchor of twoCellAnchors) {
    const el = extractDrawingElement(anchor, 'twoCellAnchor');
    if (el) drawing.elements.push(el);
  }

  // Extract one-cell anchors
  const oneCellAnchors = getAllTags(drawingXml, 'xdr:oneCellAnchor');
  for (const anchor of oneCellAnchors) {
    const el = extractDrawingElement(anchor, 'oneCellAnchor');
    if (el) drawing.elements.push(el);
  }

  // Embed image data for pic elements
  const drawingDir = path.dirname(normalizedPath || drawingPath);
  const drawingRelsPath = drawingDir + '/_rels/' + path.basename(normalizedPath || drawingPath) + '.rels';
  const drawingRelsFile = zip.file(drawingRelsPath);
  if (drawingRelsFile) {
    const drawingRelsXml = await drawingRelsFile.async('string');
    for (const el of drawing.elements) {
      if (el.type === 'image' && el.rawXml) {
        const embedMatch = el.rawXml.match(/r:embed="([^"]*)"/);
        if (embedMatch) {
          const imgRelTag = getAllTags(drawingRelsXml, 'Relationship').find(r => getAttr(r, 'Id') === embedMatch[1]);
          if (imgRelTag) {
            const imgTarget = getAttr(imgRelTag, 'Target') || '';
            const imgPath = imgTarget.startsWith('/')
              ? imgTarget.substring(1)
              : path.join(drawingDir, imgTarget).replace(/\\/g, '/');
            const imgFile = zip.file(imgPath) || zip.file('xl/media/' + path.basename(imgTarget));
            if (imgFile) {
              const imgBuf = await imgFile.async('nodebuffer');
              el.imageData = imgBuf.toString('base64');
            }
          }
        }
      }
    }
  }

  return drawing;
}

function extractDrawingElement(xml: string, anchorType: string): XlsxDrawingElement | null {
  const anchor: XlsxDrawingAnchor = { type: anchorType as any };

  // From position
  const fromTag = getTagFull(xml, 'xdr:from');
  if (fromTag) {
    anchor.from = {
      col: parseInt(getTagContent(fromTag, 'xdr:col') || '0'),
      colOffset: emuToNum(getTagContent(fromTag, 'xdr:colOff')),
      row: parseInt(getTagContent(fromTag, 'xdr:row') || '0'),
      rowOffset: emuToNum(getTagContent(fromTag, 'xdr:rowOff'))
    };
  }

  // To position
  const toTag = getTagFull(xml, 'xdr:to');
  if (toTag) {
    anchor.to = {
      col: parseInt(getTagContent(toTag, 'xdr:col') || '0'),
      colOffset: emuToNum(getTagContent(toTag, 'xdr:colOff')),
      row: parseInt(getTagContent(toTag, 'xdr:row') || '0'),
      rowOffset: emuToNum(getTagContent(toTag, 'xdr:rowOff'))
    };
  }

  // Determine element type
  let elementType: XlsxDrawingElement['type'] = 'shape';
  let name: string | undefined;
  let text: string | undefined;
  let textRuns: XlsxTextRun[] | undefined;
  let spPrXml: string | undefined;
  let txBodyXml: string | undefined;
  let rawXml = xml;

  // Shape (xdr:sp)
  const spTag = getTagFull(xml, 'xdr:sp');
  if (spTag) {
    elementType = 'shape';
    const nvSpPr = getTagFull(spTag, 'xdr:nvSpPr');
    if (nvSpPr) {
      const cNvPr = getTagFull(nvSpPr, 'xdr:cNvPr');
      if (cNvPr) name = getAttr(cNvPr, 'name');
    }
    spPrXml = getTagFull(spTag, 'xdr:spPr');
    txBodyXml = getTagFull(spTag, 'xdr:txBody');

    // Extract text from txBody
    if (txBodyXml) {
      const { plainText, runs } = extractDrawingText(txBodyXml);
      text = plainText;
      textRuns = runs;
    }
  }

  // Picture (xdr:pic)
  const picTag = getTagFull(xml, 'xdr:pic');
  if (picTag) {
    elementType = 'image';
    const nvPicPr = getTagFull(picTag, 'xdr:nvPicPr');
    if (nvPicPr) {
      const cNvPr = getTagFull(nvPicPr, 'xdr:cNvPr');
      if (cNvPr) name = getAttr(cNvPr, 'name');
    }
  }

  // Group shape (xdr:grpSp)
  const grpTag = getTagFull(xml, 'xdr:grpSp');
  if (grpTag) {
    elementType = 'group';
  }

  // Connector (xdr:cxnSp)
  const cxnTag = getTagFull(xml, 'xdr:cxnSp');
  if (cxnTag) {
    elementType = 'connector';
  }

  return {
    type: elementType,
    anchor,
    name,
    text,
    textRuns,
    spPrXml,
    txBodyXml,
    rawXml
  };
}

function extractDrawingText(txBodyXml: string): { plainText: string; runs: XlsxTextRun[] } {
  const runs: XlsxTextRun[] = [];
  let plainText = '';

  // Extract <a:r> (text runs) and <a:t> tags
  const aTags = getAllTags(txBodyXml, 'a:r');
  if (aTags.length > 0) {
    for (const aRun of aTags) {
      const tContent = getTagContent(aRun, 'a:t');
      if (tContent) {
        plainText += tContent;
        const run: XlsxTextRun = { text: tContent };
        const rPr = getTagFull(aRun, 'a:rPr');
        if (rPr) {
          run.font = {};
          const sz = getAttr(rPr, 'sz');
          if (sz) run.font.size = parseInt(sz) / 100;
          if (getAttr(rPr, 'b') === '1') run.font.bold = true;
          if (getAttr(rPr, 'i') === '1') run.font.italic = true;
          const solidFill = getTagFull(rPr, 'a:solidFill');
          if (solidFill) {
            const srgb = getTagFull(solidFill, 'a:srgbClr');
            if (srgb) run.font.color = { rgb: '#' + (getAttr(srgb, 'val') || '000000') };
          }
          const latin = getTagFull(rPr, 'a:latin');
          if (latin) run.font.name = getAttr(latin, 'typeface');
        }
        runs.push(run);
      }
    }
  } else {
    // Direct <a:t> without runs
    const directT = getAllTags(txBodyXml, 'a:t');
    for (const t of directT) {
      const content = t.replace(/<\/?a:t[^>]*>/g, '').trim();
      if (content) {
        plainText += content;
        runs.push({ text: content });
      }
    }
  }

  return { plainText, runs };
}

// ─── Table Extraction ────────────────────────────────────────

async function extractTables(zip: JSZip, sheetPath: string): Promise<XlsxTable[]> {
  const tables: XlsxTable[] = [];
  const sheetDir = path.dirname(sheetPath);
  const relsPath = sheetDir + '/_rels/' + path.basename(sheetPath) + '.rels';
  const relsFile = zip.file(relsPath);
  if (!relsFile) return tables;

  const relsXml = await relsFile.async('string');
  const relTags = getAllTags(relsXml, 'Relationship');
  const tableRels = relTags.filter(r => (getAttr(r, 'Type') || '').includes('table'));

  for (const rel of tableRels) {
    const target = getAttr(rel, 'Target');
    if (!target) continue;
    const tablePath = target.startsWith('/')
      ? target.substring(1)
      : path.join(sheetDir, target).replace(/\\/g, '/');

    const tableFile = zip.file(tablePath) || zip.file('xl/' + target.replace('../', ''));
    if (!tableFile) continue;

    const tableXml = await tableFile.async('string');
    const id = parseInt(getAttr(tableXml, 'id') || '0');
    const name = getAttr(tableXml, 'name') || '';
    const displayName = getAttr(tableXml, 'displayName') || name;
    const ref = getAttr(tableXml, 'ref') || '';

    const columns: XlsxTableColumn[] = [];
    const colTags = getAllTags(tableXml, 'tableColumn');
    for (const col of colTags) {
      columns.push({
        id: parseInt(getAttr(col, 'id') || '0'),
        name: getAttr(col, 'name') || ''
      });
    }

    tables.push({ id, name, displayName, ref, columns, rawXml: tableXml });
  }

  return tables;
}

// ─── Workbook Level Extraction ───────────────────────────────

async function extractWorkbook(zip: JSZip): Promise<{
  sheets: Array<{ name: string; sheetId: string; rId: string; state?: string }>;
  definedNames: XlsxDefinedName[];
  properties?: any;
}> {
  const result: any = { sheets: [], definedNames: [] };

  const wbFile = zip.file('xl/workbook.xml');
  if (!wbFile) return result;

  const xml = await wbFile.async('string');

  // Sheets
  const sheetTags = getAllTags(xml, 'sheet');
  const sheetSource = sheetTags.length > 0 ? sheetTags : getAllTags(xml, 'x:sheet');
  for (const s of sheetSource) {
    result.sheets.push({
      name: getAttr(s, 'name') || '',
      sheetId: getAttr(s, 'sheetId') || '',
      rId: getAttr(s, 'r:id') || '',
      state: getAttr(s, 'state')
    });
  }

  // Defined names
  const dnTags = getAllTags(xml, 'definedName');
  const dnSource = dnTags.length > 0 ? dnTags : getAllTags(xml, 'x:definedName');
  for (const dn of dnSource) {
    const name = getAttr(dn, 'name') || '';
    const value = dn.replace(/<[^>]+>/g, '').trim();
    const localSheetId = getAttr(dn, 'localSheetId');
    result.definedNames.push({
      name, value,
      localSheetId: localSheetId ? parseInt(localSheetId) : undefined,
      hidden: getAttr(dn, 'hidden') === '1'
    });
  }

  return result;
}

async function resolveSheetPaths(zip: JSZip): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const relsFile = zip.file('xl/_rels/workbook.xml.rels');
  if (!relsFile) return map;

  const relsXml = await relsFile.async('string');
  const relTags = getAllTags(relsXml, 'Relationship');
  for (const r of relTags) {
    const id = getAttr(r, 'Id');
    const target = getAttr(r, 'Target');
    if (id && target) {
      const fullPath = target.startsWith('/') ? target.substring(1) : 'xl/' + target;
      map.set(id, fullPath);
    }
  }
  return map;
}

// ─── Main Entry Point ────────────────────────────────────────

export async function distillXlsxDesign(filePath: string): Promise<XlsxDesignProtocol> {
  const buffer = safeReadFile(filePath, { encoding: null }) as Buffer;
  const zip = await JSZip.loadAsync(buffer);

  // 1. Theme
  const theme = await extractThemeAsync(zip);

  // 2. Shared strings
  const { plain: sharedStrings, rich: sharedStringsRich } = await extractSharedStrings(zip);

  // 3. Styles
  const styles = await extractStyles(zip);

  // 4. Workbook structure
  const wb = await extractWorkbook(zip);
  const sheetPaths = await resolveSheetPaths(zip);

  // 5. Worksheets
  const sheets: XlsxWorksheet[] = [];
  for (const sheet of wb.sheets) {
    const sheetPath = sheetPaths.get(sheet.rId);
    if (!sheetPath) continue;

    const ws = await extractWorksheet(zip, sheetPath, sheet.name, `sheet${sheet.sheetId}`, sharedStrings);
    if (sheet.state) ws.state = sheet.state as any;

    // Extract tables for this sheet
    ws.tables = await extractTables(zip, sheetPath);

    sheets.push(ws);
  }

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    theme,
    styles,
    sharedStrings,
    sharedStringsRich,
    definedNames: wb.definedNames,
    sheets
  };
}
