/**
 * DOCX Design Protocol Extractor
 * Extracts a DocxDesignProtocol ADF from a .docx file using JSZip.
 * Follows the same architecture pattern as xlsx-utils.ts and pptx-utils.ts.
 */
import JSZip from 'jszip';
import { safeReadFile } from '../secure-io.js';
import type {
  DocxDesignProtocol,
  DocxTheme,
  DocxStyleDef,
  DocxBlockContent,
  DocxParagraph,
  DocxParagraphContent,
  DocxParagraphProperties,
  DocxRun,
  DocxRunContent,
  DocxRunProperties,
  DocxColor,
  DocxBorderEdge,
  DocxShading,
  DocxTable,
  DocxTableRow,
  DocxTableCell,
  DocxTableProperties,
  DocxTableCellProperties,
  DocxSectionProperties,
  DocxHeaderFooter,
  DocxDrawing,
  DocxHyperlink,
  DocxAbstractNum,
  DocxNum,
} from './types/docx-protocol.js';

// ─── XML Helpers ────────────────────────────────────────────

function getAttr(xml: string, attr: string): string | undefined {
  // Match both w:attr="val" and attr="val"
  const re = new RegExp(`(?:w:|r:|wp:|a:|pic:)?${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function getAttrExact(xml: string, prefix: string, attr: string): string | undefined {
  const re = new RegExp(`${prefix}:${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function getSimpleAttr(xml: string, attr: string): string | undefined {
  const re = new RegExp(`${attr}="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function getTagContent(xml: string, tag: string): string | undefined {
  // Handle both w:tag and tag (with optional namespace)
  const patterns = [
    new RegExp(`<(?:w:|r:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:w:|r:)?${tag}>`, 'i'),
    new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return m[1];
  }
  return undefined;
}

function getTagFull(xml: string, tag: string): string | undefined {
  const patterns = [
    new RegExp(`<(?:w:)?${tag}(?:\\s[^>]*)?\\/?>(?:[\\s\\S]*?<\\/(?:w:)?${tag}>)?`, 'i'),
    new RegExp(`<${tag}(?:\\s[^>]*)?\\/?>(?:[\\s\\S]*?<\\/${tag}>)?`, 'i'),
  ];
  for (const re of patterns) {
    const m = xml.match(re);
    if (m) return m[0];
  }
  return undefined;
}

function getAllTags(xml: string, tag: string): string[] {
  const results: string[] = [];
  // Match both self-closing and paired tags
  const re = new RegExp(`<(?:w:|r:|wp:|a:|pic:)?${tag}(?:\\s[^>]*)?\\/?>(?:[\\s\\S]*?<\\/(?:w:|r:|wp:|a:|pic:)?${tag}>)?`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[0]);
  }
  return results;
}

function getAllTagsNS(xml: string, ns: string, tag: string): string[] {
  const results: string[] = [];
  const re = new RegExp(`<${ns}:${tag}(?:\\s[^>]*)?\\/?>(?:[\\s\\S]*?<\\/${ns}:${tag}>)?`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) {
    results.push(m[0]);
  }
  return results;
}

function getTagContentNS(xml: string, ns: string, tag: string): string | undefined {
  const re = new RegExp(`<${ns}:${tag}[^>]*>([\\s\\S]*?)<\\/${ns}:${tag}>`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function getBoolTag(xml: string, tag: string): boolean | undefined {
  // w:tag/> means true, w:tag w:val="0" means false
  const re = new RegExp(`<w:${tag}(?:\\s[^>]*)?\\/?>`, 'i');
  if (!re.test(xml)) return undefined;
  const valMatch = xml.match(new RegExp(`<w:${tag}[^>]*w:val="([^"]*)"`, 'i'));
  if (valMatch) return valMatch[1] !== '0' && valMatch[1] !== 'false';
  return true;
}

function getValTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<w:${tag}[^>]*w:val="([^"]*)"`, 'i');
  const m = xml.match(re);
  return m ? m[1] : undefined;
}

function getNumValTag(xml: string, tag: string): number | undefined {
  const val = getValTag(xml, tag);
  return val !== undefined ? parseInt(val, 10) : undefined;
}

// ─── Theme Extraction ───────────────────────────────────────

