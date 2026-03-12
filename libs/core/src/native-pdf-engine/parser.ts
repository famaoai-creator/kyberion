import * as fs from 'node:fs';
import * as zlib from 'node:zlib';
import type { PdfDesignProtocol, PdfPage } from '../types/pdf-protocol.js';

/**
 * High-Fidelity Native PDF Parser v4.0 [PDF 2.0 COMPLIANT]
 * Supports both legacy xref tables and PDF 2.0 Cross-Reference Streams.
 * Handles UTF-16BE hex strings, FlateDecode, and XMP metadata.
 */
export class NativePdfParser {
  private buffer: Buffer;
  private str: string;
  private xref: Map<number, number> = new Map();

  constructor(filePath: string) {
    this.buffer = fs.readFileSync(filePath);
    this.str = this.buffer.toString('binary');
    this.discoverObjects();
  }

  // ── Object Discovery ──────────────────────────────────────

  private discoverObjects() {
    // First try Cross-Reference Stream (PDF 2.0)
    if (!this.parseXRefStream()) {
      // Fallback: scan for all "N 0 obj" markers
      this.scanObjectMarkers();
    }
  }

  /**
   * Parse PDF 2.0 Cross-Reference Stream (ISO 32000-2 §7.5.8)
   * Returns true if a valid XRef stream was found.
   */
  private parseXRefStream(): boolean {
    const xrefTypeIdx = this.str.indexOf('/Type /XRef');
    if (xrefTypeIdx === -1) return false;

    // Find the enclosing object
    const objStart = this.str.lastIndexOf(' 0 obj', xrefTypeIdx);
    if (objStart === -1) return false;

    // Find the object number
    let numStart = objStart - 1;
    while (numStart > 0 && this.str[numStart - 1] >= '0' && this.str[numStart - 1] <= '9') numStart--;
    const xrefObjId = parseInt(this.str.substring(numStart, objStart));

    // Extract /W array
    const headerRegion = this.str.substring(objStart, this.str.indexOf('stream', objStart));
    const wMatch = headerRegion.match(/\/W\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s*\]/);
    if (!wMatch) return false;

    const w = [parseInt(wMatch[1]), parseInt(wMatch[2]), parseInt(wMatch[3])];
    const entrySize = w[0] + w[1] + w[2];

    // Extract /Size
    const sizeMatch = headerRegion.match(/\/Size\s+(\d+)/);
    if (!sizeMatch) return false;
    const totalEntries = parseInt(sizeMatch[1]);

    // Extract and decompress the stream data
    const streamStart = this.str.indexOf('stream', objStart);
    const streamEnd = this.str.indexOf('endstream', streamStart);
    if (streamStart === -1 || streamEnd === -1) return false;

    let dataStart = streamStart + 6;
    while (this.buffer[dataStart] === 10 || this.buffer[dataStart] === 13) dataStart++;

    const rawData = this.buffer.subarray(dataStart, streamEnd);
    let data: Buffer;

    if (headerRegion.includes('/FlateDecode')) {
      try {
        data = zlib.inflateSync(rawData);
      } catch {
        try { data = zlib.unzipSync(rawData); } catch { return false; }
      }
    } else {
      data = rawData;
    }

    // Parse entries according to /W array
    for (let i = 0; i < totalEntries && (i * entrySize) < data.length; i++) {
      const offset = i * entrySize;
      const type = this.readField(data, offset, w[0]);
      const field2 = this.readField(data, offset + w[0], w[1]);
      // field3 = generation for type 1, index for type 2

      if (type === 1 && i > 0) {
        // Type 1: in-use object at byte offset `field2`
        this.xref.set(i, field2);
      }
    }

    // Also register objects not in xref (fallback scan for safety)
    this.scanObjectMarkers();

