/**
 * WordprocessingML XML text helpers.
 *
 * Escape behaviour aligned with WordCraft `crates/docx/src/xml.rs` `esc`
 * (MIT OR Apache-2.0): named entities, whitespace as character refs, drop
 * characters XML 1.0 cannot carry.
 */
import { decodeEntities } from '../text-escaping.js';

function isXmlChar(code: number): boolean {
  return (
    code === 0x9 ||
    code === 0xa ||
    code === 0xd ||
    (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) ||
    (code >= 0x10000 && code <= 0x10ffff)
  );
}

/** Escape for element text or attribute values (WordCraft `xml::esc`). */
export function escapeDocxXml(s: string): string {
  let out = '';
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === "'") out += '&apos;';
    else if (c === '\t') out += '&#9;';
    else if (c === '\n') out += '&#10;';
    else if (c === '\r') out += '&#13;';
    else if (isXmlChar(code)) out += c;
  }
  return out;
}

/**
 * Decode entities then drop control chars WordCraft `clean_text` would strip
 * (keep tab; map CR/LF to space for `w:t` body text).
 */
export function cleanDocxText(raw: string): string {
  let out = '';
  for (const c of decodeEntities(raw)) {
    const code = c.codePointAt(0) ?? 0;
    if (c === '\n' || c === '\r') out += ' ';
    else if (c === '\t') out += '\t';
    else if (code < 0x20) continue;
    else out += c;
  }
  return out;
}

/** Normalize `w:sym/@w:char` to uppercase hex digits (WordCraft runs.rs). */
export function normalizeSymChar(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^0x/i, '').replace(/^U\+/i, '').replace(/^#x/i, '');
  s = s.replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return s;
}

/**
 * Split a plain text string into WordML run children: tabs, breaks, soft /
 * no-break hyphens become empty elements (WordCraft `para_content` pieces).
 */
export function splitDocxTextToXml(text: string): string {
  let out = '';
  let buf = '';
  const flush = () => {
    if (!buf) return;
    out += `<w:t xml:space="preserve">${escapeDocxXml(buf)}</w:t>`;
    buf = '';
  };
  for (const ch of text) {
    if (ch === '\t') {
      flush();
      out += '<w:tab/>';
    } else if (ch === '\n') {
      flush();
      out += '<w:br/>';
    } else if (ch === '\u000c') {
      flush();
      out += '<w:br w:type="page"/>';
    } else if (ch === '\u000e') {
      flush();
      out += '<w:br w:type="column"/>';
    } else if (ch === '\u00ad') {
      flush();
      out += '<w:softHyphen/>';
    } else if (ch === '\u2011') {
      flush();
      out += '<w:noBreakHyphen/>';
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

/** Common image Default content types keyed by file extension. */
export const DOCX_IMAGE_CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
};

/** Content types for `word/diagrams/*` (SmartArt / DrawingML diagrams). */
export function diagramPartContentType(partPath: string): string | undefined {
  const base = partPath.split('/').pop() || '';
  if (/^data\d*\.xml$/i.test(base)) {
    return 'application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml';
  }
  if (/^layout\d*\.xml$/i.test(base)) {
    return 'application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml';
  }
  if (/^quickStyle\d*\.xml$/i.test(base)) {
    return 'application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml';
  }
  if (/^colors\d*\.xml$/i.test(base)) {
    return 'application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml';
  }
  if (/^drawing\d*\.xml$/i.test(base)) {
    return 'application/vnd.ms-office.drawingml.diagramDrawing+xml';
  }
  if (/^layoutHeader\d*\.xml$/i.test(base)) {
    return 'application/vnd.openxmlformats-officedocument.drawingml.diagramLayoutHeader+xml';
  }
  return undefined;
}

/** Flatten OMML (`m:t`) into readable text for `kyberion read`. */
export function scrapeOmmlText(xml: string): string {
  const parts: string[] = [];
  const re = /<m:t\b[^>]*>([\s\S]*?)<\/m:t>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const t = cleanDocxText(m[1]);
    if (t) parts.push(t);
  }
  return parts.join('');
}

/** Flatten SmartArt / diagram data part text (`dgm:t`, `a:t`). */
export function scrapeDiagramText(xml: string): string[] {
  const lines: string[] = [];
  const re = /<(?:dgm:t|a:t)\b[^>]*>([\s\S]*?)<\/(?:dgm:t|a:t)>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const t = cleanDocxText(m[1]).trim();
    if (t && !lines.includes(t)) lines.push(t);
  }
  return lines;
}