function extractTheme(themeXml: string): DocxTheme {
  const colors: Record<string, string> = {};
  const colorMap = ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  for (const name of colorMap) {
    const tagContent = getTagContentNS(themeXml, 'a', name);
    if (tagContent) {
      const srgb = getSimpleAttr(tagContent, 'lastClr') || getSimpleAttr(tagContent, 'val');
      if (srgb) colors[name] = srgb;
    }
  }

  const majorFontMatch = themeXml.match(/<a:majorFont[\s\S]*?<a:latin[^>]*typeface="([^"]*)"/)
  const minorFontMatch = themeXml.match(/<a:minorFont[\s\S]*?<a:latin[^>]*typeface="([^"]*)"/)

  return {
    name: getSimpleAttr(themeXml, 'name'),
    colors,
    majorFont: majorFontMatch?.[1],
    minorFont: minorFontMatch?.[1],
    rawXml: themeXml,
  };
}

// ─── Style Extraction ───────────────────────────────────────

function extractRunProperties(xml: string): DocxRunProperties | undefined {
  const rPrXml = getTagContentNS(xml, 'w', 'rPr');
  if (!rPrXml) return undefined;

  const rPr: DocxRunProperties = {};

  rPr.rStyle = getValTag(rPrXml, 'rStyle');

  // Fonts
  const rFontsTag = getTagFull(rPrXml, 'rFonts');
  if (rFontsTag) {
    rPr.rFonts = {
      ascii: getAttrExact(rFontsTag, 'w', 'ascii'),
      hAnsi: getAttrExact(rFontsTag, 'w', 'hAnsi'),
      eastAsia: getAttrExact(rFontsTag, 'w', 'eastAsia'),
      cs: getAttrExact(rFontsTag, 'w', 'cs'),
    };
  }

  rPr.bold = getBoolTag(rPrXml, 'b');
  rPr.italic = getBoolTag(rPrXml, 'i');
  rPr.strike = getBoolTag(rPrXml, 'strike');
  rPr.dstrike = getBoolTag(rPrXml, 'dstrike');

  const uVal = getValTag(rPrXml, 'u');
  if (uVal) rPr.underline = uVal;

  const colorVal = getValTag(rPrXml, 'color');
  if (colorVal) {
    rPr.color = { val: colorVal };
    const themeColor = rPrXml.match(/<w:color[^>]*w:themeColor="([^"]*)"/i);
    if (themeColor) rPr.color.theme = themeColor[1];
  }

  rPr.sz = getNumValTag(rPrXml, 'sz');
  rPr.szCs = getNumValTag(rPrXml, 'szCs');
  rPr.highlight = getValTag(rPrXml, 'highlight');
  rPr.vertAlign = getValTag(rPrXml, 'vertAlign') as any;
  rPr.spacing = getNumValTag(rPrXml, 'spacing');
  rPr.outline = getBoolTag(rPrXml, 'outline');
  rPr.shadow = getBoolTag(rPrXml, 'shadow');
  rPr.vanish = getBoolTag(rPrXml, 'vanish');

  // Shading
  const shdTag = getTagFull(rPrXml, 'shd');
  if (shdTag) {
    rPr.shd = {
      val: getAttrExact(shdTag, 'w', 'val'),
      color: getAttrExact(shdTag, 'w', 'color'),
      fill: getAttrExact(shdTag, 'w', 'fill'),
    };
  }

  // Clean up undefined fields
  return cleanObj(rPr) as DocxRunProperties;
}

function extractBorderEdge(xml: string): DocxBorderEdge | undefined {
  if (!xml) return undefined;
  const edge: DocxBorderEdge = {
    val: getAttrExact(xml, 'w', 'val') as any,
    sz: (() => { const v = getAttrExact(xml, 'w', 'sz'); return v ? parseInt(v, 10) : undefined; })(),
    space: (() => { const v = getAttrExact(xml, 'w', 'space'); return v ? parseInt(v, 10) : undefined; })(),
    color: getAttrExact(xml, 'w', 'color'),
  };
  return cleanObj(edge) as DocxBorderEdge;
}

