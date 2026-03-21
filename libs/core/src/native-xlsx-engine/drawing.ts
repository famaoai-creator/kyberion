/**
 * Drawing XML generator for XLSX packages
 */
import type { XlsxDrawing, XlsxDrawingElement, XlsxDrawingAnchor } from '../types/xlsx-protocol.js';

function escXml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function anchorPosXml(pos: { col: number; colOffset: number; row: number; rowOffset: number }, tag: string): string {
  return `<xdr:${tag}><xdr:col>${pos.col}</xdr:col><xdr:colOff>${pos.colOffset}</xdr:colOff><xdr:row>${pos.row}</xdr:row><xdr:rowOff>${pos.rowOffset}</xdr:rowOff></xdr:${tag}>`;
}

function textBodyXml(el: XlsxDrawingElement): string {
  if (el.txBodyXml) return el.txBodyXml;
  if (!el.text && (!el.textRuns || el.textRuns.length === 0)) return '';

  let xml = '<xdr:txBody><a:bodyPr vertOverflow="clip" horzOverflow="clip" wrap="square" rtlCol="0" anchor="t"/><a:lstStyle/>';

  if (el.textRuns && el.textRuns.length > 0) {
    xml += '<a:p>';
    for (const run of el.textRuns) {
      xml += '<a:r>';
      if (run.font) {
        xml += '<a:rPr lang="ja-JP"';
        if (run.font.size) xml += ` sz="${Math.round(run.font.size * 100)}"`;
        if (run.font.bold) xml += ' b="1"';
        if (run.font.italic) xml += ' i="1"';
        xml += '>';
        if (run.font.color?.rgb) xml += `<a:solidFill><a:srgbClr val="${run.font.color.rgb.replace('#', '')}"/></a:solidFill>`;
        if (run.font.name) xml += `<a:latin typeface="${escXml(run.font.name)}"/><a:ea typeface="${escXml(run.font.name)}"/>`;
        xml += '</a:rPr>';
      } else {
        xml += '<a:rPr lang="ja-JP"/>';
      }
      xml += `<a:t>${escXml(run.text)}</a:t>`;
      xml += '</a:r>';
    }
    xml += '</a:p>';
  } else if (el.text) {
    // Split by newline for multi-paragraph
    const lines = el.text.split(/\r?\n/);
    for (const line of lines) {
      xml += `<a:p><a:r><a:rPr lang="ja-JP"/><a:t>${escXml(line)}</a:t></a:r></a:p>`;
    }
  }

  xml += '</xdr:txBody>';
  return xml;
}

function shapePropertiesXml(el: XlsxDrawingElement): string {
  if (el.spPrXml) return el.spPrXml;

  let xml = '<xdr:spPr>';
  // Transform (position/size from anchor, not needed here)
  if (el.style?.fill) {
    const color = el.style.fill.rgb?.replace('#', '') || '4472C4';
    xml += `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>`;
  }
  if (el.style?.line) {
    const lineColor = el.style.line.color?.rgb?.replace('#', '') || '000000';
    const lineWidth = el.style.line.width || 12700;
    xml += `<a:ln w="${lineWidth}"><a:solidFill><a:srgbClr val="${lineColor}"/></a:solidFill></a:ln>`;
  }
  if (el.shapeType) {
    xml += `<a:prstGeom prst="${el.shapeType}"><a:avLst/></a:prstGeom>`;
  } else {
    xml += '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';
  }
  xml += '</xdr:spPr>';
  return xml;
}

function elementXml(el: XlsxDrawingElement, idCounter: number): string {
  if (el.rawXml) return el.rawXml;

  if (el.type === 'shape' || el.type === 'connector') {
    let xml = `<xdr:sp macro="" textlink="">`;
    xml += `<xdr:nvSpPr><xdr:cNvPr id="${idCounter}" name="${escXml(el.name || `Shape ${idCounter}`)}"/><xdr:cNvSpPr/></xdr:nvSpPr>`;
    xml += shapePropertiesXml(el);
    xml += textBodyXml(el);
    xml += '</xdr:sp>';
    return xml;
  }

  if (el.type === 'image' && el.imagePath) {
    // Image element - needs relationship reference
    let xml = `<xdr:pic>`;
    xml += `<xdr:nvPicPr><xdr:cNvPr id="${idCounter}" name="${escXml(el.name || `Image ${idCounter}`)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`;
    xml += `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId${idCounter}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`;
    xml += '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>';
    xml += '</xdr:pic>';
    return xml;
  }

  // Fallback: empty shape
  return '';
}

export function generateDrawing(drawing: XlsxDrawing): string {
  if (drawing.rawXml) return drawing.rawXml;

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`;

  let idCounter = 2;
  for (const el of drawing.elements) {
    const anchor = el.anchor;

    if (anchor.type === 'twoCellAnchor') {
      xml += '<xdr:twoCellAnchor>';
      if (anchor.from) xml += anchorPosXml(anchor.from, 'from');
      if (anchor.to) xml += anchorPosXml(anchor.to, 'to');
      xml += elementXml(el, idCounter++);
      xml += '<xdr:clientData/>';
      xml += '</xdr:twoCellAnchor>';
    } else if (anchor.type === 'oneCellAnchor') {
      xml += '<xdr:oneCellAnchor>';
      if (anchor.from) xml += anchorPosXml(anchor.from, 'from');
      if (anchor.ext) xml += `<xdr:ext cx="${anchor.ext.cx}" cy="${anchor.ext.cy}"/>`;
      xml += elementXml(el, idCounter++);
      xml += '<xdr:clientData/>';
      xml += '</xdr:oneCellAnchor>';
    } else if (anchor.type === 'absoluteAnchor') {
      xml += '<xdr:absoluteAnchor>';
      if (anchor.pos) xml += `<xdr:pos x="${anchor.pos.x}" y="${anchor.pos.y}"/>`;
      if (anchor.ext) xml += `<xdr:ext cx="${anchor.ext.cx}" cy="${anchor.ext.cy}"/>`;
      xml += elementXml(el, idCounter++);
      xml += '<xdr:clientData/>';
      xml += '</xdr:absoluteAnchor>';
    }
  }

  xml += '</xdr:wsDr>';
  return xml;
}
