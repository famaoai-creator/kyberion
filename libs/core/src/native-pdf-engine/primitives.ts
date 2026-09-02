/** Low-level PDF writer, encoding, labels, and embedded CJK font primitives. */

import * as zlib from 'zlib';
import { createRequire } from 'node:module';
import { nowIso } from '../../foundation/time.js';
import { safeExistsSync } from '../../secure-io.js';
import { pathResolver } from '../../path-resolver.js';
import { escapeXml } from '../../text-escaping.js';
import type { PdfDesignProtocol, PdfPageLabel, PdfOutlineItem } from '../types/pdf-protocol.js';

interface ObjEntry {
  id: number;
  offset: number;
  inStream?: number;
  indexInStream?: number;
}
export class PdfWriter {
  private buf: Buffer = Buffer.alloc(0);
  private reg: ObjEntry[] = [];
  private _nextId: number = 1;

  constructor() {
    this.raw('%PDF-2.0\n%\u00E2\u00E3\u00CF\u00D3\n');
  }

  get nextId(): number {
    return this._nextId;
  }
  get currentOffset(): number {
    return this.buf.length;
  }

  private raw(data: string | Buffer) {
    const b = typeof data === 'string' ? Buffer.from(data, 'binary') : data;
    this.buf = Buffer.concat([this.buf, b]);
  }

  reserveId(): number {
    return this._nextId++;
  }

  /** Write a regular (non-stream) object */
  writeObj(id: number, content: string) {
    this.reg.push({ id, offset: this.buf.length });
    this.raw(`${id} 0 obj\n${content}\nendobj\n`);
  }

  /** Allocate + write a new object, returning its ID */
  addObj(content: string): number {
    const id = this._nextId++;
    this.writeObj(id, content);
    return id;
  }

  /** Write a stream object (with optional FlateDecode) */
  addStream(dictEntries: Record<string, string>, data: Buffer, compress: boolean): number {
    const id = this._nextId++;
    this.reg.push({ id, offset: this.buf.length });

    let body = data;
    const dict = { ...dictEntries };
    if (compress) {
      body = zlib.deflateSync(data);
      dict['/Filter'] = '/FlateDecode';
    }
    dict['/Length'] = String(body.length);

    const dictStr = Object.entries(dict)
      .map(([k, v]) => `${k} ${v}`)
      .join('\n');
    this.raw(`${id} 0 obj\n<<\n${dictStr}\n>>\nstream\n`);
    this.raw(body);
    this.raw('\nendstream\nendobj\n');
    return id;
  }

  /** Write an Object Stream containing multiple (id, content) pairs */
  addObjectStream(objects: Array<[number, string]>, compress: boolean): number {
    const streamId = this._nextId++;
    this.reg.push({ id: streamId, offset: this.buf.length });

    const offsets: string[] = [];
    const bodies: string[] = [];
    let off = 0;
    for (let i = 0; i < objects.length; i++) {
      const [oid, content] = objects[i];
      const body = content + '\n';
      offsets.push(`${oid} ${off}`);
      bodies.push(body);
      this.reg.push({ id: oid, offset: 0, inStream: streamId, indexInStream: i });
      off += Buffer.byteLength(body, 'binary');
    }

    const header = offsets.join(' ') + '\n';
    const full = Buffer.from(header + bodies.join(''), 'binary');
    let body = full;
    let filter = '';
    if (compress) {
      body = zlib.deflateSync(full);
      filter = '\n/Filter /FlateDecode';
    }

    const dictStr = `/Type /ObjStm\n/N ${objects.length}\n/First ${Buffer.byteLength(header, 'binary')}${filter}\n/Length ${body.length}`;
    this.raw(`${streamId} 0 obj\n<<\n${dictStr}\n>>\nstream\n`);
    this.raw(body);
    this.raw('\nendstream\nendobj\n');
    return streamId;
  }