function extractParagraphProperties(xml: string): DocxParagraphProperties | undefined {
  const pPrXml = getTagContentNS(xml, 'w', 'pPr');
  if (!pPrXml) return undefined;

  const pPr: DocxParagraphProperties = {};

  pPr.pStyle = getValTag(pPrXml, 'pStyle');
  pPr.jc = getValTag(pPrXml, 'jc') as any;

  // Indentation
  const indTag = getTagFull(pPrXml, 'ind');
  if (indTag) {
    pPr.ind = {
      left: (() => { const v = getAttrExact(indTag, 'w', 'left'); return v ? parseInt(v, 10) : undefined; })(),
      right: (() => { const v = getAttrExact(indTag, 'w', 'right'); return v ? parseInt(v, 10) : undefined; })(),
      firstLine: (() => { const v = getAttrExact(indTag, 'w', 'firstLine'); return v ? parseInt(v, 10) : undefined; })(),
      hanging: (() => { const v = getAttrExact(indTag, 'w', 'hanging'); return v ? parseInt(v, 10) : undefined; })(),
    };
  }

  // Spacing
  const spacingTag = getTagFull(pPrXml, 'spacing');
  if (spacingTag) {
    pPr.spacing = {
      before: (() => { const v = getAttrExact(spacingTag, 'w', 'before'); return v ? parseInt(v, 10) : undefined; })(),
      after: (() => { const v = getAttrExact(spacingTag, 'w', 'after'); return v ? parseInt(v, 10) : undefined; })(),
      line: (() => { const v = getAttrExact(spacingTag, 'w', 'line'); return v ? parseInt(v, 10) : undefined; })(),
      lineRule: getAttrExact(spacingTag, 'w', 'lineRule') as any,
    };
  }

  // Numbering
  const numPrXml = getTagContentNS(pPrXml, 'w', 'numPr');
  if (numPrXml) {
    const ilvl = getNumValTag(numPrXml, 'ilvl');
    const numId = getNumValTag(numPrXml, 'numId');
    if (ilvl !== undefined && numId !== undefined) {
      pPr.numPr = { ilvl, numId };
    }
  }

  // Borders
  const pBdrXml = getTagContentNS(pPrXml, 'w', 'pBdr');
  if (pBdrXml) {
    pPr.pBdr = {};
    for (const side of ['top', 'bottom', 'left', 'right', 'between'] as const) {
      const sideTag = getTagFull(pBdrXml, side);
      if (sideTag) pPr.pBdr[side] = extractBorderEdge(sideTag);
    }
  }

  // Shading
  const shdTag = getTagFull(pPrXml, 'shd');
  if (shdTag) {
    pPr.shd = {
      val: getAttrExact(shdTag, 'w', 'val'),
      color: getAttrExact(shdTag, 'w', 'color'),
      fill: getAttrExact(shdTag, 'w', 'fill'),
    };
  }

  pPr.keepNext = getBoolTag(pPrXml, 'keepNext');
  pPr.keepLines = getBoolTag(pPrXml, 'keepLines');
  pPr.pageBreakBefore = getBoolTag(pPrXml, 'pageBreakBefore');
  pPr.widowControl = getBoolTag(pPrXml, 'widowControl');
  pPr.outlineLevel = getNumValTag(pPrXml, 'outlineLvl');

  // Default run properties within paragraph
  pPr.rPr = extractRunProperties(pPrXml);

  // Section properties (multi-section: intermediate section breaks live inside pPr)
  const sectPrXml = getTagFull(pPrXml, 'sectPr');
  if (sectPrXml) {
    pPr.sectPr = extractSectionProperties(sectPrXml);
  }

  return cleanObj(pPr) as DocxParagraphProperties;
}

// ─── Run Content Extraction ─────────────────────────────────

function extractDrawing(drawingXml: string): DocxDrawing {
  const isInline = drawingXml.includes('<wp:inline');
  const drawing: DocxDrawing = {
    type: isInline ? 'inline' : 'anchor',
    rawXml: drawingXml,
  };

  // Extent
  const extentTag = drawingXml.match(/<wp:extent[^>]*cx="(\d+)"[^>]*cy="(\d+)"/);
  if (extentTag) {
    drawing.extent = { cx: parseInt(extentTag[1], 10), cy: parseInt(extentTag[2], 10) };
  }

  // DocPr
  const docPrMatch = drawingXml.match(/<wp:docPr[^>]*id="(\d+)"[^>]*name="([^"]*)"/);
  if (docPrMatch) {
    drawing.name = docPrMatch[2];
  }
  const descrMatch = drawingXml.match(/<wp:docPr[^>]*descr="([^"]*)"/);
  if (descrMatch) drawing.description = descrMatch[1];

  // Image reference
  const embedMatch = drawingXml.match(/r:embed="([^"]*)"/);
  if (embedMatch) drawing.imageRId = embedMatch[1];

  // Anchor position
  if (!isInline) {
    drawing.behindDoc = drawingXml.includes('behindDoc="1"');
    const posHMatch = drawingXml.match(/<wp:positionH[^>]*relativeFrom="([^"]*)"[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>/);
    if (posHMatch) drawing.positionH = { relativeFrom: posHMatch[1], offset: parseInt(posHMatch[2], 10) };
    const posVMatch = drawingXml.match(/<wp:positionV[^>]*relativeFrom="([^"]*)"[\s\S]*?<wp:posOffset>(-?\d+)<\/wp:posOffset>/);
    if (posVMatch) drawing.positionV = { relativeFrom: posVMatch[1], offset: parseInt(posVMatch[2], 10) };
  }

  return drawing;
}

