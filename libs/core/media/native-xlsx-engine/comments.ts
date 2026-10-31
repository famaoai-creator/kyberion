/**
 * Thin comments + VML note shapes for XLSX packages (GridCraft-aligned).
 */
import type { XlsxComment } from '../../contracts/xlsx-protocol.js';
import { escapeXlsxAttr, escapeXlsxText } from '../xlsx-xstring.js';

/** Parse A1 → 0-based { row, col }. */
function parseA1(ref: string): { row: number; col: number } {
  const m = ref.match(/^([A-Z]+)(\d+)/i);
  if (!m) return { row: 0, col: 0 };
  let col = 0;
  for (const ch of m[1].toUpperCase()) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: parseInt(m[2], 10) - 1, col: col - 1 };
}

export function generateCommentsXml(comments: XlsxComment[]): string {
  const authors: string[] = [];
  for (const c of comments) {
    const a = c.author || '';
    if (!authors.includes(a)) authors.push(a);
  }
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors>`;
  for (const a of authors) {
    xml += `<author>${escapeXlsxText(a)}</author>`;
  }
  xml += '</authors><commentList>';
  for (const c of comments) {
    const aid = authors.indexOf(c.author || '');
    const body = c.author ? `${c.author}:\n${c.text}` : c.text;
    xml += `<comment ref="${escapeXlsxAttr(c.ref)}" authorId="${Math.max(0, aid)}"><text><r><t xml:space="preserve">${escapeXlsxText(body)}</t></r></text></comment>`;
  }
  xml += '</commentList></comments>';
  return xml;
}

export function generateVmlDrawing(comments: XlsxComment[], sheetSeq: number): string {
  let xml =
    `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
    `<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${sheetSeq}"/></o:shapelayout>` +
    `<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">` +
    `<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>`;

  comments.forEach((c, i) => {
    const { row, col } = parseA1(c.ref);
    const id = sheetSeq * 1024 + 1 + i;
    const anchor = `${col + 1}, 15, ${row}, 10, ${col + 3}, 15, ${row + 4}, 4`;
    xml +=
      `<v:shape id="_x0000_s${id}" type="#_x0000_t202" ` +
      `style="position:absolute;margin-left:59.25pt;margin-top:1.5pt;width:100.5pt;height:60.75pt;z-index:${i + 1};visibility:hidden" ` +
      // i18n-exempt: Excel sticky-note default fill (OOXML/VML convention, not UI chrome)
      `fillcolor="#ffffe1" o:insetmode="auto">` +
      // i18n-exempt: Excel sticky-note default fill (OOXML/VML convention, not UI chrome)
      `<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/>` +
      `<v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>` +
      `<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/>` +
      `<x:Anchor>${anchor}</x:Anchor><x:AutoFill>False</x:AutoFill>` +
      `<x:Row>${row}</x:Row><x:Column>${col}</x:Column></x:ClientData></v:shape>`;
  });
  xml += '</xml>';
  return xml;
}
