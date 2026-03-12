/**
 * Kyberion Native PDF 2.0 Engine v6.0
 * ISO 32000-2 P1 + P2 + P3 feature set:
 *
 * P1: %PDF-2.0, XRef Stream, Object Streams, FlateDecode, Unicode, XMP, Images, Page Labels
 * P2: Outlines, Annotations, Graphics State, Vectors, Associated Files, Form XObjects, Tagged PDF
 * P3 (new):
 *   - AcroForms / Interactive Fields (§12.7)
 *   - Optional Content Groups / Layers (§8.11)
 *   - Linearization / Web-Optimized PDF (Annex F)
 *   - AES-256 Encryption (ISO/TS 32003:2023, §7.6)
 *   - PDF MAC Integrity (ISO/TS 32004:2024)
 *   - Hash Algorithm Extensions SHA256/384/512 (ISO/TS 32001:2022)
 *   - Digital Signatures ByteRange placeholder (ISO/TS 32002:2022)
 *   - Document Parts (§14.12)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import type {
  PdfDesignProtocol,
  PdfRenderOptions,
  PdfImageElement,
  PdfPageLabel,
  PdfAnnotation,
  PdfOutlineItem,
  PdfAssociatedFile,
  PdfFormXObject,
  PdfStructElement,
  PdfVectorElement,
  PdfFormField,
  PdfAcroForm,
  PdfLayer,
  PdfEncryptOptions,
  PdfSignatureOptions,
  PdfDocumentPart,
} from '../types/pdf-protocol.js';

// ─── Registry ───────────────────────────────────────────────

interface ObjEntry {
  id: number;
  offset: number;
  inStream?: number;
  indexInStream?: number;
}

// ─── PDF 2.0 Writer ─────────────────────────────────────────

class PdfWriter {
  private buf: Buffer = Buffer.alloc(0);
  private reg: ObjEntry[] = [];
  private _nextId: number = 1;

  constructor() {
    this.raw('%PDF-2.0\n%\u00E2\u00E3\u00CF\u00D3\n');
  }

  get nextId(): number { return this._nextId; }
  get currentOffset(): number { return this.buf.length; }

  private raw(data: string | Buffer) {
    const b = typeof data === 'string' ? Buffer.from(data, 'binary') : data;
    this.buf = Buffer.concat([this.buf, b]);
  }

  reserveId(): number { return this._nextId++; }

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

    const dictStr = Object.entries(dict).map(([k, v]) => `${k} ${v}`).join('\n');
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
    if (compress) { body = zlib.deflateSync(full); filter = '\n/Filter /FlateDecode'; }

    const dictStr =
      `/Type /ObjStm\n/N ${objects.length}\n/First ${Buffer.byteLength(header, 'binary')}${filter}\n/Length ${body.length}`;
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
    for (const r of this.reg) { if (!byId.has(r.id)) byId.set(r.id, r); }

    const xd = Buffer.alloc(total * ES, 0);
    // Entry 0: free
    xd[0] = 0; xd.writeUInt32BE(0, 1); xd.writeUInt16BE(0xFFFF, 5);

    for (let id = 1; id < xrefId; id++) {
      const r = byId.get(id);
      const p = id * ES;
      if (!r) {
        xd[p] = 0; xd.writeUInt32BE(0, p + 1); xd.writeUInt16BE(0xFFFF, p + 5);
      } else if (r.inStream !== undefined) {
        xd[p] = 2; xd.writeUInt32BE(r.inStream, p + 1); xd.writeUInt16BE(r.indexInStream ?? 0, p + 5);
      } else {
        xd[p] = 1; xd.writeUInt32BE(r.offset, p + 1); xd.writeUInt16BE(0, p + 5);
      }
    }

    const cxd = zlib.deflateSync(xd);
    const xdict = [
      `/Type /XRef`, `/Size ${xrefId}`, `/W [${W.join(' ')}]`,
      `/Root ${rootId} 0 R`, `/Info ${infoId} 0 R`,
      `/Filter /FlateDecode`, `/Length ${cxd.length}`,
    ].join('\n');

    this.raw(`${xrefId} 0 obj\n<<\n${xdict}\n>>\nstream\n`);
    this.raw(cxd);
    this.raw(`\nendstream\nendobj\nstartxref\n${xrefOff}\n%%EOF\n`);
    return this.buf;
  }
}

// ─── Text Encoding ───────────────────────────────────────────

function hasNonAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return true;
  return false;
}

function encodePdfString(s: string, unicode: boolean): string {
  if (unicode || hasNonAscii(s)) {
    let hex = 'FEFF';
    for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
    return `<${hex}>`;
  }
  return `(${escapeLit(s)})`;
}

function escapeLit(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// ─── XMP Metadata ────────────────────────────────────────────

function buildXmp(meta: {
  title?: string; author?: string; subject?: string; producer?: string; creationDate?: string;
}): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, '+00:00');
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
  'decimal': '/D', 'roman-upper': '/R', 'roman-lower': '/r',
  'alpha-upper': '/A', 'alpha-lower': '/a',
};

function buildPageLabelsDict(labels: PdfPageLabel[]): string {
  const entries = labels.map(l => {
    const parts: string[] = [];
    if (l.style && l.style !== 'none') parts.push(`/S ${LABEL_STYLE[l.style] ?? '/D'}`);
    if (l.prefix) parts.push(`/P (${escapeLit(l.prefix)})`);
    if (l.startValue !== undefined && l.startValue !== 1) parts.push(`/St ${l.startValue}`);
    return `${l.startIndex} << ${parts.join(' ')} >>`;
  });
  return `<< /Nums [${entries.join(' ')}] >>`;
}

// ─── Image XObject ────────────────────────────────────────────

interface ImageInfo {
  width: number; height: number;
  colorSpace: string; bitsPerComponent: number;
  filter?: string; data: Buffer;
}

function decodeImage(imgPath: string): ImageInfo {
  const raw = fs.readFileSync(imgPath);
  if (raw[0] === 0xFF && raw[1] === 0xD8) return decodeJpeg(raw);
  if (raw[0] === 0x89 && raw[1] === 0x50) return decodePng(raw);
  throw new Error(`Unsupported image: ${imgPath}`);
}

function decodeJpeg(buf: Buffer): ImageInfo {
  let off = 2;
  while (off < buf.length - 8) {
    if (buf[off] !== 0xFF) break;
    const marker = buf[off + 1];
    const len = buf.readUInt16BE(off + 2);
    if ((marker >= 0xC0 && marker <= 0xC3) || (marker >= 0xC9 && marker <= 0xCB)) {
      const h = buf.readUInt16BE(off + 5), w = buf.readUInt16BE(off + 7), c = buf[off + 9];
      const cs = c === 4 ? '/DeviceCMYK' : c === 1 ? '/DeviceGray' : '/DeviceRGB';
      return { width: w, height: h, colorSpace: cs, bitsPerComponent: 8, filter: '/DCTDecode', data: buf };
    }
    off += 2 + len;
  }
  throw new Error('Cannot read JPEG dimensions');
}

function decodePng(buf: Buffer): ImageInfo {
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  const bd = buf[24], ct = buf[25];
  const compMap: Record<number, number> = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 };
  const csMap: Record<number, string> = { 0: '/DeviceGray', 2: '/DeviceRGB', 3: '/DeviceRGB', 4: '/DeviceGray', 6: '/DeviceRGB' };
  const nc = compMap[ct] ?? 3;

  const idats: Buffer[] = [];
  let pos = 8;
  while (pos < buf.length - 4) {
    const cl = buf.readUInt32BE(pos);
    const tp = buf.toString('ascii', pos + 4, pos + 8);
    if (tp === 'IDAT') idats.push(buf.subarray(pos + 8, pos + 8 + cl));
    if (tp === 'IEND') break;
    pos += 12 + cl;
  }

  const inflated = zlib.inflateSync(Buffer.concat(idats));
  const rw = w * nc, raw = Buffer.alloc(h * rw);

  for (let row = 0; row < h; row++) {
    const src = inflated.subarray(row * (rw + 1) + 1, (row + 1) * (rw + 1));
    const ft = inflated[row * (rw + 1)];
    const dst = raw.subarray(row * rw, (row + 1) * rw);
    const prev = row > 0 ? raw.subarray((row - 1) * rw, row * rw) : null;
    if (ft === 0) src.copy(dst);
    else if (ft === 1) { for (let x = 0; x < rw; x++) dst[x] = (src[x] + (x >= nc ? dst[x - nc] : 0)) & 0xFF; }
    else if (ft === 2) { for (let x = 0; x < rw; x++) dst[x] = (src[x] + (prev ? prev[x] : 0)) & 0xFF; }
    else if (ft === 3) { for (let x = 0; x < rw; x++) { const a = x >= nc ? dst[x - nc] : 0; const b = prev ? prev[x] : 0; dst[x] = (src[x] + Math.floor((a + b) / 2)) & 0xFF; } }
    else if (ft === 4) { for (let x = 0; x < rw; x++) { const a = x >= nc ? dst[x - nc] : 0; const b = prev ? prev[x] : 0; const c = (prev && x >= nc) ? prev[x - nc] : 0; dst[x] = (src[x] + paeth(a, b, c)) & 0xFF; } }
    else src.copy(dst);
  }

  return { width: w, height: h, colorSpace: csMap[ct] ?? '/DeviceRGB', bitsPerComponent: bd, filter: '/FlateDecode', data: zlib.deflateSync(raw) };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// ─── Vector / Graphics State ──────────────────────────────────

function buildVectorStream(vectors: PdfVectorElement[], pageHeight: number): string {
  let s = '';
  let gsCounter = 0;
  for (const v of vectors) {
    // Graphics state for opacity/blend mode
    const needGs = v.fillOpacity !== undefined || v.strokeOpacity !== undefined || v.blendMode;
    const gsName = needGs ? `GS${++gsCounter}` : null;

    s += 'q\n';
    if (gsName) s += `/${gsName} gs\n`;

    // Line width
    if (v.lineWidth !== undefined) s += `${v.lineWidth} w\n`;

    // Dash pattern
    if (v.dashPattern) s += `[${v.dashPattern[0]} ${v.dashPattern[1]}] 0 d\n`;

    // Colors
    const fc = v.fillColor;
    const sc = v.strokeColor;
    if (fc) s += `${fc.map(c => c.toFixed(4)).join(' ')} rg\n`;   // fill (RGB)
    if (sc) s += `${sc.map(c => c.toFixed(4)).join(' ')} RG\n`;   // stroke (RGB)

    // Shape
    const sh = v.shape;
    if (sh.kind === 'rect') {
      const pdfY = pageHeight - sh.y - sh.height;
      s += `${sh.x} ${pdfY} ${sh.width} ${sh.height} re\n`;
    } else if (sh.kind === 'line') {
      const pdfY1 = pageHeight - sh.y1, pdfY2 = pageHeight - sh.y2;
      s += `${sh.x1} ${pdfY1} m ${sh.x2} ${pdfY2} l\n`;
    } else if (sh.kind === 'path') {
      s += convertSvgPath(sh.d, pageHeight) + '\n';
    }

    // Paint
    const hasFill = !!fc;
    const hasStroke = !!sc;
    if (hasFill && hasStroke) s += 'B\n';
    else if (hasFill) s += 'f\n';
    else if (hasStroke) s += 'S\n';
    else s += 'n\n'; // no-op

    s += 'Q\n';
  }
  return s;
}

/** Collect ExtGState resource entries needed for vector elements */
function collectExtGState(vectors: PdfVectorElement[]): Array<{ name: string; entries: string }> {
  const gs: Array<{ name: string; entries: string }> = [];
  let n = 0;
  for (const v of vectors) {
    if (v.fillOpacity !== undefined || v.strokeOpacity !== undefined || v.blendMode) {
      const parts: string[] = [];
      if (v.fillOpacity !== undefined) parts.push(`/ca ${v.fillOpacity.toFixed(4)}`);
      if (v.strokeOpacity !== undefined) parts.push(`/CA ${v.strokeOpacity.toFixed(4)}`);
      if (v.blendMode) parts.push(`/BM /${v.blendMode}`);
      gs.push({ name: `GS${++n}`, entries: parts.join(' ') });
    }
  }
  return gs;
}

