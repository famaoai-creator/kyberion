/**
 * Native DOCX Engine
 * Generates complete DOCX files from DocxDesignProtocol (ADF).
 * Follows the same architecture pattern as native-pptx-engine and native-xlsx-engine.
 */
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as path from 'path';
import type {
  DocxDesignProtocol,
  DocxBlockContent,
  DocxParagraph,
  DocxParagraphProperties,
  DocxParagraphContent,
  DocxRun,
  DocxRunProperties,
  DocxRunContent,
  DocxTable,
  DocxTableRow,
  DocxTableCell,
  DocxSectionProperties,
  DocxHeaderFooter,
  DocxBorderEdge,
  DocxShading,
  DocxDrawing,
} from '../types/docx-protocol.js';

// Re-use PPTX engine's theme generator (DrawingML theme is identical)
import { generateTheme } from '../native-pptx-engine/theme.js';

const WML_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const RT_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function escXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── XML Generators ─────────────────────────────────────────

function borderEdgeXml(edge: DocxBorderEdge | undefined, tag: string): string {
  if (!edge) return '';
  let xml = `<w:${tag}`;
  if (edge.val) xml += ` w:val="${edge.val}"`;
  if (edge.sz !== undefined) xml += ` w:sz="${edge.sz}"`;
  if (edge.space !== undefined) xml += ` w:space="${edge.space}"`;
  if (edge.color) xml += ` w:color="${edge.color}"`;
  xml += '/>';
  return xml;
}

function shadingXml(shd: DocxShading | undefined): string {
  if (!shd) return '';
  let xml = '<w:shd';
  if (shd.val) xml += ` w:val="${shd.val}"`;
  if (shd.color) xml += ` w:color="${shd.color}"`;
  if (shd.fill) xml += ` w:fill="${shd.fill}"`;
  xml += '/>';
  return xml;
}

function runPropertiesXml(rPr: DocxRunProperties | undefined): string {
  if (!rPr) return '';
  if (rPr.rawXml) return `<w:rPr>${rPr.rawXml}</w:rPr>`;

  let xml = '<w:rPr>';
  if (rPr.rStyle) xml += `<w:rStyle w:val="${escXml(rPr.rStyle)}"/>`;
  if (rPr.rFonts) {
    xml += '<w:rFonts';
    if (rPr.rFonts.ascii) xml += ` w:ascii="${escXml(rPr.rFonts.ascii)}"`;
    if (rPr.rFonts.hAnsi) xml += ` w:hAnsi="${escXml(rPr.rFonts.hAnsi)}"`;
    if (rPr.rFonts.eastAsia) xml += ` w:eastAsia="${escXml(rPr.rFonts.eastAsia)}"`;
    if (rPr.rFonts.cs) xml += ` w:cs="${escXml(rPr.rFonts.cs)}"`;
    xml += '/>';
  }
  if (rPr.bold) xml += '<w:b/>';
  if (rPr.italic) xml += '<w:i/>';
  if (rPr.strike) xml += '<w:strike/>';
  if (rPr.dstrike) xml += '<w:dstrike/>';
  if (rPr.underline) xml += `<w:u w:val="${rPr.underline}"/>`;
  if (rPr.color?.val) {
    xml += `<w:color w:val="${rPr.color.val}"`;
    if (rPr.color.theme) xml += ` w:themeColor="${rPr.color.theme}"`;
    xml += '/>';
  }
  if (rPr.sz) xml += `<w:sz w:val="${rPr.sz}"/>`;
  if (rPr.szCs) xml += `<w:szCs w:val="${rPr.szCs}"/>`;
  if (rPr.highlight) xml += `<w:highlight w:val="${rPr.highlight}"/>`;
  xml += shadingXml(rPr.shd);
  if (rPr.vertAlign) xml += `<w:vertAlign w:val="${rPr.vertAlign}"/>`;
  if (rPr.outline) xml += '<w:outline/>';
  if (rPr.shadow) xml += '<w:shadow/>';
  if (rPr.vanish) xml += '<w:vanish/>';
  xml += '</w:rPr>';
  return xml;
}