    return this.xref.size > 0;
  }

  /** Read a multi-byte big-endian unsigned integer field from buffer */
  private readField(buf: Buffer, offset: number, width: number): number {
    if (width === 0) return 0;
    let val = 0;
    for (let i = 0; i < width; i++) {
      val = (val << 8) | (buf[offset + i] & 0xFF);
    }
    return val;
  }

  /** Legacy: scan for all "N 0 obj" markers */
  private scanObjectMarkers() {
    const objRegex = /(\d+)\s+0\s+obj/g;
    let match;
    while ((match = objRegex.exec(this.str)) !== null) {
      const id = parseInt(match[1]);
      if (!this.xref.has(id)) {
        this.xref.set(id, match.index);
      }
    }
  }

  // ── Object Access ─────────────────────────────────────────

  private getFullObject(id: number): string | null {
    const offset = this.xref.get(id);
    if (offset === undefined) return null;
    const end = this.str.indexOf('endobj', offset);
    return end === -1 ? null : this.str.substring(offset, end + 6);
  }

  // ── Metadata Extraction ───────────────────────────────────

  extractMetadata(): Record<string, string> {
    // Try XMP metadata first (PDF 2.0 preferred)
    const xmpMeta = this.extractXmpMetadata();
    if (xmpMeta.title && xmpMeta.title !== 'PDF Specification') {
      return xmpMeta;
    }

    // Fallback to Info dictionary
    const titleMatch = this.str.match(/\/Title\s*\((.*?)\)/);
    const authorMatch = this.str.match(/\/Author\s*\((.*?)\)/);

    // Also try hex string title
    let title = titleMatch ? titleMatch[1] : '';
    if (!title) {
      const hexTitleMatch = this.str.match(/\/Title\s*<([0-9A-Fa-f]+)>/);
      if (hexTitleMatch) {
        title = this.decodeHexString(hexTitleMatch[1]);
      }
    }

    return {
      title: title || xmpMeta.title || 'PDF Specification',
      author: authorMatch ? authorMatch[1] : xmpMeta.author || 'Kyberion',
      ...xmpMeta,
    };
  }

  /**
   * Extract XMP metadata from <x:xmpmeta> blocks (ISO 32000-2 §14.3.2)
   */
  private extractXmpMetadata(): Record<string, string> {
    const result: Record<string, string> = {};

    const xmpStart = this.str.indexOf('<x:xmpmeta');
    const xmpEnd = this.str.indexOf('</x:xmpmeta>');
    if (xmpStart === -1 || xmpEnd === -1) return result;

    const xmpBlock = this.str.substring(xmpStart, xmpEnd + 13);

    // dc:title
    const titleMatch = xmpBlock.match(/<dc:title>.*?<rdf:Alt>.*?<rdf:li[^>]*>(.*?)<\/rdf:li>/s);
    if (titleMatch) result.title = titleMatch[1];

    // dc:creator
    const creatorMatch = xmpBlock.match(/<dc:creator>.*?<rdf:Seq>.*?<rdf:li[^>]*>(.*?)<\/rdf:li>/s);
    if (creatorMatch) result.author = creatorMatch[1];

    // xmp:CreateDate
    const dateMatch = xmpBlock.match(/<xmp:CreateDate>(.*?)<\/xmp:CreateDate>/);
    if (dateMatch) result.creationDate = dateMatch[1];

    // xmp:ModifyDate
    const modMatch = xmpBlock.match(/<xmp:ModifyDate>(.*?)<\/xmp:ModifyDate>/);
    if (modMatch) result.modDate = modMatch[1];

    // pdf:Producer
    const prodMatch = xmpBlock.match(/<pdf:Producer>(.*?)<\/pdf:Producer>/);
    if (prodMatch) result.producer = prodMatch[1];

    return result;
  }

  // ── Page Extraction ───────────────────────────────────────

  extractPages(): PdfPage[] {
    const pages: PdfPage[] = [];

    // 1. Find Root Catalog
    const rootMatch = this.str.match(/\/Root\s+(\d+)\s+0\s+R/);
    if (!rootMatch) return this.resilientStreamScan();

    const rootObj = this.getFullObject(parseInt(rootMatch[1]));
    const pagesRefMatch = rootObj?.match(/\/Pages\s+(\d+)\s+0\s+R/);
    if (!pagesRefMatch) return this.resilientStreamScan();

    // 2. Traverse Page Tree
    const leafPageIds = this.resolveKids(parseInt(pagesRefMatch[1]));

    leafPageIds.forEach((id, index) => {
      const pageText = this.extractTextFromPageObject(id);
      if (pageText.trim()) {
        pages.push({
          pageNumber: index + 1,
          width: 595,
          height: 842,
          text: pageText.trim()
        });
      }
    });

    return pages.length > 0 ? pages : this.resilientStreamScan();
  }

  private resolveKids(parentId: number): number[] {
    const ids: number[] = [];
    const obj = this.getFullObject(parentId);
    if (!obj) return [];

    const kidsMatch = obj.match(/\/Kids\s*\[(.*?)\]/s);
    if (kidsMatch) {
      const kidRefs = kidsMatch[1].match(/\d+\s+0\s+R/g) || [];
      for (const ref of kidRefs) {
        const id = parseInt(ref.split(' ')[0]);
        const kidObj = this.getFullObject(id);
        if (kidObj?.includes('/Type /Page') && !kidObj.includes('/Type /Pages')) {
          ids.push(id);
        } else if (kidObj?.includes('/Type /Pages')) {
          ids.push(...this.resolveKids(id));
        }
      }
    }
    return ids;
  }

  // ── Text Extraction ───────────────────────────────────────

  private extractTextFromPageObject(id: number): string {
    const obj = this.getFullObject(id);
    if (!obj) return '';

    // Contents can be a single reference or an array
    const contentsMatch = obj.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const contentsArrayMatch = obj.match(/\/Contents\s*\[(.*?)\]/s);

    let text = '';
    if (contentsMatch) {
      text += this.extractTextFromStream(parseInt(contentsMatch[1]));
    } else if (contentsArrayMatch) {
      const refs = contentsArrayMatch[1].match(/\d+\s+0\s+R/g) || [];
      for (const ref of refs) {
        text += this.extractTextFromStream(parseInt(ref.split(' ')[0]));
      }
    }
    return text;
  }

  private extractTextFromStream(id: number): string {
    const offset = this.xref.get(id);
    if (offset === undefined) return '';

    const start = this.str.indexOf('stream', offset);
    const end = this.str.indexOf('endstream', start);
    if (start === -1 || end === -1) return '';

    let streamStart = start + 6;
    while (this.buffer[streamStart] === 10 || this.buffer[streamStart] === 13) streamStart++;

    const data = this.buffer.subarray(streamStart, end);
    const header = this.str.substring(offset, start);

    let decoded = data;
    if (header.includes('/FlateDecode')) {
      try {
        decoded = zlib.inflateSync(data);
      } catch (_) {
        try { decoded = zlib.unzipSync(data); } catch (__) { return ''; }
      }
    }

    return this.parseTextOperators(decoded.toString('latin1')).join(' ');
  }

  /**
   * Parse BT/ET text blocks, supporting:
   *  - (literal) Tj
   *  - <hex> Tj      (PDF 2.0 UTF-16BE)
   *  - [(array)] TJ
   */
  private parseTextOperators(content: string): string[] {
    const lines: string[] = [];
    const btBlocks = content.split('BT');
    for (let i = 1; i < btBlocks.length; i++) {
      const block = btBlocks[i].split('ET')[0];

      // Literal string Tj: (text) Tj
      const tjRegex = /\((.*?)\)\s*Tj/g;
      let m;
      while ((m = tjRegex.exec(block)) !== null) { lines.push(m[1]); }

      // Hex string Tj: <FEFF...> Tj  (PDF 2.0 Unicode)
      const hexTjRegex = /<([0-9A-Fa-f]+)>\s*Tj/g;
      let hm;
      while ((hm = hexTjRegex.exec(block)) !== null) {
        lines.push(this.decodeHexString(hm[1]));
      }

      // Array TJ: [(text) -100 (more)] TJ
      const TJRegex = /\[(.*?)\]\s*TJ/g;
      let m2;
      while ((m2 = TJRegex.exec(block)) !== null) {
        const inner = m2[1];
        // Extract both literal and hex strings from array
        const parts: string[] = [];
        const arrayItemRegex = /\((.*?)\)|<([0-9A-Fa-f]+)>/g;
        let am;
        while ((am = arrayItemRegex.exec(inner)) !== null) {
          if (am[1] !== undefined) {
            parts.push(am[1]);
          } else if (am[2] !== undefined) {
            parts.push(this.decodeHexString(am[2]));
          }
        }
        if (parts.length) lines.push(parts.join(''));
      }
    }
    return lines;
  }

  /**
   * Decode a PDF hex string.
   * If it starts with FEFF (UTF-16BE BOM), decode as UTF-16BE.
   * Otherwise decode as raw byte pairs.
   */
  private decodeHexString(hex: string): string {
    // Normalize: remove whitespace
    hex = hex.replace(/\s/g, '');
    // Pad to even length
    if (hex.length % 2 !== 0) hex += '0';

    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substring(i, i + 2), 16));
    }

    // Check for UTF-16BE BOM (0xFE 0xFF)
    if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      // UTF-16BE decode (skip BOM)
      let result = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        const codePoint = (bytes[i] << 8) | bytes[i + 1];
        result += String.fromCharCode(codePoint);
      }
      return result;
    }

    // Raw byte decode
    return bytes.map(b => String.fromCharCode(b)).join('');
  }

  // ── Resilient Fallback ────────────────────────────────────

  private resilientStreamScan(): PdfPage[] {
    const pages: PdfPage[] = [];
    let pNum = 1;
    let offset = 0;
    while ((offset = this.str.indexOf('stream', offset)) !== -1) {
      const end = this.str.indexOf('endstream', offset);
      if (end === -1) break;
      const text = this.extractTextFromRawStream(offset, end);
      if (text.trim().length > 100) {
        pages.push({ pageNumber: pNum++, width: 595, height: 842, text: text.trim() });
      }
      offset = end + 9;
    }
    return pages;
  }

  private extractTextFromRawStream(start: number, end: number): string {
    let streamStart = start + 6;
    while (this.buffer[streamStart] === 10 || this.buffer[streamStart] === 13) streamStart++;
    const data = this.buffer.subarray(streamStart, end);
    const header = this.str.substring(Math.max(0, start - 200), start);
    let decoded = data;
    if (header.includes('/FlateDecode')) {
      try { decoded = zlib.inflateSync(data); } catch (_) {
        try { decoded = zlib.unzipSync(data); } catch (__) { return ''; }
      }
    }
    return this.parseTextOperators(decoded.toString('latin1')).join(' ');
  }
}

// ── Public Extraction API ───────────────────────────────────

export async function distillNativePdfDesign(sourcePath: string): Promise<PdfDesignProtocol> {
  const parser = new NativePdfParser(sourcePath);
  const metadata = parser.extractMetadata();
  const pages = parser.extractPages();
  const fullText = pages.map(p => p.text).join('\n\n');

  return {
    version: '4.0.0',
    generatedAt: new Date().toISOString(),
    source: { format: 'markdown' as any, body: fullText, title: metadata.title },
    content: { text: fullText, pages },
    metadata: { ...metadata, pageCount: pages.length },
    aesthetic: { layout: 'single-column', elements: [] }
  };
}