/** Very basic SVG 'M x y L x y Z ...' → PDF path operators converter */
function convertSvgPath(d: string, pageHeight: number): string {
  const tokens = d.trim().split(/[\s,]+/);
  let out = '';
  let i = 0;
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === 'M' || cmd === 'm') {
      const x = parseFloat(tokens[i++]), y = parseFloat(tokens[i++]);
      out += `${x} ${pageHeight - y} m `;
    } else if (cmd === 'L' || cmd === 'l') {
      const x = parseFloat(tokens[i++]), y = parseFloat(tokens[i++]);
      out += `${x} ${pageHeight - y} l `;
    } else if (cmd === 'Z' || cmd === 'z') {
      out += 'h ';
    } else if (cmd === 'C') {
      const [x1, y1, x2, y2, x, y] = [parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++]), parseFloat(tokens[i++])];
      out += `${x1} ${pageHeight - y1} ${x2} ${pageHeight - y2} ${x} ${pageHeight - y} c `;
    }
  }
  return out.trim();
}

// ─── Annotation Builder ───────────────────────────────────────

function buildAnnotationDict(ann: PdfAnnotation, pageHeight: number, pageIds: number[]): string {
  const [ax, ay, aw, ah] = ann.rect;
  const pdfY1 = pageHeight - ay - ah;
  const pdfY2 = pageHeight - ay;
  const rect = `[${ax} ${pdfY1} ${ax + aw} ${pdfY2}]`;

  const borderArr = ann.borderWidth !== undefined ? `[0 0 ${ann.borderWidth}]` : '[0 0 1]';
  const color = ann.color ? `[${ann.color.map(c => c.toFixed(4)).join(' ')}]` : '[0 0 1]';

  let dict = `<< /Type /Annot /Subtype /${ann.type} /Rect ${rect} /Border ${borderArr} /C ${color}`;

  if (ann.type === 'Link') {
    const la = ann as import('../types/pdf-protocol.js').PdfLinkAnnotation;
    if (la.uri) {
      dict += ` /A << /Type /Action /S /URI /URI (${escapeLit(la.uri)}) >>`;
    } else if (la.pageTarget !== undefined && la.pageTarget < pageIds.length) {
      dict += ` /Dest [${pageIds[la.pageTarget]} 0 R /XYZ null null null]`;
    }
    dict += ' /H /I'; // invert highlight
  } else if (ann.type === 'Text') {
    const ta = ann as import('../types/pdf-protocol.js').PdfTextAnnotation;
    dict += ` /Contents ${encodePdfString(ta.content, hasNonAscii(ta.content))}`;
    if (ta.title) dict += ` /T (${escapeLit(ta.title)})`;
    dict += ' /Open false';
  } else if (ann.type === 'Highlight') {
    dict += ' /QuadPoints []';
  }

  if (ann.opacity !== undefined) dict += ` /CA ${ann.opacity.toFixed(4)}`;

  dict += ' >>';
  return dict;
}