function extractRunContent(runXml: string): DocxRunContent[] {
  const content: DocxRunContent[] = [];
  // Remove rPr first
  const bodyXml = runXml.replace(/<w:rPr>[\s\S]*?<\/w:rPr>/gi, '');

  // Extract text, breaks, tabs, drawings in order
  const re = /<w:(t|br|tab|drawing|fldChar|instrText|sym)(\s[^>]*)?\/?>([\s\S]*?<\/w:\1>)?/gi;
  let m;
  while ((m = re.exec(bodyXml)) !== null) {
    const tagName = m[1].toLowerCase();
    const attrs = m[2] || '';
    const fullMatch = m[0];

    switch (tagName) {
      case 't': {
        const textMatch = fullMatch.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/i);
        content.push({ type: 'text', text: textMatch ? textMatch[1] : '' });
        break;
      }
      case 'br': {
        const brType = getAttrExact(attrs, 'w', 'type');
        content.push({ type: 'break', breakType: brType as any });
        break;
      }
      case 'tab':
        content.push({ type: 'tab' });
        break;
      case 'drawing': {
        const drawingContent = fullMatch.match(/<w:drawing>([\s\S]*?)<\/w:drawing>/i);
        if (drawingContent) {
          content.push({ type: 'drawing', drawing: extractDrawing(drawingContent[1]) });
        }
        break;
      }
      case 'fldchar': {
        const fldCharType = getAttrExact(fullMatch, 'w', 'fldCharType');
        if (fldCharType) content.push({ type: 'fieldChar', fldCharType: fldCharType as any });
        break;
      }
      case 'instrtext': {
        const instrMatch = fullMatch.match(/<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/i);
        if (instrMatch) content.push({ type: 'instrText', text: instrMatch[1].trim() });
        break;
      }
      case 'sym': {
        const font = getAttrExact(fullMatch, 'w', 'font') || '';
        const char = getAttrExact(fullMatch, 'w', 'char') || '';
        content.push({ type: 'sym', font, char });
        break;
      }
    }
  }

  // Fallback: if no content found, try plain text extraction
  if (content.length === 0) {
    const plainText = bodyXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/gi);
    if (plainText) {
      for (const pt of plainText) {
        const text = pt.replace(/<\/?w:t[^>]*>/g, '');
        content.push({ type: 'text', text });
      }
    }
  }

  return content;
}

function extractRun(runXml: string): DocxRun {
  return {
    rPr: extractRunProperties(runXml),
    content: extractRunContent(runXml),
  };
}

// ─── Paragraph Extraction ───────────────────────────────────

function extractParagraph(pXml: string): DocxParagraph {
  const pPr = extractParagraphProperties(pXml);
  const content: DocxParagraphContent[] = [];

  // Remove pPr to process remaining content
  const bodyXml = pXml.replace(/<w:pPr>[\s\S]*?<\/w:pPr>/i, '');

  // Extract runs, hyperlinks, bookmarks
  const re = /<w:(r|hyperlink|bookmarkStart|bookmarkEnd)(\s[^>]*)?\/?>([\s\S]*?<\/w:\1>)?/gi;
  let m;
  while ((m = re.exec(bodyXml)) !== null) {
    const tagName = m[1];
    const fullMatch = m[0];

    switch (tagName) {
      case 'r':
        content.push({ type: 'run', run: extractRun(fullMatch) });
        break;
      case 'hyperlink': {
        const rId = getAttrExact(fullMatch, 'r', 'id');
        const anchor = getAttrExact(fullMatch, 'w', 'anchor');
        const hlRuns = getAllTagsNS(fullMatch, 'w', 'r').map(r => extractRun(r));
        content.push({ type: 'hyperlink', hyperlink: { rId, anchor, runs: hlRuns } });
        break;
      }
      case 'bookmarkStart': {
        const id = parseInt(getAttrExact(fullMatch, 'w', 'id') || '0', 10);
        const name = getAttrExact(fullMatch, 'w', 'name') || '';
        content.push({ type: 'bookmarkStart', bookmark: { id, name } });
        break;
      }
      case 'bookmarkEnd': {
        const id = parseInt(getAttrExact(fullMatch, 'w', 'id') || '0', 10);
        content.push({ type: 'bookmarkEnd', id });
        break;
      }
    }
  }

  return { pPr, content };
}

// ─── Table Extraction ───────────────────────────────────────