  /** Finalize: write Cross-Reference Stream + startxref + %%EOF */
  finalize(rootId: number, infoId: number): Buffer {
    const xrefId = this._nextId++;
    const xrefOff = this.buf.length;

    // /W [1 4 2]: type(1) + offset_or_streamId(4) + gen_or_index(2)
    const W = [1, 4, 2];
    const ES = 7;
    const total = xrefId; // IDs 0..xrefId-1

    const byId = new Map<number, ObjEntry>();
    for (const r of this.reg) {
      if (!byId.has(r.id)) byId.set(r.id, r);
    }

    const xd = Buffer.alloc(total * ES, 0);
    // Entry 0: free
    xd[0] = 0;
    xd.writeUInt32BE(0, 1);
    xd.writeUInt16BE(0xffff, 5);

    for (let id = 1; id < xrefId; id++) {
      const r = byId.get(id);
      const p = id * ES;
      if (!r) {
        xd[p] = 0;
        xd.writeUInt32BE(0, p + 1);
        xd.writeUInt16BE(0xffff, p + 5);
      } else if (r.inStream !== undefined) {
        xd[p] = 2;
        xd.writeUInt32BE(r.inStream, p + 1);
        xd.writeUInt16BE(r.indexInStream ?? 0, p + 5);
      } else {
        xd[p] = 1;
        xd.writeUInt32BE(r.offset, p + 1);
        xd.writeUInt16BE(0, p + 5);
      }
    }

    const cxd = zlib.deflateSync(xd);
    const xdict = [
      `/Type /XRef`,
      `/Size ${xrefId}`,
      `/W [${W.join(' ')}]`,
      `/Root ${rootId} 0 R`,
      `/Info ${infoId} 0 R`,
      `/Filter /FlateDecode`,
      `/Length ${cxd.length}`,
    ].join('\n');

    this.raw(`${xrefId} 0 obj\n<<\n${xdict}\n>>\nstream\n`);
    this.raw(cxd);
    this.raw(`\nendstream\nendobj\nstartxref\n${xrefOff}\n%%EOF\n`);
    return this.buf;
  }
}

// ─── Text Encoding ───────────────────────────────────────────

export function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return true;
  return false;
}

export function encodePdfString(s: string, unicode: boolean): string {
  if (unicode || hasNonAscii(s)) {
    let hex = 'FEFF';
    for (let i = 0; i < s.length; i++)
      hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    return `<${hex}>`;
  }
  return `(${escapeLit(s)})`;
}

export function escapeLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// ─── XMP Metadata ────────────────────────────────────────────

export function buildXmp(meta: {
  title?: string;
  author?: string;
  subject?: string;
  producer?: string;
  creationDate?: string;
}): string {
  const now = nowIso().replace(/\.\d+Z$/, '+00:00');
  const created = meta.creationDate || now;
  const producer = meta.producer || 'Kyberion Native PDF 2.0 Engine';
  const titleXml = meta.title
    ? `    <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(meta.title)}</rdf:li></rdf:Alt></dc:title>`
    : '';
  const authorXml = meta.author
    ? `    <dc:creator><rdf:Seq><rdf:li>${escapeXml(meta.author)}</rdf:li></rdf:Seq></dc:creator>`
    : '';
  const subjectXml = meta.subject
    ? `    <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(meta.subject)}</rdf:li></rdf:Alt></dc:description>`
    : '';

  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>\n<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Kyberion Native PDF 2.0 Engine">\n  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n    <rdf:Description rdf:about=""\n        xmlns:dc="http://purl.org/dc/elements/1.1/"\n        xmlns:xmp="http://ns.adobe.com/xap/1.0/"\n        xmlns:pdf="http://ns.adobe.com/pdf/1.3/">\n${titleXml}\n${authorXml}\n${subjectXml}\n      <xmp:CreateDate>${created}</xmp:CreateDate>\n      <xmp:ModifyDate>${now}</xmp:ModifyDate>\n      <xmp:MetadataDate>${now}</xmp:MetadataDate>\n      <pdf:PDFVersion>2.0</pdf:PDFVersion>\n      <pdf:Producer>${escapeXml(producer)}</pdf:Producer>\n    </rdf:Description>\n  </rdf:RDF>\n</x:xmpmeta>\n<?xpacket end="w"?>`;
}

// ─── Page Labels ─────────────────────────────────────────────

const LABEL_STYLE: Record<string, string> = {
  decimal: '/D',
  'roman-upper': '/R',
  'roman-lower': '/r',
  'alpha-upper': '/A',
  'alpha-lower': '/a',
};

export function buildPageLabelsDict(labels: PdfPageLabel[]): string {
  const entries = labels.map((l) => {
    const parts: string[] = [];
    if (l.style && l.style !== 'none') parts.push(`/S ${LABEL_STYLE[l.style] ?? '/D'}`);
    if (l.prefix) parts.push(`/P (${escapeLit(l.prefix)})`);
    if (l.startValue !== undefined && l.startValue !== 1) parts.push(`/St ${l.startValue}`);
    return `${l.startIndex} << ${parts.join(' ')} >>`;
  });
  return `<< /Nums [${entries.join(' ')}] >>`;
}

// ─── Image XObject ────────────────────────────────────────────