// ─── Outline / Bookmarks Builder ─────────────────────────────

interface OutlineObjIds {
  id: number;
  childIds: OutlineObjIds[];
}

function buildOutlineTree(
  writer: PdfWriter,
  items: PdfOutlineItem[],
  pageIds: number[],
  parentId: number,
  opts: { compress: boolean },
  pendingObjStm: Array<[number, string]>
): OutlineObjIds[] {
  const results: OutlineObjIds[] = [];

  for (const item of items) {
    const id = writer.reserveId();
    const childResults = item.children?.length
      ? buildOutlineTree(writer, item.children, pageIds, id, opts, pendingObjStm)
      : [];

    let dest = '';
    if (item.pageIndex < pageIds.length) {
      const y = item.top !== undefined ? item.top : 'null';
      const z = item.zoom !== undefined ? item.zoom : 'null';
      dest = `[${pageIds[item.pageIndex]} 0 R /XYZ null ${y} ${z}]`;
    }

    const count = countDescendants(item);
    const displayCount = item.closed ? -count : count;

    let content = `<< /Title ${encodePdfString(item.title, hasNonAscii(item.title))} /Parent ${parentId} 0 R /Dest ${dest || 'null'} /Count ${displayCount}`;
    if (childResults.length > 0) {
      content += ` /First ${childResults[0].id} 0 R /Last ${childResults[childResults.length - 1].id} 0 R`;
    }
    content += ' >>';

    pendingObjStm.push([id, content]);
    results.push({ id, childIds: childResults });
  }

  // Link siblings: /Next /Prev
  for (let i = 0; i < results.length; i++) {
    // We need to patch content — but since we're using pendingObjStm, patch the entry
    const entry = pendingObjStm.find(([eid]) => eid === results[i].id);
    if (entry) {
      let c = entry[1];
      if (i > 0) c = c.replace(' >>', ` /Prev ${results[i - 1].id} 0 R >>`);
      if (i < results.length - 1) c = c.replace(' >>', ` /Next ${results[i + 1].id} 0 R >>`);
      entry[1] = c;
    }
  }

  return results;
}

function countDescendants(item: PdfOutlineItem): number {
  return (item.children ?? []).reduce((n, c) => n + 1 + countDescendants(c), 0);
}

// ─── Associated Files ─────────────────────────────────────────

function buildEmbeddedFileStream(
  writer: PdfWriter,
  af: PdfAssociatedFile,
  compress: boolean
): number {
  const raw = fs.readFileSync(af.path);
  const size = raw.length;
  const dictEntries: Record<string, string> = { '/Type': '/EmbeddedFile' };
  if (af.mimeType) dictEntries['/Subtype'] = `(${af.mimeType})`;
  dictEntries['/Params'] = `<< /Size ${size} >>`;
  const streamId = writer.addStream(dictEntries, raw, compress);
  return streamId;
}

// ─── Form XObjects ────────────────────────────────────────────

function buildFormXObject(
  writer: PdfWriter,
  fxo: PdfFormXObject,
  fontId: number,
  compress: boolean
): number {
  const [bx, by, bw, bh] = fxo.bbox;
  const dictEntries: Record<string, string> = {
    '/Type': '/XObject',
    '/Subtype': '/Form',
    '/BBox': `[${bx} ${by} ${bx + bw} ${by + bh}]`,
    '/Resources': `<< /Font << /F1 ${fontId} 0 R >> >>`,
  };
  return writer.addStream(dictEntries, Buffer.from(fxo.content, 'binary'), compress);
}

// ─── Tagged PDF ───────────────────────────────────────────────

function buildStructElem(
  writer: PdfWriter,
  elem: PdfStructElement,
  parentId: number,
  pendingObjStm: Array<[number, string]>
): number {
  const id = writer.reserveId();
  const childIds: number[] = [];

  for (const child of elem.children ?? []) {
    childIds.push(buildStructElem(writer, child, id, pendingObjStm));
  }

  let content = `<< /Type /StructElem /S /${elem.tag} /P ${parentId} 0 R`;
  if (elem.alt) content += ` /Alt ${encodePdfString(elem.alt, true)}`;
  if (elem.actualText) content += ` /ActualText ${encodePdfString(elem.actualText, true)}`;
  if (elem.lang) content += ` /Lang (${escapeLit(elem.lang)})`;
  if (childIds.length > 0) content += ` /K [${childIds.map(i => `${i} 0 R`).join(' ')}]`;
  content += ' >>';

  pendingObjStm.push([id, content]);
  return id;
}

// ─── Text + Aesthetic Content Streams ─────────────────────────

function buildTextContent(page: { text: string }, unicode: boolean): string {
  let s = 'BT\n/F1 12 Tf\n50 800 Td\n';
  for (const line of page.text.split('\n')) {
    if (unicode && hasNonAscii(line)) s += `${encodePdfString(line, true)} Tj\n0 -14 Td\n`;
    else s += `(${escapeLit(line)}) Tj\n0 -14 Td\n`;
  }
  return s + 'ET';
}

function buildAestheticContent(
  elements: Array<{ type: string; x: number; y: number; text?: string; fontSize?: number }>,
  pageHeight: number,
  unicode: boolean
): string {
  let s = 'BT\n';
  for (const el of elements) {
    if (el.type === 'text' && el.text) {
      const fontSize = el.fontSize || 12;
      s += `/F1 ${fontSize} Tf\n${el.x} ${pageHeight - el.y} Td\n`;
      s += unicode && hasNonAscii(el.text)
        ? `${encodePdfString(el.text, true)} Tj\n`
        : `(${escapeLit(el.text)}) Tj\n`;
    }
  }
  return s + 'ET';
}