function extractTableProperties(xml: string): DocxTableProperties | undefined {
  const tblPrXml = getTagContentNS(xml, 'w', 'tblPr');
  if (!tblPrXml) return undefined;

  const tblPr: DocxTableProperties = { rawXml: `<w:tblPr>${tblPrXml}</w:tblPr>` };

  tblPr.tblStyle = getValTag(tblPrXml, 'tblStyle');
  tblPr.jc = getValTag(tblPrXml, 'jc');

  // Table width
  const tblWTag = getTagFull(tblPrXml, 'tblW');
  if (tblWTag) {
    const w = getAttrExact(tblWTag, 'w', 'w');
    const type = getAttrExact(tblWTag, 'w', 'type');
    if (w) tblPr.tblW = { w: parseInt(w, 10), type: type as any || 'auto' };
  }

  // Borders
  const tblBdrsXml = getTagContentNS(tblPrXml, 'w', 'tblBorders');
  if (tblBdrsXml) {
    tblPr.tblBorders = {};
    for (const side of ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'] as const) {
      const sideTag = getTagFull(tblBdrsXml, side);
      if (sideTag) (tblPr.tblBorders as any)[side] = extractBorderEdge(sideTag);
    }
  }

  return cleanObj(tblPr) as DocxTableProperties;
}

function extractTableCellProperties(xml: string): DocxTableCellProperties | undefined {
  const tcPrXml = getTagContentNS(xml, 'w', 'tcPr');
  if (!tcPrXml) return undefined;

  const tcPr: DocxTableCellProperties = {};

  // Cell width
  const tcWTag = getTagFull(tcPrXml, 'tcW');
  if (tcWTag) {
    const w = getAttrExact(tcWTag, 'w', 'w');
    const type = getAttrExact(tcWTag, 'w', 'type');
    if (w) tcPr.tcW = { w: parseInt(w, 10), type: type as any || 'dxa' };
  }

  // Vertical merge
  const vMergeTag = getTagFull(tcPrXml, 'vMerge');
  if (vMergeTag) {
    const val = getAttrExact(vMergeTag, 'w', 'val');
    tcPr.vMerge = val === 'restart' ? 'restart' : 'continue';
  }

  // Grid span
  const gridSpan = getNumValTag(tcPrXml, 'gridSpan');
  if (gridSpan) tcPr.gridSpan = gridSpan;

  // Shading
  const shdTag = getTagFull(tcPrXml, 'shd');
  if (shdTag) {
    tcPr.shd = {
      val: getAttrExact(shdTag, 'w', 'val'),
      color: getAttrExact(shdTag, 'w', 'color'),
      fill: getAttrExact(shdTag, 'w', 'fill'),
    };
  }

  tcPr.vAlign = getValTag(tcPrXml, 'vAlign') as any;

  // Cell borders
  const tcBdrsXml = getTagContentNS(tcPrXml, 'w', 'tcBorders');
  if (tcBdrsXml) {
    tcPr.tcBorders = {};
    for (const side of ['top', 'left', 'bottom', 'right'] as const) {
      const sideTag = getTagFull(tcBdrsXml, side);
      if (sideTag) tcPr.tcBorders[side] = extractBorderEdge(sideTag);
    }
  }

  return cleanObj(tcPr) as DocxTableCellProperties;
}

function extractTable(tblXml: string): DocxTable {
  const tblPr = extractTableProperties(tblXml);

  // Table grid (column widths)
  const tblGrid: number[] = [];
  const gridColTags = getAllTagsNS(tblXml, 'w', 'gridCol');
  for (const gc of gridColTags) {
    const w = getAttrExact(gc, 'w', 'w');
    tblGrid.push(w ? parseInt(w, 10) : 0);
  }

  // Rows
  const rows: DocxTableRow[] = [];
  const rowTags = getAllTagsNS(tblXml, 'w', 'tr');
  for (const trXml of rowTags) {
    const trPrXml = getTagContentNS(trXml, 'w', 'trPr');
    let trPr: DocxTableRow['trPr'] = undefined;
    if (trPrXml) {
      trPr = {};
      const trHeightTag = getTagFull(trPrXml, 'trHeight');
      if (trHeightTag) {
        const val = getAttrExact(trHeightTag, 'w', 'val');
        const hRule = getAttrExact(trHeightTag, 'w', 'hRule');
        if (val) trPr.trHeight = { val: parseInt(val, 10), hRule: hRule as any };
      }
      trPr.tblHeader = getBoolTag(trPrXml, 'tblHeader');
      trPr.rawXml = `<w:trPr>${trPrXml}</w:trPr>`;
    }

    // Cells
    const cells: DocxTableCell[] = [];
    const cellTags = getAllTagsNS(trXml, 'w', 'tc');
    for (const tcXml of cellTags) {
      const tcPr = extractTableCellProperties(tcXml);
      const cellContent = extractBlockContent(tcXml);
      cells.push({ tcPr, content: cellContent });
    }

    rows.push({ trPr, cells });
  }

  return { tblPr, tblGrid, rows };
}