function runContentXml(content: DocxRunContent): string {
  switch (content.type) {
    case 'text':
      return `<w:t xml:space="preserve">${escXml(content.text)}</w:t>`;
    case 'break':
      return content.breakType ? `<w:br w:type="${content.breakType}"/>` : '<w:br/>';
    case 'tab':
      return '<w:tab/>';
    case 'drawing':
      return content.drawing.rawXml ? `<w:drawing>${content.drawing.rawXml}</w:drawing>` : '';
    case 'fieldChar':
      return `<w:fldChar w:fldCharType="${content.fldCharType}"/>`;
    case 'instrText':
      return `<w:instrText xml:space="preserve">${escXml(content.text)}</w:instrText>`;
    case 'sym':
      return `<w:sym w:font="${escXml(content.font)}" w:char="${content.char}"/>`;
    case 'rawXml':
      return content.xml;
    default:
      return '';
  }
}

function runXml(run: DocxRun): string {
  let xml = '<w:r>';
  xml += runPropertiesXml(run.rPr);
  for (const c of run.content) {
    xml += runContentXml(c);
  }
  xml += '</w:r>';
  return xml;
}

function paragraphPropertiesXml(pPr: DocxParagraphProperties | undefined): string {
  if (!pPr) return '';
  if (pPr.rawXml) return `<w:pPr>${pPr.rawXml}</w:pPr>`;

  let xml = '<w:pPr>';
  if (pPr.pStyle) xml += `<w:pStyle w:val="${escXml(pPr.pStyle)}"/>`;
  if (pPr.keepNext) xml += '<w:keepNext/>';
  if (pPr.keepLines) xml += '<w:keepLines/>';
  if (pPr.pageBreakBefore) xml += '<w:pageBreakBefore/>';
  if (pPr.widowControl === false) xml += '<w:widowControl w:val="0"/>';

  if (pPr.numPr) {
    xml += `<w:numPr><w:ilvl w:val="${pPr.numPr.ilvl}"/><w:numId w:val="${pPr.numPr.numId}"/></w:numPr>`;
  }

  if (pPr.pBdr) {
    xml += '<w:pBdr>';
    if (pPr.pBdr.top) xml += borderEdgeXml(pPr.pBdr.top, 'top');
    if (pPr.pBdr.bottom) xml += borderEdgeXml(pPr.pBdr.bottom, 'bottom');
    if (pPr.pBdr.left) xml += borderEdgeXml(pPr.pBdr.left, 'left');
    if (pPr.pBdr.right) xml += borderEdgeXml(pPr.pBdr.right, 'right');
    if (pPr.pBdr.between) xml += borderEdgeXml(pPr.pBdr.between, 'between');
    xml += '</w:pBdr>';
  }

  xml += shadingXml(pPr.shd);

  if (pPr.spacing) {
    xml += '<w:spacing';
    if (pPr.spacing.before !== undefined) xml += ` w:before="${pPr.spacing.before}"`;
    if (pPr.spacing.after !== undefined) xml += ` w:after="${pPr.spacing.after}"`;
    if (pPr.spacing.line !== undefined) xml += ` w:line="${pPr.spacing.line}"`;
    if (pPr.spacing.lineRule) xml += ` w:lineRule="${pPr.spacing.lineRule}"`;
    xml += '/>';
  }

  if (pPr.ind) {
    xml += '<w:ind';
    if (pPr.ind.left !== undefined) xml += ` w:left="${pPr.ind.left}"`;
    if (pPr.ind.right !== undefined) xml += ` w:right="${pPr.ind.right}"`;
    if (pPr.ind.firstLine !== undefined) xml += ` w:firstLine="${pPr.ind.firstLine}"`;
    if (pPr.ind.hanging !== undefined) xml += ` w:hanging="${pPr.ind.hanging}"`;
    xml += '/>';
  }

  if (pPr.jc) xml += `<w:jc w:val="${pPr.jc}"/>`;
  if (pPr.outlineLevel !== undefined) xml += `<w:outlineLvl w:val="${pPr.outlineLevel}"/>`;
  if (pPr.rPr) xml += runPropertiesXml(pPr.rPr);
  // Intermediate section break (must be last child of pPr per OOXML spec)
  if (pPr.sectPr) xml += sectionPropertiesXml(pPr.sectPr);
  xml += '</w:pPr>';
  return xml;
}