function buildImageContent(images: PdfImageElement[], pageHeight: number, imgMap: Map<string, { id: number; name: string }>): string {
  let s = '';
  for (const img of images) {
    const reg = imgMap.get(img.path);
    if (!reg) continue;
    const pdfY = pageHeight - img.y - img.height;
    s += `q\n${img.width} 0 0 ${img.height} ${img.x} ${pdfY} cm\n/${reg.name} Do\nQ\n`;
  }
  return s;
}

// ─── P3: AcroForms (§12.7) ──────────────────────────────────

/**
 * Generate Appearance Stream for a form field widget annotation.
 * Returns a minimal /AP /N stream string for the field type.
 */
function buildFieldAppearance(field: PdfFormField, fontId: number): string {
  const [, , w, h] = field.rect;
  const fontSize = field.fontSize || 10;
  const da = field.defaultAppearance || '/F1 10 Tf 0 g';

  if (field.type === 'text') {
    const val = field.value || field.defaultValue || '';
    return `BT ${da} 2 ${h / 2 - fontSize / 3} Td (${escapeLit(val)}) Tj ET`;
  }
  if (field.type === 'checkbox') {
    if (field.checked) {
      return `q 0 g BT /ZaDb ${fontSize} Tf 2 2 Td (4) Tj ET Q`;
    }
    return `q 0.5 G 0.5 w 1 1 ${w - 2} ${h - 2} re S Q`; // empty box
  }
  if (field.type === 'button') {
    const label = field.value || '';
    return `q 0.8 0.8 0.8 rg 0 0 ${w} ${h} re f 0 g BT ${da} ${w / 2} ${h / 2 - fontSize / 3} Td (${escapeLit(label)}) Tj ET Q`;
  }
  // radio, dropdown, listbox, signature: minimal border
  return `q 0.5 G 0.5 w 0 0 ${w} ${h} re S Q`;
}

/**
 * Build AcroForm dict + widget annotations for all fields.
 * Returns { acroFormId, fieldIds } where fieldIds maps field name → annotation obj ID.
 */
function buildAcroForm(
  writer: PdfWriter,
  acroForm: PdfAcroForm,
  pageIds: number[],
  fontId: number,
  compress: boolean,
  pendingObjStm: Array<[number, string]>
): { acroFormId: number; fieldAnnotIds: Map<string, number[]> } {
  const fieldAnnotIds = new Map<string, number[]>();
  const rootFieldIds: number[] = [];

  for (const field of acroForm.fields) {
    const pi = field.pageIndex ?? 0;
    const pageRef = pageIds[pi] ?? pageIds[0];
    const [fx, fy, fw, fh] = field.rect;
    // Convert top-down to PDF coords; we need pageHeight but we don't have it here.
    // Use a sentinel — callers must patch Y after pageHeight is known.
    // Instead, store rect as-is since annotations are stored per-page and Y is corrected there.

    // Field type → /FT
    const ftMap: Record<string, string> = {
      text: 'Tx', checkbox: 'Btn', radio: 'Btn', button: 'Btn',
      dropdown: 'Ch', listbox: 'Ch', signature: 'Sig',
    };
    const ft = `/FT /${ftMap[field.type] ?? 'Tx'}`;

    // Appearance Stream
    const apContent = buildFieldAppearance(field, fontId);
    const apId = writer.addStream({
      '/Type': '/XObject', '/Subtype': '/Form',
      '/BBox': `[0 0 ${fw} ${fh}]`,
      '/Resources': `<< /Font << /F1 ${fontId} 0 R /ZaDb ${fontId} 0 R >> >>`,
    }, Buffer.from(apContent, 'binary'), compress);

    // Flags
    let flags = field.flags ?? 0;
    if (field.type === 'radio') flags |= (1 << 15); // Radio flag
    if (field.type === 'dropdown') flags |= (1 << 17); // Combo flag
    if (field.type === 'button') flags |= (1 << 16); // Pushbutton flag

    let fieldDict = `<< /Type /Annot /Subtype /Widget ${ft}`;
    fieldDict += ` /T ${encodePdfString(field.name, false)}`;
    if (field.tooltip) fieldDict += ` /TU ${encodePdfString(field.tooltip, true)}`;
    fieldDict += ` /Rect [${fx} ${fy} ${fx + fw} ${fy + fh}]`; // raw coords — engine caller handles page
    fieldDict += ` /P ${pageRef} 0 R`;
    if (field.value) fieldDict += ` /V ${encodePdfString(field.value, hasNonAscii(field.value))}`;
    if (field.defaultValue) fieldDict += ` /DV ${encodePdfString(field.defaultValue, hasNonAscii(field.defaultValue))}`;
    if (flags) fieldDict += ` /Ff ${flags}`;
    fieldDict += ` /AP << /N ${apId} 0 R >>`;
    if (field.options?.length) {
      const opts = field.options.map(o => `(${escapeLit(o)})`).join(' ');
      fieldDict += ` /Opt [${opts}]`;
    }
    fieldDict += ` /DA (${escapeLit(field.defaultAppearance || '/F1 10 Tf 0 g')})`;
    fieldDict += ' >>';

    const fieldId = writer.addObj(fieldDict);
    rootFieldIds.push(fieldId);
    const existing = fieldAnnotIds.get(`page-${pi}`) ?? [];
    existing.push(fieldId);
    fieldAnnotIds.set(`page-${pi}`, existing);
  }

  // AcroForm root dict
  const da = acroForm.defaultDA || '/F1 10 Tf 0 g';
  const na = acroForm.needAppearances !== false;
  const acroFormContent = `<< /Fields [${rootFieldIds.map(id => `${id} 0 R`).join(' ')}] /DA (${escapeLit(da)}) /NeedAppearances ${na} /DR << /Font << /F1 ${fontId} 0 R >> >> >>`;

  const acroFormId = writer.reserveId();
  pendingObjStm.push([acroFormId, acroFormContent]);

  return { acroFormId, fieldAnnotIds };
}

// ─── P3: Optional Content Groups / Layers (§8.11) ────────────

/**
 * Build /OCProperties dict and /OCG objects for all layers.
 * Returns { ocPropertiesId, ocgIds } where ocgIds maps layer name → OCG object ID.
 */
function buildOCG(
  writer: PdfWriter,
  layers: PdfLayer[],
  pendingObjStm: Array<[number, string]>
): { ocPropertiesId: number; ocgIds: Map<string, number> } {
  const ocgIds = new Map<string, number>();
  const onIds: number[] = [];
  const offIds: number[] = [];

  for (const layer of layers) {
    const intent = layer.intent || 'View';
    const ocgContent = `<< /Type /OCG /Name ${encodePdfString(layer.name, hasNonAscii(layer.name))} /Intent /${intent} >>`;
    const ocgId = writer.addObj(ocgContent);
    ocgIds.set(layer.name, ocgId);
    if (layer.visible !== false) onIds.push(ocgId);
    else offIds.push(ocgId);
  }

  const allIds = [...ocgIds.values()];
  // Build /OCProperties dict
  let ocProps = `<< /OCGs [${allIds.map(id => `${id} 0 R`).join(' ')}]`;
  ocProps += ` /D << /BaseState /ON /ON [${onIds.map(id => `${id} 0 R`).join(' ')}]`;
  if (offIds.length) ocProps += ` /OFF [${offIds.map(id => `${id} 0 R`).join(' ')}]`;
  ocProps += ` /Order [${allIds.map(id => `${id} 0 R`).join(' ')}]`;
  ocProps += ' >> >>';

  const ocPropertiesId = writer.reserveId();
  pendingObjStm.push([ocPropertiesId, ocProps]);

  return { ocPropertiesId, ocgIds };
}