// ─── Block Content Extraction ───────────────────────────────

function extractBlockContent(xml: string): DocxBlockContent[] {
  const content: DocxBlockContent[] = [];

  // Match top-level w:p and w:tbl elements
  const re = /<w:(p|tbl)(\s[^>]*)?\/?>([\s\S]*?<\/w:\1>)?/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const tagName = m[1];
    const fullMatch = m[0];

    switch (tagName) {
      case 'p':
        content.push({ type: 'paragraph', paragraph: extractParagraph(fullMatch) });
        break;
      case 'tbl':
        content.push({ type: 'table', table: extractTable(fullMatch) });
        break;
    }
  }

  return content;
}

// ─── Section Properties Extraction ──────────────────────────

function extractSectionProperties(xml: string): DocxSectionProperties {
  const sectPr: DocxSectionProperties = { rawXml: xml };

  // Page size
  const pgSzTag = getTagFull(xml, 'pgSz');
  if (pgSzTag) {
    const w = getAttrExact(pgSzTag, 'w', 'w');
    const h = getAttrExact(pgSzTag, 'w', 'h');
    const orient = getAttrExact(pgSzTag, 'w', 'orient');
    if (w && h) {
      sectPr.pgSz = { w: parseInt(w, 10), h: parseInt(h, 10), orient: orient as any };
    }
  }

  // Page margins
  const pgMarTag = getTagFull(xml, 'pgMar');
  if (pgMarTag) {
    sectPr.pgMar = {
      top: parseInt(getAttrExact(pgMarTag, 'w', 'top') || '1440', 10),
      right: parseInt(getAttrExact(pgMarTag, 'w', 'right') || '1440', 10),
      bottom: parseInt(getAttrExact(pgMarTag, 'w', 'bottom') || '1440', 10),
      left: parseInt(getAttrExact(pgMarTag, 'w', 'left') || '1440', 10),
      header: parseInt(getAttrExact(pgMarTag, 'w', 'header') || '720', 10),
      footer: parseInt(getAttrExact(pgMarTag, 'w', 'footer') || '720', 10),
      gutter: (() => { const v = getAttrExact(pgMarTag, 'w', 'gutter'); return v ? parseInt(v, 10) : undefined; })(),
    };
  }

  // Header/footer references
  const headerRefs = getAllTagsNS(xml, 'w', 'headerReference');
  if (headerRefs.length > 0) {
    sectPr.headerRefs = headerRefs.map(ref => ({
      type: (getAttrExact(ref, 'w', 'type') || 'default') as any,
      rId: getAttrExact(ref, 'r', 'id') || '',
    }));
  }
  const footerRefs = getAllTagsNS(xml, 'w', 'footerReference');
  if (footerRefs.length > 0) {
    sectPr.footerRefs = footerRefs.map(ref => ({
      type: (getAttrExact(ref, 'w', 'type') || 'default') as any,
      rId: getAttrExact(ref, 'r', 'id') || '',
    }));
  }

  sectPr.titlePg = getBoolTag(xml, 'titlePg');

  return sectPr;
}

// ─── Styles Extraction ──────────────────────────────────────

function extractStyles(stylesXml: string): DocxDesignProtocol['styles'] {
  const definitions: DocxStyleDef[] = [];

  const styleTags = getAllTagsNS(stylesXml, 'w', 'style');
  for (const styleXml of styleTags) {
    const styleId = getAttrExact(styleXml, 'w', 'styleId');
    const type = getAttrExact(styleXml, 'w', 'type');
    if (!styleId || !type) continue;

    const nameTag = getTagFull(styleXml, 'name');
    const name = nameTag ? getAttrExact(nameTag, 'w', 'val') || styleId : styleId;

    const def: DocxStyleDef = {
      styleId,
      type: type as any,
      name,
      basedOn: getValTag(styleXml, 'basedOn'),
      next: getValTag(styleXml, 'next'),
      link: getValTag(styleXml, 'link'),
      isDefault: styleXml.includes('w:default="1"'),
      pPr: extractParagraphProperties(styleXml),
      rPr: extractRunProperties(styleXml),
      rawXml: styleXml,
    };

    definitions.push(cleanObj(def) as DocxStyleDef);
  }

  // Doc defaults
  let docDefaults: DocxDesignProtocol['styles']['docDefaults'] = undefined;
  const docDefaultsXml = getTagContentNS(stylesXml, 'w', 'docDefaults');
  if (docDefaultsXml) {
    docDefaults = {};
    const rPrDefaultXml = getTagContentNS(docDefaultsXml, 'w', 'rPrDefault');
    if (rPrDefaultXml) docDefaults.rPrDefault = extractRunProperties(rPrDefaultXml);
    const pPrDefaultXml = getTagContentNS(docDefaultsXml, 'w', 'pPrDefault');
    if (pPrDefaultXml) docDefaults.pPrDefault = extractParagraphProperties(pPrDefaultXml);
  }

  return {
    docDefaults,
    definitions,
    rawXml: stylesXml,
  };
}