function paragraphContentXml(pc: DocxParagraphContent): string {
  switch (pc.type) {
    case 'run':
      return runXml(pc.run);
    case 'hyperlink': {
      let xml = '<w:hyperlink';
      if (pc.hyperlink.rId) xml += ` r:id="${pc.hyperlink.rId}"`;
      if (pc.hyperlink.anchor) xml += ` w:anchor="${escXml(pc.hyperlink.anchor)}"`;
      xml += '>';
      for (const r of pc.hyperlink.runs) xml += runXml(r);
      xml += '</w:hyperlink>';
      return xml;
    }
    case 'bookmarkStart':
      return `<w:bookmarkStart w:id="${pc.bookmark.id}" w:name="${escXml(pc.bookmark.name)}"/>`;
    case 'bookmarkEnd':
      return `<w:bookmarkEnd w:id="${pc.id}"/>`;
    case 'rawXml':
      return pc.xml;
    default:
      return '';
  }
}

function paragraphXml(p: DocxParagraph): string {
  if (p.rawXml) return p.rawXml;
  let xml = '<w:p>';
  xml += paragraphPropertiesXml(p.pPr);
  for (const pc of p.content) {
    xml += paragraphContentXml(pc);
  }
  xml += '</w:p>';
  return xml;
}

function tableCellXml(cell: DocxTableCell): string {
  let xml = '<w:tc>';
  if (cell.tcPr) {
    if (cell.tcPr.rawXml) {
      xml += cell.tcPr.rawXml;
    } else {
      xml += '<w:tcPr>';
      if (cell.tcPr.tcW) xml += `<w:tcW w:w="${cell.tcPr.tcW.w}" w:type="${cell.tcPr.tcW.type}"/>`;
      if (cell.tcPr.gridSpan) xml += `<w:gridSpan w:val="${cell.tcPr.gridSpan}"/>`;
      if (cell.tcPr.vMerge === 'restart') xml += '<w:vMerge w:val="restart"/>';
      else if (cell.tcPr.vMerge === 'continue') xml += '<w:vMerge/>';
      if (cell.tcPr.tcBorders) {
        xml += '<w:tcBorders>';
        if (cell.tcPr.tcBorders.top) xml += borderEdgeXml(cell.tcPr.tcBorders.top, 'top');
        if (cell.tcPr.tcBorders.left) xml += borderEdgeXml(cell.tcPr.tcBorders.left, 'left');
        if (cell.tcPr.tcBorders.bottom) xml += borderEdgeXml(cell.tcPr.tcBorders.bottom, 'bottom');
        if (cell.tcPr.tcBorders.right) xml += borderEdgeXml(cell.tcPr.tcBorders.right, 'right');
        xml += '</w:tcBorders>';
      }
      xml += shadingXml(cell.tcPr.shd);
      if (cell.tcPr.vAlign) xml += `<w:vAlign w:val="${cell.tcPr.vAlign}"/>`;
      xml += '</w:tcPr>';
    }
  }
  for (const block of cell.content) {
    xml += blockContentXml(block);
  }
  // Ensure at least one paragraph (required by spec)
  if (cell.content.length === 0) xml += '<w:p/>';
  xml += '</w:tc>';
  return xml;
}