export interface ImageInfo {
  width: number;
  height: number;
  colorSpace: string;
  bitsPerComponent: number;
  filter?: string;
  data: Buffer;
}

export type EmbeddedCjkFont = {
  font: FontKitFont;
  subsetBuffer: Buffer;
  fontName: string;
  glyphWidthByCid: Map<number, number>;
  encodeText: (text: string) => string;
  toUnicodeCMap: string;
  defaultWidth: number;
};

export type FontKitGlyph = {
  id: number;
  advanceWidth: number;
};

export type FontKitSubset = {
  includeGlyph: (glyph: FontKitGlyph) => number;
  encode: () => Uint8Array;
};

export type FontKitFont = {
  subfamilyName?: string;
  fullName?: string;
  familyName?: string;
  postscriptName?: string;
  unitsPerEm: number;
  ascent?: number;
  descent?: number;
  capHeight?: number;
  italicAngle?: number;
  bbox?: { minX: number; minY: number; maxX: number; maxY: number };
  glyphForCodePoint: (codePoint: number) => FontKitGlyph;
  createSubset: () => FontKitSubset;
};

export type FontKitCollection = {
  fonts?: FontKitFont[];
};

export const FONTKIT_REQUIRE = createRequire(import.meta.url);
export const FONTKIT = FONTKIT_REQUIRE('fontkit') as {
  openSync: (source: string) => FontKitFont | FontKitCollection;
};
export const CJK_FONT_CANDIDATES = [
  pathResolver.rootResolve('knowledge/public/design-patterns/fonts/NotoSansJP-Regular.ttf'),
  '/System/Library/Fonts/ヒラギノ角ゴシック W4.ttc',
  '/System/Library/Fonts/Hiragino Sans W4.ttc',
  '/System/Library/Fonts/Supplemental/Hiragino Sans W4.ttc',
  '/System/Library/Fonts/Supplemental/Yu Gothic Medium.otf',
  '/System/Library/Fonts/Supplemental/Yu Gothic.ttf',
  // Linux (fonts-noto-cjk package; paths vary by distro release)
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf',
  '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
];

export function toUtf16BeHex(codePoint: number): string {
  if (codePoint <= 0xffff) {
    return codePoint.toString(16).toUpperCase().padStart(4, '0');
  }
  const cp = codePoint - 0x10000;
  const high = 0xd800 + (cp >> 10);
  const low = 0xdc00 + (cp & 0x3ff);
  return `${high.toString(16).toUpperCase().padStart(4, '0')}${low
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')}`;
}

export function collectCodePoints(text: string): number[] {
  const points: number[] = [];
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) points.push(cp);
  }
  return points;
}

export function pickCjkFontSource(): string | null {
  for (const candidate of CJK_FONT_CANDIDATES) {
    if (safeExistsSync(candidate)) return candidate;
  }
  return null;
}

export function openCjkFont(): FontKitFont | null {
  const source = pickCjkFontSource();
  if (!source) return null;
  const opened = FONTKIT.openSync(source);
  if ('fonts' in opened && opened.fonts?.length) {
    return (
      opened.fonts.find((entry) =>
        /w4|regular/i.test(String(entry?.subfamilyName || entry?.fullName || ''))
      ) ?? opened.fonts[0]
    );
  }
  return opened as FontKitFont;
}