// ─── Numbering Extraction ───────────────────────────────────

function extractNumbering(numberingXml: string): DocxDesignProtocol['numbering'] {
  const abstractNums: DocxAbstractNum[] = [];
  const nums: DocxNum[] = [];

  const abstractNumTags = getAllTagsNS(numberingXml, 'w', 'abstractNum');
  for (const anXml of abstractNumTags) {
    const abstractNumId = parseInt(getAttrExact(anXml, 'w', 'abstractNumId') || '0', 10);
    const levels: DocxAbstractNum['levels'] = [];

    const lvlTags = getAllTagsNS(anXml, 'w', 'lvl');
    for (const lvlXml of lvlTags) {
      const ilvl = parseInt(getAttrExact(lvlXml, 'w', 'ilvl') || '0', 10);
      levels.push({
        ilvl,
        numFmt: getValTag(lvlXml, 'numFmt') || 'decimal',
        lvlText: getValTag(lvlXml, 'lvlText') || '',
        start: getNumValTag(lvlXml, 'start'),
        jc: getValTag(lvlXml, 'jc'),
        rawXml: lvlXml,
      });
    }

    abstractNums.push({ abstractNumId, levels, rawXml: anXml });
  }

  const numTags = getAllTagsNS(numberingXml, 'w', 'num');
  for (const numXml of numTags) {
    const numId = parseInt(getAttrExact(numXml, 'w', 'numId') || '0', 10);
    const abstractNumIdRef = getValTag(numXml, 'abstractNumId');
    if (abstractNumIdRef) {
      nums.push({ numId, abstractNumId: parseInt(abstractNumIdRef, 10) });
    }
  }

  return { abstractNums, nums, rawXml: numberingXml };
}

// ─── Relationships Extraction ───────────────────────────────

function extractRelationships(relsXml: string): Array<{ id: string; type: string; target: string; targetMode?: string }> {
  const rels: Array<{ id: string; type: string; target: string; targetMode?: string }> = [];
  const relTags = relsXml.match(/<Relationship[^>]*\/>/gi) || [];
  for (const relTag of relTags) {
    const id = getSimpleAttr(relTag, 'Id') || '';
    const type = getSimpleAttr(relTag, 'Type') || '';
    const target = getSimpleAttr(relTag, 'Target') || '';
    const targetMode = getSimpleAttr(relTag, 'TargetMode');
    rels.push({ id, type: type.split('/').pop() || type, target, targetMode });
  }
  return rels;
}

// ─── Header/Footer Extraction ───────────────────────────────

function extractHeaderFooter(xml: string, type: 'header' | 'footer', rId: string, headerType: string): DocxHeaderFooter {
  return {
    type,
    rId,
    headerType: headerType as any,
    content: extractBlockContent(xml),
    rawXml: xml,
  };
}

// ─── Utility ────────────────────────────────────────────────

function cleanObj(obj: Record<string, any>): Record<string, any> {
  const cleaned: Record<string, any> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (val !== undefined && val !== null) {
      if (typeof val === 'object' && !Array.isArray(val)) {
        const c = cleanObj(val);
        if (Object.keys(c).length > 0) cleaned[key] = c;
      } else {
        cleaned[key] = val;
      }
    }
  }
  return cleaned;
}

// ─── Image Embedding ────────────────────────────────────────

/**
 * Walk body blocks and embed base64 image data for all drawings that reference image rIds.
 */