function tableRowXml(row: DocxTableRow): string {
  let xml = '<w:tr>';
  if (row.trPr) {
    if (row.trPr.rawXml) {
      xml += row.trPr.rawXml;
    } else {
      xml += '<w:trPr>';
      if (row.trPr.trHeight) {
        xml += `<w:trHeight w:val="${row.trPr.trHeight.val}"`;
        if (row.trPr.trHeight.hRule) xml += ` w:hRule="${row.trPr.trHeight.hRule}"`;
        xml += '/>';
      }
      if (row.trPr.tblHeader) xml += '<w:tblHeader/>';
      xml += '</w:trPr>';
    }
  }
  for (const cell of row.cells) {
    xml += tableCellXml(cell);
  }
  xml += '</w:tr>';
  return xml;
}

function tableXml(table: DocxTable): string {
  if (table.rawXml) return table.rawXml;

  let xml = '<w:tbl>';
  if (table.tblPr) {
    if (table.tblPr.rawXml) {
      xml += table.tblPr.rawXml;
    } else {
      xml += '<w:tblPr>';
      if (table.tblPr.tblStyle) xml += `<w:tblStyle w:val="${escXml(table.tblPr.tblStyle)}"/>`;
      if (table.tblPr.tblW) xml += `<w:tblW w:w="${table.tblPr.tblW.w}" w:type="${table.tblPr.tblW.type}"/>`;
      if (table.tblPr.jc) xml += `<w:jc w:val="${table.tblPr.jc}"/>`;
      if (table.tblPr.tblBorders) {
        xml += '<w:tblBorders>';
        const b = table.tblPr.tblBorders;
        if (b.top) xml += borderEdgeXml(b.top, 'top');
        if (b.left) xml += borderEdgeXml(b.left, 'left');
        if (b.bottom) xml += borderEdgeXml(b.bottom, 'bottom');
        if (b.right) xml += borderEdgeXml(b.right, 'right');
        if (b.insideH) xml += borderEdgeXml(b.insideH, 'insideH');
        if (b.insideV) xml += borderEdgeXml(b.insideV, 'insideV');
        xml += '</w:tblBorders>';
      }
      xml += '</w:tblPr>';
    }
  }

  // Grid
  if (table.tblGrid.length > 0) {
    xml += '<w:tblGrid>';
    for (const w of table.tblGrid) {
      xml += `<w:gridCol w:w="${w}"/>`;
    }
    xml += '</w:tblGrid>';
  }

  for (const row of table.rows) {
    xml += tableRowXml(row);
  }
  xml += '</w:tbl>';
  return xml;
}

function blockContentXml(block: DocxBlockContent): string {
  switch (block.type) {
    case 'paragraph':
      return paragraphXml(block.paragraph);
    case 'table':
      return tableXml(block.table);
    case 'sdt': {
      let xml = '<w:sdt>';
      if (block.rawXml) return block.rawXml;
      for (const c of block.content) xml += blockContentXml(c);
      xml += '</w:sdt>';
      return xml;
    }
    case 'rawXml':
      return block.xml;
    default:
      return '';
  }
}

function sectionPropertiesXml(sect: DocxSectionProperties): string {
  if (sect.rawXml) return sect.rawXml;

  let xml = '<w:sectPr>';
  if (sect.headerRefs) {
    for (const ref of sect.headerRefs) {
      xml += `<w:headerReference w:type="${ref.type}" r:id="${ref.rId}"/>`;
    }
  }
  if (sect.footerRefs) {
    for (const ref of sect.footerRefs) {
      xml += `<w:footerReference w:type="${ref.type}" r:id="${ref.rId}"/>`;
    }
  }
  if (sect.pgSz) {
    xml += `<w:pgSz w:w="${sect.pgSz.w}" w:h="${sect.pgSz.h}"`;
    if (sect.pgSz.orient) xml += ` w:orient="${sect.pgSz.orient}"`;
    xml += '/>';
  }
  if (sect.pgMar) {
    const m = sect.pgMar;
    xml += `<w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}" w:header="${m.header}" w:footer="${m.footer}"`;
    if (m.gutter !== undefined) xml += ` w:gutter="${m.gutter}"`;
    xml += '/>';
  }
  if (sect.titlePg) xml += '<w:titlePg/>';
  if (sect.cols) {
    xml += '<w:cols';
    if (sect.cols.num) xml += ` w:num="${sect.cols.num}"`;
    if (sect.cols.space) xml += ` w:space="${sect.cols.space}"`;
    xml += '/>';
  }
  if (sect.docGrid) {
    xml += '<w:docGrid';
    if (sect.docGrid.linePitch) xml += ` w:linePitch="${sect.docGrid.linePitch}"`;
    if (sect.docGrid.type) xml += ` w:type="${sect.docGrid.type}"`;
    xml += '/>';
  }
  xml += '</w:sectPr>';
  return xml;
}