export function buildEmbeddedCjkFont(protocol: PdfDesignProtocol): EmbeddedCjkFont | null {
  const font = openCjkFont();
  if (!font) return null;
  const subset = font.createSubset();
  const cidByCodePoint = new Map<number, number>();
  const widthByCid = new Map<number, number>();

  const textCorpus: string[] = [];
  if (protocol.source?.title) textCorpus.push(protocol.source.title);
  if (protocol.source?.body) textCorpus.push(protocol.source.body);
  if (protocol.metadata?.title) textCorpus.push(String(protocol.metadata.title));
  if (protocol.metadata?.author) textCorpus.push(String(protocol.metadata.author));
  if (protocol.metadata?.subject) textCorpus.push(String(protocol.metadata.subject));
  for (const page of protocol.content?.pages ?? []) {
    if (page.text) textCorpus.push(page.text);
  }
  for (const element of protocol.aesthetic?.elements ?? []) {
    if ((element.type === 'text' || element.type === 'heading') && element.text) {
      textCorpus.push(element.text);
    }
  }
  const collectOutlineTitles = (item: PdfOutlineItem): void => {
    textCorpus.push(item.title);
    for (const child of item.children ?? []) collectOutlineTitles(child);
  };
  for (const outline of protocol.outlines ?? []) collectOutlineTitles(outline);

  const codePoints = new Set<number>();
  for (const entry of textCorpus) {
    for (const cp of collectCodePoints(entry)) {
      codePoints.add(cp);
    }
  }
  codePoints.add(0x20);

  const sortedCodePoints = [...codePoints].sort((a, b) => a - b);
  for (const codePoint of sortedCodePoints) {
    const glyph = font.glyphForCodePoint(codePoint);
    const cid = subset.includeGlyph(glyph);
    cidByCodePoint.set(codePoint, cid);
    const width = Math.max(0, Math.round((glyph.advanceWidth * 1000) / font.unitsPerEm));
    widthByCid.set(cid, width);
  }

  const subsetBuffer = Buffer.from(subset.encode());
  const defaultWidth = Math.max(
    0,
    Math.round(((font.glyphForCodePoint(0x20)?.advanceWidth || 0) * 1000) / font.unitsPerEm)
  );
  const fontName = String(font.postscriptName || font.fullName || font.familyName || 'KyberionCJK');

  const encodeText = (text: string): string => {
    let hex = '';
    for (const ch of Array.from(text)) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      const cid = cidByCodePoint.get(cp) ?? cidByCodePoint.get(0x20) ?? 0;
      hex += cid.toString(16).toUpperCase().padStart(4, '0');
    }
    return `<${hex}>`;
  };

  const bfChars: string[] = [];
  for (const [codePoint, cid] of cidByCodePoint.entries()) {
    bfChars.push(
      `<${cid.toString(16).toUpperCase().padStart(4, '0')}> <${toUtf16BeHex(codePoint)}>`
    );
  }
  const toUnicodeCMap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    `/CMapName /${fontName.replace(/[^A-Za-z0-9_-]/g, '') || 'KyberionCJK'} def`,
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    `${bfChars.length} beginbfchar`,
    ...bfChars,
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n');

  return {
    font,
    subsetBuffer,
    fontName,
    glyphWidthByCid: widthByCid,
    encodeText,
    toUnicodeCMap,
    defaultWidth,
  };
}

export function buildWidthArray(font: EmbeddedCjkFont): string {
  const entries = [...font.glyphWidthByCid.entries()].sort(([a], [b]) => a - b);
  if (entries.length === 0) return '[]';
  const chunks: string[] = [];
  for (const [cid, width] of entries) {
    chunks.push(`${cid} [${width}]`);
  }
  return `[${chunks.join(' ')}]`;
}

export function buildEmbeddedFontDescriptor(font: EmbeddedCjkFont, fontFileId: number): string {
  const unitsPerEm = font.font.unitsPerEm || 1000;
  const bbox = font.font.bbox || { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  const flags = 32;
  return [
    '<<',
    '/Type /FontDescriptor',
    `/FontName /${font.fontName.replace(/[^A-Za-z0-9_-]/g, '') || 'KyberionCJK'}`,
    `/Flags ${flags}`,
    `/FontBBox [${bbox.minX} ${bbox.minY} ${bbox.maxX} ${bbox.maxY}]`,
    `/ItalicAngle ${font.font.italicAngle || 0}`,
    `/Ascent ${font.font.ascent || unitsPerEm}`,
    `/Descent ${font.font.descent || 0}`,
    `/CapHeight ${font.font.capHeight || font.font.ascent || unitsPerEm}`,
    `/StemV 80`,
    `/FontFile2 ${fontFileId} 0 R`,
    '>>',
  ].join(' ');
}

export function buildEmbeddedDescendantFontObject(
  font: EmbeddedCjkFont,
  descriptorId: number
): string {
  return [
    '<<',
    '/Type /Font',
    '/Subtype /CIDFontType2',
    `/BaseFont /${font.fontName.replace(/[^A-Za-z0-9_-]/g, '') || 'KyberionCJK'}`,
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>',
    `/FontDescriptor ${descriptorId} 0 R`,
    `/DW ${font.defaultWidth || 1000}`,
    `/W ${buildWidthArray(font)}`,
    '/CIDToGIDMap /Identity',
    '>>',
  ].join(' ');
}

export function buildEmbeddedType0FontObject(
  font: EmbeddedCjkFont,
  descendantFontId: number,
  toUnicodeId: number
): string {
  return [
    '<<',
    '/Type /Font',
    '/Subtype /Type0',
    `/BaseFont /${font.fontName.replace(/[^A-Za-z0-9_-]/g, '') || 'KyberionCJK'}`,
    '/Encoding /Identity-H',
    `/DescendantFonts [${descendantFontId} 0 R]`,
    `/ToUnicode ${toUnicodeId} 0 R`,
    '>>',
  ].join(' ');
}