async function embedImageData(
  body: DocxBlockContent[],
  relationships: Array<{ id: string; type: string; target: string }>,
  zip: JSZip
): Promise<void> {
  // Build rId → target map for image relationships
  const imageRels = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === 'image') {
      imageRels.set(rel.id, rel.target);
    }
  }
  if (imageRels.size === 0) return;

  // Recursively walk body to find drawings
  function walkBlocks(blocks: DocxBlockContent[]) {
    for (const block of blocks) {
      if (block.type === 'paragraph') {
        for (const pc of block.paragraph.content) {
          if (pc.type === 'run') {
            for (const c of pc.run.content) {
              if (c.type === 'drawing' && c.drawing.imageRId) {
                const target = imageRels.get(c.drawing.imageRId);
                if (target) {
                  const mediaPath = `word/${target}`;
                  const entry = zip.file(mediaPath);
                  if (entry) {
                    // Will be resolved after async
                    (c.drawing as any)._pendingPath = mediaPath;
                  }
                }
              }
            }
          }
        }
      } else if (block.type === 'table') {
        for (const row of block.table.rows) {
          for (const cell of row.cells) {
            walkBlocks(cell.content);
          }
        }
      } else if (block.type === 'sdt') {
        walkBlocks(block.content);
      }
    }
  }

  walkBlocks(body);

  // Resolve async reads
  async function resolveImages(blocks: DocxBlockContent[]) {
    for (const block of blocks) {
      if (block.type === 'paragraph') {
        for (const pc of block.paragraph.content) {
          if (pc.type === 'run') {
            for (const c of pc.run.content) {
              if (c.type === 'drawing' && (c.drawing as any)._pendingPath) {
                const entry = zip.file((c.drawing as any)._pendingPath);
                if (entry) {
                  const buf = await entry.async('nodebuffer');
                  c.drawing.imageData = buf.toString('base64');
                }
                delete (c.drawing as any)._pendingPath;
              }
            }
          }
        }
      } else if (block.type === 'table') {
        for (const row of block.table.rows) {
          for (const cell of row.cells) {
            await resolveImages(cell.content);
          }
        }
      } else if (block.type === 'sdt') {
        await resolveImages(block.content);
      }
    }
  }

  await resolveImages(body);
}

// ─── Main Extraction ────────────────────────────────────────

export async function distillDocxDesign(filePath: string): Promise<DocxDesignProtocol> {
  const buffer = safeReadFile(filePath, { encoding: null }) as Buffer;
  const zip = await JSZip.loadAsync(buffer);

  async function readEntry(path: string): Promise<string | null> {
    const entry = zip.file(path);
    if (!entry) return null;
    return await entry.async('string');
  }

  // 1. Theme
  const themeXml = await readEntry('word/theme/theme1.xml');
  const theme: DocxTheme = themeXml ? extractTheme(themeXml) : { colors: {} };

  // 2. Styles
  const stylesXml = await readEntry('word/styles.xml');
  const styles = stylesXml ? extractStyles(stylesXml) : { definitions: [] };

  // 3. Numbering
  const numberingXml = await readEntry('word/numbering.xml');
  const numbering = numberingXml ? extractNumbering(numberingXml) : undefined;

  // 4. Relationships
  const docRelsXml = await readEntry('word/_rels/document.xml.rels');
  const relationships = docRelsXml ? extractRelationships(docRelsXml) : [];

  // 5. Main document
  const documentXml = await readEntry('word/document.xml');
  if (!documentXml) throw new Error('Missing word/document.xml');

  const bodyXml = getTagContentNS(documentXml, 'w', 'body') || '';
  const body = extractBlockContent(bodyXml);

  // 6. Section properties
  // Intermediate sections are now captured in paragraph pPr (via extractParagraphProperties).
  // Here we only extract the body-level sectPr (the final/last section).
  // Body-level sectPr is a direct child of <w:body>, NOT inside <w:pPr>.
  // We match sectPr that is NOT preceded by <w:pPr> context.
  const sections: DocxSectionProperties[] = [];
  // The final sectPr is always the last <w:sectPr> in the body that is NOT inside a <w:p>
  // Simplest approach: get the last sectPr tag from body XML
  const allSectPrs = getAllTagsNS(bodyXml, 'w', 'sectPr');
  if (allSectPrs.length > 0) {
    // The last one is the body-level sectPr (OOXML spec: final sectPr is direct child of body)
    sections.push(extractSectionProperties(allSectPrs[allSectPrs.length - 1]));
  }

  // 7. Headers and Footers
  const headersFooters: DocxHeaderFooter[] = [];
  for (const rel of relationships) {
    if (rel.type === 'header' || rel.type === 'footer') {
      const partPath = `word/${rel.target}`;
      const partXml = await readEntry(partPath);
      if (partXml) {
        // Determine header type from section refs
        let headerType = 'default';
        for (const sect of sections) {
          const refs = rel.type === 'header' ? sect.headerRefs : sect.footerRefs;
          const ref = refs?.find(r => r.rId === rel.id);
          if (ref) { headerType = ref.type; break; }
        }
        headersFooters.push(extractHeaderFooter(partXml, rel.type as any, rel.id, headerType));
      }
    }
  }

  // 8. Embed image data (base64) for lossless round-trip
  await embedImageData(body, relationships, zip);

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    theme,
    styles,
    numbering,
    body,
    sections,
    headersFooters,
    relationships,
  };
}