// ─── Part Generators ────────────────────────────────────────

function generateContentTypes(
  hasNumbering: boolean,
  headersFooters: DocxHeaderFooter[],
  relationships: DocxDesignProtocol['relationships']
): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Default Extension="bmp" ContentType="image/bmp"/>
  <Default Extension="tiff" ContentType="image/tiff"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>
  <Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>`;

  if (hasNumbering) {
    xml += `\n  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>`;
  }

  for (const hf of headersFooters) {
    const target = relationships.find(r => r.id === hf.rId)?.target || `${hf.type}1.xml`;
    const contentType = hf.type === 'header'
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';
    xml += `\n  <Override PartName="/word/${target}" ContentType="${contentType}"/>`;
  }

  xml += '\n</Types>';
  return xml;
}

function generateGlobalRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL_NS}">
  <Relationship Id="rId1" Type="${RT_BASE}/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${RT_BASE}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function generateDocumentRels(protocol: DocxDesignProtocol): string {
  let rId = 1;
  let rels = '';

  // Styles
  rels += `  <Relationship Id="rId${rId++}" Type="${RT_BASE}/styles" Target="styles.xml"/>\n`;

  // Theme
  rels += `  <Relationship Id="rId${rId++}" Type="${RT_BASE}/theme" Target="theme/theme1.xml"/>\n`;

  // Font table
  rels += `  <Relationship Id="rId${rId++}" Type="${RT_BASE}/fontTable" Target="fontTable.xml"/>\n`;

  // Numbering
  if (protocol.numbering) {
    rels += `  <Relationship Id="rId${rId++}" Type="${RT_BASE}/numbering" Target="numbering.xml"/>\n`;
  }

  // Original relationships (headers, footers, images, hyperlinks)
  for (const rel of protocol.relationships) {
    if (['styles', 'theme', 'fontTable', 'numbering'].includes(rel.type)) continue;
    rels += `  <Relationship Id="${rel.id}" Type="${RT_BASE}/${rel.type}" Target="${rel.target}"`;
    if (rel.targetMode) rels += ` TargetMode="${rel.targetMode}"`;
    rels += '/>\n';
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${PKG_REL_NS}">
${rels}</Relationships>`;
}

function generateStyles(protocol: DocxDesignProtocol): string {
  if (protocol.styles.rawXml) return protocol.styles.rawXml;

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${WML_NS}" xmlns:r="${REL_NS}">`;

  // Doc defaults
  if (protocol.styles.docDefaults) {
    xml += '<w:docDefaults>';
    if (protocol.styles.docDefaults.rPrDefault) {
      xml += '<w:rPrDefault>';
      xml += runPropertiesXml(protocol.styles.docDefaults.rPrDefault);
      xml += '</w:rPrDefault>';
    }
    if (protocol.styles.docDefaults.pPrDefault) {
      xml += '<w:pPrDefault>';
      xml += paragraphPropertiesXml(protocol.styles.docDefaults.pPrDefault);
      xml += '</w:pPrDefault>';
    }
    xml += '</w:docDefaults>';
  }

  // Style definitions
  for (const style of protocol.styles.definitions) {
    if (style.rawXml) {
      xml += style.rawXml;
    } else {
      xml += `<w:style w:type="${style.type}" w:styleId="${escXml(style.styleId)}"`;
      if (style.isDefault) xml += ' w:default="1"';
      xml += '>';
      xml += `<w:name w:val="${escXml(style.name)}"/>`;
      if (style.basedOn) xml += `<w:basedOn w:val="${escXml(style.basedOn)}"/>`;
      if (style.next) xml += `<w:next w:val="${escXml(style.next)}"/>`;
      if (style.link) xml += `<w:link w:val="${escXml(style.link)}"/>`;
      if (style.pPr) xml += paragraphPropertiesXml(style.pPr);
      if (style.rPr) xml += runPropertiesXml(style.rPr);
      xml += '</w:style>';
    }
  }

  xml += '</w:styles>';
  return xml;
}