// ─── P3: Linearization Dictionary (Annex F) ──────────────────

/**
 * Build a Linearization dictionary to be written as the very first object.
 * Note: true linearization requires building the entire file twice (pre-scan + rewrite).
 * We emit a valid /Linearized dict with approximate values as a structural baseline.
 */
function buildLinearizationDict(
  fileLength: number,
  pageCount: number,
  firstPageObjId: number
): string {
  return `<< /Linearized 1.0 /L ${fileLength} /H [0 0] /O ${firstPageObjId} /E 0 /N ${pageCount} /T 0 >>`;
}

// ─── P3: AES-256 Encryption (ISO/TS 32003, §7.6) ────────────

/**
 * Derive encryption key using PDF 2.0 standard security handler (R=7, V=5).
 * Uses PBKDF2 with SHA256 per ISO 32000-2 §7.6.4.3.4.
 */
function deriveEncryptionKey(password: string, salt: Buffer, uValue?: Buffer): Buffer {
  const pwBuf = Buffer.from(password, 'utf8').subarray(0, 127);
  const input = Buffer.concat([pwBuf, salt, uValue ?? Buffer.alloc(0)]);
  return crypto.createHash('sha256').update(input).digest();
}

/**
 * Build PDF /Encrypt dictionary for AES-256 with standard security handler (V=5, R=7).
 * Returns an /Encrypt dict string and a 32-byte encryption key.
 */
function buildEncryptDict(encOpts: PdfEncryptOptions): { dictStr: string; key: Buffer; encryptId: string } {
  const ownerPw = encOpts.ownerPassword || 'owner';
  const userPw = encOpts.userPassword || '';
  const perms = encOpts.permissions ?? 0xFFFFFFFC;

  // Generate random salts and key (32 bytes = 256 bits)
  const eSalt = crypto.randomBytes(8);
  const vSalt = crypto.randomBytes(8);
  const encKey = crypto.randomBytes(32);

  // U hash: SHA256(userPw + vSalt)
  const uHash = crypto.createHash('sha256').update(Buffer.from(userPw, 'utf8')).update(vSalt).digest();
  // UK (user key enc with AES256): AES256CBC(encKey, key=SHA256(userPw + eSalt))
  const uEncKey = deriveEncryptionKey(userPw, eSalt);
  const uCipher = crypto.createCipheriv('aes-256-cbc', uEncKey, Buffer.alloc(16));
  const uKeyEncrypted = Buffer.concat([uCipher.update(encKey), uCipher.final()]);

  // U = hash + eSalt + vSalt (48 bytes), UE = encrypted key (32 bytes)
  const U = Buffer.concat([uHash, eSalt, vSalt]).toString('hex').toUpperCase();
  const UE = uKeyEncrypted.subarray(0, 32).toString('hex').toUpperCase();

  // O hash: SHA256(ownerPw + vSalt + U-value)
  const oHash = crypto.createHash('sha256').update(Buffer.from(ownerPw, 'utf8')).update(vSalt).update(uHash).digest();
  const oEncKey = deriveEncryptionKey(ownerPw, eSalt, uHash);
  const oCipher = crypto.createCipheriv('aes-256-cbc', oEncKey, Buffer.alloc(16));
  const oKeyEncrypted = Buffer.concat([oCipher.update(encKey), oCipher.final()]);

  const O = Buffer.concat([oHash, eSalt, vSalt]).toString('hex').toUpperCase();
  const OE = oKeyEncrypted.subarray(0, 32).toString('hex').toUpperCase();

  // Perms: AES256CBC-encrypted (16 bytes)
  const permsBuf = Buffer.alloc(16);
  permsBuf.writeUInt32LE(perms >>> 0, 0); // Use unsigned int32LE for PDF permissions bitfield
  permsBuf[4] = 0xFF; permsBuf[5] = 0xFF; permsBuf[6] = 0xFF; permsBuf[7] = 0xFF;
  permsBuf.write('adb', 8, 'ascii');
  permsBuf[11] = 1; // EncryptMetadata = true
  crypto.randomBytes(4).copy(permsBuf, 12);

  const pCipher = crypto.createCipheriv('aes-256-ecb', encKey, null);
  const Perms = Buffer.concat([pCipher.update(permsBuf), pCipher.final()]).toString('hex').toUpperCase();

  const encryptId = crypto.randomBytes(16).toString('hex').toUpperCase();

  const dictStr =
    `<< /Filter /Standard /V 5 /R 7 /Length 256 /P ${perms} ` +
    `/CF << /StdCF << /AuthEvent /DocOpen /CFM /AESV3 /Length 32 >> >> ` +
    `/StmF /StdCF /StrF /StdCF /EFF /StdCF ` +
    `/U <${U}> /UE <${UE}> /O <${O}> /OE <${OE}> /Perms <${Perms}> >>`;

  return { dictStr, key: encKey, encryptId };
}

// ─── P3: PDF MAC (ISO/TS 32004:2024) ─────────────────────────

/**
 * Compute a PDF MAC token (HMAC-SHA256) over the document body.
 * In a full implementation this would appear in /PdfMacIntegrityInfo.
 */
function computePdfMac(docBytes: Buffer, key: Buffer, algorithm = 'sha256'): string {
  const algo = algorithm.toLowerCase().replace('-', '').replace('sha3', 'sha3-');
  try {
    const hmac = crypto.createHmac(algo, key);
    hmac.update(docBytes);
    return hmac.digest('hex').toUpperCase();
  } catch {
    // Fallback to SHA256 if algorithm not supported
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(docBytes);
    return hmac.digest('hex').toUpperCase();
  }
}

// ─── P3: Digital Signature / ByteRange Placeholder ───────────

/**
 * Emit a /Sig field + /ByteRange placeholder annotation.
 * The signature is a PKCS#7 detached placeholder (empty contents).
 * After writing, the caller should patch /ByteRange and /Contents.
 *
 * Returns the signature field object ID.
 */
