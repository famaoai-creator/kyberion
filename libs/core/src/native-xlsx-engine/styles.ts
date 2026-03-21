/**
 * styles.xml generator for XLSX packages
 * Generates the complete styles part from XlsxDesignProtocol.styles
 */
import type { XlsxDesignProtocol, XlsxFont, XlsxFill, XlsxBorder, XlsxBorderEdge, XlsxCellStyle, XlsxNumberFormat, XlsxColor, XlsxDxfStyle } from '../types/xlsx-protocol.js';

function colorXml(color: XlsxColor | undefined, tagName: string): string {
  if (!color) return '';
  const attrs: string[] = [];
  if (color.auto) attrs.push('auto="1"');
  if (color.indexed !== undefined) attrs.push(`indexed="${color.indexed}"`);
  if (color.theme !== undefined) attrs.push(`theme="${color.theme}"`);
  if (color.tint !== undefined) attrs.push(`tint="${color.tint}"`);
  if (color.rgb) {
    let rgb = color.rgb.replace('#', '');
    if (rgb.length === 6) rgb = 'FF' + rgb; // Add alpha if missing
    attrs.push(`rgb="${rgb}"`);
  }
  if (attrs.length === 0) return '';
  return `<${tagName} ${attrs.join(' ')}/>`;
}

function fontXml(font: XlsxFont): string {
  let xml = '<font>';
  if (font.bold) xml += '<b/>';
  if (font.italic) xml += '<i/>';
  if (font.strike) xml += '<strike/>';
  if (font.underline) {
    if (font.underline === 'double') xml += '<u val="double"/>';
    else xml += '<u/>';
  }
  if (font.vertAlign) xml += `<vertAlign val="${font.vertAlign}"/>`;
  if (font.size) xml += `<sz val="${font.size}"/>`;
  xml += colorXml(font.color, 'color');
  if (font.name) xml += `<name val="${escXml(font.name)}"/>`;
  if (font.family !== undefined) xml += `<family val="${font.family}"/>`;
  if (font.scheme) xml += `<scheme val="${font.scheme}"/>`;
  xml += '</font>';
  return xml;
}

function fillXml(fill: XlsxFill): string {
  let xml = '<fill>';
  if (fill.gradient) {
    xml += `<gradientFill type="${fill.gradient.type}"`;
    if (fill.gradient.degree !== undefined) xml += ` degree="${fill.gradient.degree}"`;
    xml += '>';
    for (const stop of fill.gradient.stops) {
      xml += `<stop position="${stop.position}">${colorXml(stop.color, 'color')}</stop>`;
    }
    xml += '</gradientFill>';
  } else {
    xml += `<patternFill patternType="${fill.patternType || 'none'}">`;
    xml += colorXml(fill.fgColor, 'fgColor');
    xml += colorXml(fill.bgColor, 'bgColor');
    xml += '</patternFill>';
  }
  xml += '</fill>';
  return xml;
}

function borderEdgeXml(edge: XlsxBorderEdge | undefined, tagName: string): string {
  if (!edge) return `<${tagName}/>`;
  let xml = `<${tagName}`;
  if (edge.style) xml += ` style="${edge.style}"`;
  xml += '>';
  xml += colorXml(edge.color, 'color');
  xml += `</${tagName}>`;
  return xml;
}

function borderXml(border: XlsxBorder): string {
  let xml = '<border';
  if (border.diagonalUp) xml += ' diagonalUp="1"';
  if (border.diagonalDown) xml += ' diagonalDown="1"';
  xml += '>';
  xml += borderEdgeXml(border.left, 'left');
  xml += borderEdgeXml(border.right, 'right');
  xml += borderEdgeXml(border.top, 'top');
  xml += borderEdgeXml(border.bottom, 'bottom');
  xml += borderEdgeXml(border.diagonal, 'diagonal');
  xml += '</border>';
  return xml;
}

function xfXml(style: XlsxCellStyle, index: number, isCellXf: boolean, fontIdx?: number, fillIdx?: number, borderIdx?: number): string {
  // If raw XML is preserved, use it
  if (style.xfXml) return style.xfXml;

  const numFmtId = style.numFmt?.id || 0;
  const fontId = fontIdx ?? 0;
  const fillId = fillIdx ?? 0;
  const borderId = borderIdx ?? 0;

  let xml = `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}"`;
  if (isCellXf) xml += ' xfId="0"';
  if (style.numFmt && numFmtId > 0) xml += ' applyNumberFormat="1"';
  if (style.font) xml += ' applyFont="1"';
  if (style.fill) xml += ' applyFill="1"';
  if (style.border) xml += ' applyBorder="1"';
  if (style.alignment) xml += ' applyAlignment="1"';
  if (style.protection) xml += ' applyProtection="1"';

  const hasChildren = style.alignment || style.protection;
  if (!hasChildren) {
    xml += '/>';
  } else {
    xml += '>';
    if (style.alignment) {
      xml += '<alignment';
      if (style.alignment.horizontal) xml += ` horizontal="${style.alignment.horizontal}"`;
      if (style.alignment.vertical) xml += ` vertical="${style.alignment.vertical}"`;
      if (style.alignment.wrapText) xml += ' wrapText="1"';
      if (style.alignment.shrinkToFit) xml += ' shrinkToFit="1"';
      if (style.alignment.textRotation !== undefined) xml += ` textRotation="${style.alignment.textRotation}"`;
      if (style.alignment.indent) xml += ` indent="${style.alignment.indent}"`;
      if (style.alignment.readingOrder) xml += ` readingOrder="${style.alignment.readingOrder}"`;
      xml += '/>';
    }
    if (style.protection) {
      xml += '<protection';
      if (style.protection.locked !== undefined) xml += ` locked="${style.protection.locked ? '1' : '0'}"`;
      if (style.protection.hidden) xml += ' hidden="1"';
      xml += '/>';
    }
    xml += '</xf>';
  }
  return xml;
}

function escXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function generateStyles(protocol: XlsxDesignProtocol): string {
  // If raw styles XML is preserved, use it directly
  if (protocol.styles.rawStylesXml) return protocol.styles.rawStylesXml;

  const { fonts, fills, borders, numFmts, cellXfs, namedStyles } = protocol.styles;

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac x16r2 xr" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:x16r2="http://schemas.microsoft.com/office/spreadsheetml/2015/02/main" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision">`;

  // Number formats (only custom ones, id >= 164)
  const customFmts = numFmts.filter(f => f.id >= 164);
  if (customFmts.length > 0) {
    xml += `<numFmts count="${customFmts.length}">`;
    for (const f of customFmts) {
      xml += `<numFmt numFmtId="${f.id}" formatCode="${escXml(f.formatCode)}"/>`;
    }
    xml += '</numFmts>';
  }

  // Fonts
  xml += `<fonts count="${fonts.length || 1}">`;
  if (fonts.length === 0) {
    xml += '<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';
  } else {
    for (const f of fonts) xml += fontXml(f);
  }
  xml += '</fonts>';

  // Fills (minimum 2: none and gray125)
  xml += `<fills count="${Math.max(fills.length, 2)}">`;
  if (fills.length === 0) {
    xml += '<fill><patternFill patternType="none"/></fill>';
    xml += '<fill><patternFill patternType="gray125"/></fill>';
  } else {
    for (const f of fills) xml += fillXml(f);
  }
  xml += '</fills>';

  // Borders (minimum 1: empty)
  xml += `<borders count="${Math.max(borders.length, 1)}">`;
  if (borders.length === 0) {
    xml += '<border><left/><right/><top/><bottom/><diagonal/></border>';
  } else {
    for (const b of borders) xml += borderXml(b);
  }
  xml += '</borders>';

  // Cell Style Xfs (master formats)
  xml += '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';

  // Cell Xfs - resolve font/fill/border indices by object identity
  xml += `<cellXfs count="${Math.max(cellXfs.length, 1)}">`;
  if (cellXfs.length === 0) {
    xml += '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>';
  } else {
    cellXfs.forEach((xf, i) => {
      const fontIdx = xf.font ? fonts.indexOf(xf.font) : 0;
      const fillIdx = xf.fill ? fills.indexOf(xf.fill) : 0;
      const borderIdx = xf.border ? borders.indexOf(xf.border) : 0;
      xml += xfXml(xf, i, true,
        fontIdx >= 0 ? fontIdx : 0,
        fillIdx >= 0 ? fillIdx : 0,
        borderIdx >= 0 ? borderIdx : 0);
    });
  }
  xml += '</cellXfs>';

  // Cell Styles
  xml += `<cellStyles count="${Math.max(namedStyles.length, 1)}">`;
  if (namedStyles.length === 0) {
    xml += '<cellStyle name="Normal" xfId="0" builtinId="0"/>';
  } else {
    for (const ns of namedStyles) {
      xml += `<cellStyle name="${escXml(ns.name)}" xfId="${ns.xfId}"`;
      if (ns.builtinId !== undefined) xml += ` builtinId="${ns.builtinId}"`;
      xml += '/>';
    }
  }
  xml += '</cellStyles>';

  // DXFs (differential formatting for conditional formatting)
  const dxfs = protocol.styles.dxfs || [];
  xml += `<dxfs count="${dxfs.length}">`;
  for (const dxf of dxfs) {
    xml += '<dxf>';
    if (dxf.font) xml += fontXml(dxf.font);
    if (dxf.fill) xml += fillXml(dxf.fill);
    if (dxf.border) xml += borderXml(dxf.border);
    if (dxf.numFmt) xml += `<numFmt numFmtId="${dxf.numFmt.id}" formatCode="${escXml(dxf.numFmt.formatCode)}"/>`;
    xml += '</dxf>';
  }
  xml += '</dxfs>';
  xml += '<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>';
  xml += '</styleSheet>';

  return xml;
}