function generateNumbering(protocol: DocxDesignProtocol): string {
  if (!protocol.numbering) return '';
  if (protocol.numbering.rawXml) return protocol.numbering.rawXml;

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="${WML_NS}">`;

  for (const an of protocol.numbering.abstractNums) {
    if (an.rawXml) {
      xml += an.rawXml;
    } else {
      xml += `<w:abstractNum w:abstractNumId="${an.abstractNumId}">`;
      for (const lvl of an.levels) {
        if (lvl.rawXml) {
          xml += lvl.rawXml;
        } else {
          xml += `<w:lvl w:ilvl="${lvl.ilvl}">`;
          if (lvl.start !== undefined) xml += `<w:start w:val="${lvl.start}"/>`;
          xml += `<w:numFmt w:val="${lvl.numFmt}"/>`;
          xml += `<w:lvlText w:val="${escXml(lvl.lvlText)}"/>`;
          if (lvl.jc) xml += `<w:lvlJc w:val="${lvl.jc}"/>`;
          xml += '</w:lvl>';
        }
      }
      xml += '</w:abstractNum>';
    }
  }

  for (const num of protocol.numbering.nums) {
    xml += `<w:num w:numId="${num.numId}"><w:abstractNumId w:val="${num.abstractNumId}"/>`;
    if (num.overrides) {
      for (const ov of num.overrides) {
        xml += `<w:lvlOverride w:ilvl="${ov.ilvl}">`;
        if (ov.startOverride !== undefined) xml += `<w:startOverride w:val="${ov.startOverride}"/>`;
        xml += '</w:lvlOverride>';
      }
    }
    xml += '</w:num>';
  }

  xml += '</w:numbering>';
  return xml;
}

function generateDocument(protocol: DocxDesignProtocol): string {
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="${REL_NS}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="${WML_NS}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" mc:Ignorable="w14 wp14">
<w:body>`;

  // Body content
  for (const block of protocol.body) {
    xml += blockContentXml(block);
  }

  // Section properties (last one goes in body)
  if (protocol.sections.length > 0) {
    xml += sectionPropertiesXml(protocol.sections[protocol.sections.length - 1]);
  }

  xml += '</w:body></w:document>';
  return xml;
}