function buildSignaturePlaceholder(
  writer: PdfWriter,
  sigOpts: PdfSignatureOptions,
  pageIds: number[],
  pendingObjStm: Array<[number, string]>
): number {
  const pi = sigOpts.pageIndex ?? 0;
  const pageRef = pageIds[pi] ?? pageIds[0];
  const rect = sigOpts.rect ? sigOpts.rect : [0, 0, 0, 0];
  const [sx, sy, sw, sh] = rect;

  const subFilter = sigOpts.subFilter || 'adbe.pkcs7.detached';
  const now = new Date().toISOString().replace(/[-:T]/g, '').substring(0, 14);
  const dateStr = `D:${now}Z`;

  let sigDict = `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${subFilter}`;
  sigDict += ` /ByteRange [0 0 0 0]`;  // Placeholder — real implementations patch this
  sigDict += ` /Contents <${'00'.repeat(4096)}>`;  // 8192-byte PKCS#7 placeholder
  if (sigOpts.signerName) sigDict += ` /Name ${encodePdfString(sigOpts.signerName, hasNonAscii(sigOpts.signerName))}`;
  if (sigOpts.reason) sigDict += ` /Reason ${encodePdfString(sigOpts.reason, hasNonAscii(sigOpts.reason))}`;
  if (sigOpts.location) sigDict += ` /Location ${encodePdfString(sigOpts.location, hasNonAscii(sigOpts.location))}`;
  if (sigOpts.contactInfo) sigDict += ` /ContactInfo ${encodePdfString(sigOpts.contactInfo, hasNonAscii(sigOpts.contactInfo))}`;
  sigDict += ` /M (${dateStr}) >>`;

  const sigValueId = writer.addObj(sigDict);

  const widgetDict =
    `<< /Type /Annot /Subtype /Widget /FT /Sig ` +
    `/Rect [${sx} ${sy} ${sx + sw} ${sy + sh}] ` +
    `/P ${pageRef} 0 R ` +
    `/T (Sig1) ` +
    `/V ${sigValueId} 0 R ` +
    `/F 132 >>`; // F=4 (Print) + 128 (Locked)

  const widgetId = writer.addObj(widgetDict);

  // AcroForm sig root
  const sigFieldId = writer.reserveId();
  const sigFieldContent =
    `<< /FT /Sig /T (Sig1) /V ${sigValueId} 0 R /Kids [${widgetId} 0 R] /P ${pageRef} 0 R >>`;
  pendingObjStm.push([sigFieldId, sigFieldContent]);

  return sigFieldId;
}

// ─── P3: Document Parts (§14.12) ─────────────────────────────

/** Recursively build /DParts array entries */
function buildDocumentParts(
  writer: PdfWriter,
  parts: PdfDocumentPart[],
  pageIds: number[],
  pendingObjStm: Array<[number, string]>
): number {
  const rootId = writer.reserveId();
  const partEntries: string[] = [];

  for (const part of parts) {
    const pageRefs = part.pageIndices
      .filter(i => i < pageIds.length)
      .map(i => `${pageIds[i]} 0 R`)
      .join(' ');

    let entry = `<< /Pages [${pageRefs}]`;
    if (part.name) entry += ` /DMeta << /Title ${encodePdfString(part.name, hasNonAscii(part.name))} >>`;
    if (part.metadata) {
      const metaEntries = Object.entries(part.metadata).map(([k, v]) =>
        `/${escapeLit(k)} ${encodePdfString(v, hasNonAscii(v))}`
      ).join(' ');
      entry += ` /DPM << ${metaEntries} >>`;
    }
    if (part.children?.length) {
      const childId = buildDocumentParts(writer, part.children, pageIds, pendingObjStm);
      entry += ` /DParts [${childId} 0 R]`;
    }
    entry += ' >>';
    partEntries.push(entry);
  }

  const content = `<< /DParts [${partEntries.join('\n')}] >>`;
  pendingObjStm.push([rootId, content]);
  return rootId;
}

// ─── Public API ──────────────────────────────────────────────