function generateFontTable(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="${WML_NS}" xmlns:r="${REL_NS}">
  <w:font w:name="Calibri"><w:panose1 w:val="020F0502020204030204"/><w:charset w:val="00"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>
  <w:font w:name="Times New Roman"><w:panose1 w:val="02020603050405020304"/><w:charset w:val="00"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>
  <w:font w:name="MS Gothic"><w:charset w:val="80"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>
  <w:font w:name="MS Mincho"><w:charset w:val="80"/><w:family w:val="roman"/><w:pitch w:val="variable"/></w:font>
</w:fonts>`;
}

// ─── Main Generation ────────────────────────────────────────

export async function generateNativeDocx(protocol: DocxDesignProtocol, outputPath: string): Promise<void> {
  if (!protocol?.body?.length) {
    throw new Error('generateNativeDocx: protocol must have at least one body block');
  }
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    throw new Error(`generateNativeDocx: output directory does not exist: ${dir}`);
  }
  const zip = new AdmZip();

  // Content types (header/footer overrides are now generated inside the function)
  const hasNumbering = !!protocol.numbering;
  const contentTypes = generateContentTypes(hasNumbering, protocol.headersFooters, protocol.relationships);

  zip.addFile('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(generateGlobalRels(), 'utf8'));

  // Doc props
  zip.addFile('docProps/core.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Kyberion Native Document</dc:title>
  <dcterms:created xsi:type="dcterms:W3CDTF">${protocol.generatedAt || new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`, 'utf8'));

  zip.addFile('docProps/app.xml', Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Kyberion Native DOCX Engine</Application>
</Properties>`, 'utf8'));

  // Word parts
  zip.addFile('word/document.xml', Buffer.from(generateDocument(protocol), 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(generateDocumentRels(protocol), 'utf8'));
  zip.addFile('word/styles.xml', Buffer.from(generateStyles(protocol), 'utf8'));
  zip.addFile('word/fontTable.xml', Buffer.from(generateFontTable(), 'utf8'));

  // Theme
  const themeColors: Record<string, string> = {};
  for (const [key, val] of Object.entries(protocol.theme.colors)) {
    themeColors[key] = val;
  }
  zip.addFile('word/theme/theme1.xml', Buffer.from(
    protocol.theme.rawXml || generateTheme(themeColors), 'utf8'));

  // Numbering
  if (protocol.numbering) {
    zip.addFile('word/numbering.xml', Buffer.from(generateNumbering(protocol), 'utf8'));
  }

  // Headers and Footers
  for (const hf of protocol.headersFooters) {
    const target = protocol.relationships.find(r => r.id === hf.rId)?.target || `${hf.type}1.xml`;
    if (hf.rawXml) {
      zip.addFile(`word/${target}`, Buffer.from(hf.rawXml, 'utf8'));
    } else {
      const rootTag = hf.type === 'header' ? 'w:hdr' : 'w:ftr';
      let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${rootTag} xmlns:w="${WML_NS}" xmlns:r="${REL_NS}">`;
      for (const block of hf.content) {
        xml += blockContentXml(block);
      }
      if (hf.content.length === 0) xml += '<w:p/>';
      xml += `</${rootTag}>`;
      zip.addFile(`word/${target}`, Buffer.from(xml, 'utf8'));
    }
  }

  // Embed images from body drawings
  embedImages(protocol.body, protocol.relationships, zip);

  // Write ZIP
  zip.writeZip(outputPath);
}

/**
 * Walk body blocks, find drawings with imageData, and add them to the ZIP.
 */
function embedImages(
  blocks: DocxBlockContent[],
  relationships: DocxDesignProtocol['relationships'],
  zip: AdmZip
): void {
  const imageRels = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === 'image') {
      imageRels.set(rel.id, rel.target);
    }
  }

  function walk(blocks: DocxBlockContent[]) {
    for (const block of blocks) {
      if (block.type === 'paragraph') {
        for (const pc of block.paragraph.content) {
          if (pc.type === 'run') {
            for (const c of pc.run.content) {
              if (c.type === 'drawing' && c.drawing.imageRId) {
                const target = imageRels.get(c.drawing.imageRId);
                if (target && c.drawing.imageData) {
                  zip.addFile(`word/${target}`, Buffer.from(c.drawing.imageData, 'base64'));
                } else if (target && c.drawing.imagePath && fs.existsSync(c.drawing.imagePath)) {
                  zip.addFile(`word/${target}`, fs.readFileSync(c.drawing.imagePath));
                }
              }
            }
          }
        }
      } else if (block.type === 'table') {
        for (const row of block.table.rows) {
          for (const cell of row.cells) {
            walk(cell.content);
          }
        }
      } else if (block.type === 'sdt') {
        walk(block.content);
      }
    }
  }

  walk(blocks);
}