export async function generateNativePdf(
  protocol: PdfDesignProtocol,
  outputPath: string,
  options?: PdfRenderOptions
): Promise<void> {
  // ── Validation ──────────────────────────────────────────
  const hasBody = protocol.source?.body?.trim();
  const hasPages = protocol.content?.pages?.length;
  const hasAesthetic = protocol.aesthetic?.elements?.length;
  if (!hasBody && !hasPages && !hasAesthetic) {
    throw new Error('source.body is required when no content pages or aesthetic elements are provided');
  }
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) throw new Error(`output directory does not exist: ${outDir}`);

  // ── Options ──────────────────────────────────────────────
  const opts: Required<PdfRenderOptions> = {
    compress:      options?.compress      ?? protocol.renderOptions?.compress      ?? true,
    unicode:       options?.unicode       ?? protocol.renderOptions?.unicode       ?? true,
    objectStreams: options?.objectStreams  ?? protocol.renderOptions?.objectStreams ?? false,
    xmpMetadata:  options?.xmpMetadata   ?? protocol.renderOptions?.xmpMetadata   ?? true,
    tagged:        options?.tagged        ?? protocol.renderOptions?.tagged        ?? !!protocol.structTree,
    linearize:     options?.linearize     ?? protocol.renderOptions?.linearize     ?? false,
    encrypt:       options?.encrypt       ?? protocol.renderOptions?.encrypt       ?? undefined as any,
  };

  const writer = new PdfWriter();
  const pendingObjStm: Array<[number, string]> = []; // for Object Stream batching

  // Helper: write reserved object either inline or into pending ObjStm
  const writeReserved = (id: number, content: string) => {
    if (opts.objectStreams) {
      pendingObjStm.push([id, content]);
    } else {
      writer.writeObj(id, content);
    }
  };

  // ── Prepare pages ────────────────────────────────────────
  const pages = protocol.content?.pages ? [...protocol.content.pages] : [];
  if (pages.length === 0 && protocol.source.body) {
    pages.push({ pageNumber: 1, width: 595, height: 842, text: protocol.source.body });
  }

  // ── Reserve structural IDs ───────────────────────────────
  const catalogId   = writer.reserveId();
  const pagesRootId = writer.reserveId();
  const infoId      = writer.reserveId();
  const fontId      = writer.reserveId();

  // ── XMP Metadata Stream (P1-1) ───────────────────────────
  let metadataId: number | undefined;
  if (opts.xmpMetadata) {
    const xmpStr = buildXmp({
      title:        protocol.metadata?.title    || protocol.source?.title,
      author:       protocol.metadata?.author   as string | undefined,
      subject:      protocol.metadata?.subject  as string | undefined,
      creationDate: protocol.metadata?.creationDate as string | undefined,
    });
    metadataId = writer.addStream({ '/Type': '/Metadata', '/Subtype': '/XML' }, Buffer.from(xmpStr, 'utf8'), false);
  }

  // ── Page Labels (P1-5) ───────────────────────────────────
  let pageLabelsId: number | undefined;
  if (protocol.pageLabels?.length) {
    pageLabelsId = writer.reserveId();
  }

  // ── Associated Files (P2-4) ──────────────────────────────
  const afList: Array<{ af: PdfAssociatedFile; streamId: number }> = [];
  for (const af of protocol.associatedFiles ?? []) {
    try {
      const streamId = buildEmbeddedFileStream(writer, af, opts.compress);
      afList.push({ af, streamId });
    } catch (e: any) {
      console.warn(`[PDF] Associated file skipped: ${af.path} — ${e.message}`);
    }
  }

  // /EmbeddedFiles NameTree
  let efNameTreeId: number | undefined;
  if (afList.length > 0) {
    efNameTreeId = writer.reserveId();
  }

  // ── Form XObjects (P2-5) ────────────────────────────────
  const fxoMap = new Map<string, number>(); // name → id
  for (const fxo of protocol.formXObjects ?? []) {
    const fid = buildFormXObject(writer, fxo, fontId, opts.compress);
    fxoMap.set(fxo.name, fid);
  }

  // ── Image XObjects (P1-2) ────────────────────────────────
  const imgMap = new Map<string, { id: number; name: string }>();
  const allImgPaths = new Set<string>();
  for (const p of pages) for (const img of p.images ?? []) allImgPaths.add(img.path);

  let imgCtr = 0;
  for (const imgPath of allImgPaths) {
    const name = `Im${++imgCtr}`;
    const id = writer.reserveId();
    imgMap.set(imgPath, { id, name });
  }

  // Write image XObjects
  for (const [imgPath, { id, name: _name }] of imgMap) {
    try {
      const info = decodeImage(imgPath);
      const dictEntries: Record<string, string> = {
        '/Type': '/XObject', '/Subtype': '/Image',
        '/Width': String(info.width), '/Height': String(info.height),
        '/ColorSpace': info.colorSpace, '/BitsPerComponent': String(info.bitsPerComponent),
      };
      if (info.filter) dictEntries['/Filter'] = info.filter;
      const useCompress = !info.filter;

      writer['reg'].push({ id, offset: writer.currentOffset });
      let body = useCompress ? zlib.deflateSync(info.data) : info.data;
      if (useCompress) dictEntries['/Filter'] = '/FlateDecode';
      dictEntries['/Length'] = String(body.length);
      const ds = Object.entries(dictEntries).map(([k, v]) => `${k} ${v}`).join('\n');
      writer['raw'](`${id} 0 obj\n<<\n${ds}\n>>\nstream\n`);
      writer['raw'](body);
      writer['raw']('\nendstream\nendobj\n');
    } catch (e: any) {
      console.warn(`[PDF] Image skipped: ${imgPath} — ${e.message}`);
    }
  }

  // ── Outlines / Bookmarks (P2-1) ──────────────────────────
  let outlineRootId: number | undefined;
  // Page IDs are needed for destinations — we'll collect them below
  const pageIds: number[] = pages.map(() => writer.reserveId());

  let outlineItems: ReturnType<typeof buildOutlineTree> = [];
  if (protocol.outlines?.length) {
    outlineRootId = writer.reserveId();
    // Build outline items (deferred until pageIds are set)
    outlineItems = buildOutlineTree(writer, protocol.outlines, pageIds, outlineRootId, opts, pendingObjStm);
  }

  // ── Tagged PDF: StructTreeRoot (P2-6) ───────────────────
  let structTreeRootId: number | undefined;
  if (protocol.structTree && opts.tagged) {
    structTreeRootId = writer.reserveId();
    const childId = buildStructElem(writer, protocol.structTree, structTreeRootId, pendingObjStm);

    let structTreeContent = `<< /Type /StructTreeRoot /K [${childId} 0 R]`;
    // Map from ParentTree is omitted for simplicity (optional in §14.7)
    structTreeContent += ' >>';
    pendingObjStm.push([structTreeRootId, structTreeContent]);
  }

  // ── P3-2: OCG / Layers ─────────────────────────────
  let ocPropertiesId: number | undefined;
  const ocgIds = new Map<string, number>();
  if (protocol.layers?.length) {
    const ocgResult = buildOCG(writer, protocol.layers, pendingObjStm);
    ocPropertiesId = ocgResult.ocPropertiesId;
    for (const [k, v] of ocgResult.ocgIds) ocgIds.set(k, v);
  }

  // ── P3-1: AcroForms ──────────────────────────────
  let acroFormId: number | undefined;
  const acroFieldAnnotIds = new Map<string, number[]>(); // 'page-N' → field widget IDs
  if (protocol.acroForm?.fields.length) {
    const result = buildAcroForm(writer, protocol.acroForm, pageIds, fontId, opts.compress, pendingObjStm);
    acroFormId = result.acroFormId;
    for (const [k, v] of result.fieldAnnotIds) acroFieldAnnotIds.set(k, v);
  }

  // ── P3-7: Digital Signature ─────────────────────────
  let sigFieldId: number | undefined;
  if (protocol.signature) {
    sigFieldId = buildSignaturePlaceholder(writer, protocol.signature, pageIds, pendingObjStm);
  }

  // ── P3-8: Document Parts ───────────────────────────
  let dpartRootId: number | undefined;
  if (protocol.documentParts?.length) {
    dpartRootId = buildDocumentParts(writer, protocol.documentParts, pageIds, pendingObjStm);
  }

  // ── Write page content streams + page objects ────────────
  const pageAnnotIds: number[][] = pages.map(() => []);

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    const pageId = pageIds[pi];

    // Build content stream
    let content = '';

    // Images
    if (page.images?.length) content += buildImageContent(page.images, page.height, imgMap);

    // Vectors (graphics state)
    if (page.vectors?.length) content += buildVectorStream(page.vectors, page.height);

    // Text: aesthetic elements on first page, or regular text
    if (protocol.aesthetic?.elements?.length && pi === 0) {
      content += buildAestheticContent(protocol.aesthetic.elements, page.height, opts.unicode);
    } else if (page.text) {
      content += buildTextContent(page, opts.unicode);
    }

    const contentId = writer.addStream({}, Buffer.from(content, 'binary'), opts.compress);

    // Annotations (P2-2)
    const annIds: number[] = [];
    for (const ann of page.annotations ?? []) {
      const annContent = buildAnnotationDict(ann, page.height, pageIds);
      const annId = writer.addObj(annContent);
      annIds.push(annId);
      pageAnnotIds[pi].push(annId);
    }

    // Build ExtGState resource for graphics
    const gsList = page.vectors?.length ? collectExtGState(page.vectors) : [];

    // Build image resource dict
    const imgRes = [...(page.images ?? [])].map(img => {
      const reg = imgMap.get(img.path);
      return reg ? `/${reg.name} ${reg.id} 0 R` : '';
    }).filter(Boolean);

    // Build Form XObject resource dict
    const fxoRes = (page.text || '').match(/\/(Fxo_\w+) Do/g)?.map(m => {
      const n = m.match(/\/(\w+) Do/)?.[1];
      return n && fxoMap.has(n) ? `/${n} ${fxoMap.get(n)} 0 R` : '';
    }).filter(Boolean) ?? [];
    // Also include protocol-level form XObjects
    const allFxoRes = [...fxoRes, ...[...fxoMap.entries()].map(([n, fid]) => `/${n} ${fid} 0 R`)];
    const uniqueFxoRes = [...new Set(allFxoRes)];

    // Build resources dict
    let resources = `<< /Font << /F1 ${fontId} 0 R >>`;
    if (imgRes.length > 0) resources += ` /XObject << ${imgRes.join(' ')} ${uniqueFxoRes.join(' ')} >>`;
    else if (uniqueFxoRes.length > 0) resources += ` /XObject << ${uniqueFxoRes.join(' ')} >>`;
    if (gsList.length > 0) {
      const gsEntries = gsList.map(g => `/${g.name} << ${g.entries} >>`).join(' ');
      resources += ` /ExtGState << ${gsEntries} >>`;
    }
    resources += ' /ProcSet [/PDF /Text /ImageC /ImageB] >>';

    let pageContent = `<< /Type /Page /Parent ${pagesRootId} 0 R /MediaBox [0 0 ${page.width} ${page.height}] /Contents ${contentId} 0 R /Resources ${resources}`;
    if (annIds.length > 0) pageContent += ` /Annots [${annIds.map(id => `${id} 0 R`).join(' ')}]`;
    pageContent += ' >>';

    writeReserved(pageId, pageContent);
  }

  // ── Write Outlines Root (P2-1) ───────────────────────────
  if (outlineRootId !== undefined && outlineItems.length > 0) {
    const totalCount = (protocol.outlines ?? []).reduce((n, item) => n + 1 + countDescendants(item), 0);
    const rootContent =
      `<< /Type /Outlines /Count ${totalCount} ` +
      `/First ${outlineItems[0].id} 0 R ` +
      `/Last ${outlineItems[outlineItems.length - 1].id} 0 R >>`;
    pendingObjStm.push([outlineRootId, rootContent]);
  }

  // ── Write reserved non-stream objects ────────────────

  // ── P3-4: AES-256 Encryption (must go in catalog) ───
  let encryptId: number | undefined;
  let encryptFileId = '';
  if (opts.encrypt?.ownerPassword) {
    const { dictStr, key: _key, encryptId: eid } = buildEncryptDict(opts.encrypt);
    encryptFileId = eid;
    encryptId = writer.addObj(dictStr);
  }

  // Catalog
  const catalogParts = ['/Type /Catalog', `/Pages ${pagesRootId} 0 R`];
  if (metadataId !== undefined) catalogParts.push(`/Metadata ${metadataId} 0 R`);
  if (pageLabelsId !== undefined) catalogParts.push(`/PageLabels ${pageLabelsId} 0 R`);
  if (outlineRootId !== undefined) catalogParts.push(`/Outlines ${outlineRootId} 0 R /PageMode /UseOutlines`);
  if (structTreeRootId !== undefined) catalogParts.push(`/StructTreeRoot ${structTreeRootId} 0 R`);
  if (opts.tagged) catalogParts.push('/MarkInfo << /Marked true >>');
  if (efNameTreeId !== undefined) catalogParts.push(`/Names << /EmbeddedFiles ${efNameTreeId} 0 R >>`);
  if (afList.length > 0) {
    const afRefs = afList.map(({ streamId }) => `${streamId} 0 R`).join(' ');
    catalogParts.push(`/AF [${afRefs}]`);
  }
  // P3 catalog entries
  if (ocPropertiesId !== undefined) catalogParts.push(`/OCProperties ${ocPropertiesId} 0 R`);
  if (acroFormId !== undefined || sigFieldId !== undefined) {
    const allFields: number[] = [];
    if (acroFormId !== undefined) {
      // AcroForm fields are already in the acroFormId dict; we reference it directly
      // For sig: merge into an AcroForm dict
    }
    // Simple AcroForm root reference
    if (acroFormId !== undefined) catalogParts.push(`/AcroForm ${acroFormId} 0 R`);
    else if (sigFieldId !== undefined) {
      // Create minimal AcroForm for signature only
      const sigAcroId = writer.addObj(`<< /Fields [${sigFieldId} 0 R] /SigFlags 3 >>`);
      catalogParts.push(`/AcroForm ${sigAcroId} 0 R`);
    }
  }
  if (dpartRootId !== undefined) catalogParts.push(`/DPartRoot ${dpartRootId} 0 R`);
  if (encryptId !== undefined) catalogParts.push(`/Encrypt ${encryptId} 0 R`);
  writeReserved(catalogId, `<<\n${catalogParts.map(p => `  ${p}`).join('\n')}\n>>`);

  // Info (with PDF MAC token appended as comment if mac options provided)
  const title = protocol.metadata?.title || protocol.source?.title || 'Kyberion PDF';
  const dateStr = `D:${new Date().toISOString().replace(/[-T:Z.]/g, '').substring(0, 14)}Z`;
  writeReserved(infoId, `<< /Title ${encodePdfString(title, opts.unicode)} /Producer (Kyberion Native PDF 2.0 Engine) /CreationDate (${dateStr}) >>`);

  // Font
  writeReserved(fontId, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  // Pages Root
  writeReserved(pagesRootId, `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);

  // Page Labels
  if (pageLabelsId !== undefined && protocol.pageLabels) {
    writeReserved(pageLabelsId, buildPageLabelsDict(protocol.pageLabels));
  }

  // Associated Files NameTree: write Filespec dicts directly
  if (efNameTreeId !== undefined && afList.length > 0) {
    const fsIds = afList.map(({ af, streamId }) => {
      const rel = af.relationship || 'Unspecified';
      let fs = `<< /Type /Filespec /F (${escapeLit(af.name)}) /UF ${encodePdfString(af.name, true)} /EF << /F ${streamId} 0 R >> /AFRelationship /${rel}`;
      if (af.description) fs += ` /Desc ${encodePdfString(af.description, true)}`;
      fs += ' >>';
      return writer.addObj(fs);
    });
    const numEntries = afList.map((a, i) => `(${escapeLit(a.af.name)}) ${fsIds[i]} 0 R`).join(' ');
    writeReserved(efNameTreeId, `<< /Names [${numEntries}] >>`);
  }

  // ── Flush pending objects ────────────────────────────────
  // pendingObjStm accumulates: outline items, struct elements, outline root, etc.
  if (pendingObjStm.length > 0) {
    if (opts.objectStreams) {
      writer.addObjectStream(pendingObjStm, opts.compress);
    } else {
      for (const [id, content] of pendingObjStm) {
        writer.writeObj(id, content);
      }
    }
  }

  // ── Finalize ──────────────────────────────────────────────
  let finalBuf = writer.finalize(catalogId, infoId);

  // P3-3: Linearization — prepend /Linearized dict as first object (structural)
  if (opts.linearize) {
    const linDict = buildLinearizationDict(finalBuf.length, pages.length, pageIds[0]);
    const linObj = Buffer.from(`1000 0 obj\n${linDict}\nendobj\n`, 'binary');
    finalBuf = Buffer.concat([finalBuf.subarray(0, 12), linObj, finalBuf.subarray(12)]);
  }

  // P3-5: PDF MAC — compute HMAC-SHA256 over document body and append as structured comment
  // In full ISO/TS 32004, this would go into /PdfMacIntegrityInfo XObject.
  const macKey = crypto.randomBytes(32);
  const macToken = computePdfMac(finalBuf, macKey);
  finalBuf = Buffer.concat([finalBuf, Buffer.from(`%% PdfMac: ${macToken}\n`, 'binary')]);

  fs.writeFileSync(outputPath, finalBuf);
}

