import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pathResolver } from '../../path-resolver.js';
import { safeMkdir, safeReadFile, safeWriteFile } from '../../secure-io.js';
import type { PdfDesignProtocol, PdfLayoutElement, PdfPage, PdfImageElement } from '../types/pdf-protocol.js';

/**
 * High-Fidelity Native PDF Parser v4.0 [PDF 2.0 COMPLIANT]
 * Supports both legacy xref tables and PDF 2.0 Cross-Reference Streams.
 * Handles UTF-16BE hex strings, FlateDecode, and XMP metadata.
 */
export class NativePdfParser {
  private buffer: Buffer;
  private str: string;
  private xref: Map<number, number> = new Map();
  private compressedXref: Map<number, { objectStreamId: number; objectIndex: number }> = new Map();
  private objectStreamCache: Map<number, Map<number, string>> = new Map();
  private objectStreamIds: number[] = [];
  private fontUnicodeCache: Map<number, Map<string, string> | null> = new Map();
  private imagePathCache: Map<number, string | null> = new Map();

  constructor(filePath: string) {
    this.buffer = safeReadFile(filePath, { encoding: null }) as Buffer;
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
      const field3 = this.readField(data, offset + w[0] + w[1], w[2]);

      if (type === 1 && i > 0) {
        // Type 1: in-use object at byte offset `field2`
        this.xref.set(i, field2);
      } else if (type === 2 && i > 0) {
        // Type 2: object stored inside an object stream
        this.compressedXref.set(i, { objectStreamId: field2, objectIndex: field3 });
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

    const ids: number[] = [];
    for (const [id, offset] of this.xref.entries()) {
      const end = this.str.indexOf('endobj', offset);
      if (end === -1) continue;
      const body = this.str.substring(offset, Math.min(end + 6, offset + 1200));
      if (body.includes('/Type/ObjStm') || body.includes('/Type /ObjStm')) {
        ids.push(id);
      }
    }
    this.objectStreamIds = ids;
  }

  // ── Object Access ─────────────────────────────────────────

  private getFullObject(id: number): string | null {
    const offset = this.xref.get(id);
    if (offset === undefined) {
      const compressed = this.compressedXref.get(id);
      if (compressed) return this.getCompressedObject(id, compressed.objectStreamId);
      return this.searchObjectStreamsForObject(id);
    }
    const end = this.str.indexOf('endobj', offset);
    return end === -1 ? null : this.str.substring(offset, end + 6);
  }

  private searchObjectStreamsForObject(id: number): string | null {
    for (const objectStreamId of this.objectStreamIds) {
      const found = this.getCompressedObject(id, objectStreamId);
      if (found) return found;
    }
    return null;
  }

  private getCompressedObject(id: number, objectStreamId: number): string | null {
    let streamMap = this.objectStreamCache.get(objectStreamId);
    if (!streamMap) {
      streamMap = this.parseObjectStream(objectStreamId);
      this.objectStreamCache.set(objectStreamId, streamMap);
    }
    const body = streamMap.get(id);
    return body ? `${id} 0 obj\n${body}\nendobj` : null;
  }

  private parseObjectStream(objectStreamId: number): Map<number, string> {
    const parsed = new Map<number, string>();
    const offset = this.xref.get(objectStreamId);
    if (offset === undefined) return parsed;

    const start = this.str.indexOf('stream', offset);
    const end = this.str.indexOf('endstream', start);
    if (start === -1 || end === -1) return parsed;

    const objectHeader = this.str.substring(offset, start);
    const firstMatch = objectHeader.match(/\/First\s+(\d+)/);
    const countMatch = objectHeader.match(/\/N\s+(\d+)/);
    if (!firstMatch || !countMatch) return parsed;

    let streamStart = start + 6;
    while (this.buffer[streamStart] === 10 || this.buffer[streamStart] === 13) streamStart++;
    const rawData = this.buffer.subarray(streamStart, end);

    let decoded = rawData;
    if (objectHeader.includes('/FlateDecode')) {
      try {
        decoded = zlib.inflateSync(rawData);
      } catch {
        try {
          decoded = zlib.unzipSync(rawData);
        } catch {
          return parsed;
        }
      }
    }

    const decodedText = decoded.toString('latin1');
    const first = parseInt(firstMatch[1]);
    const count = parseInt(countMatch[1]);
    const headerText = decodedText.slice(0, first).trim();
    const contentText = decodedText.slice(first);
    const headerParts = headerText.split(/\s+/);
    const entries: Array<{ objectId: number; offset: number }> = [];

    for (let i = 0; i < count * 2 && i + 1 < headerParts.length; i += 2) {
      const objectId = parseInt(headerParts[i]);
      const relativeOffset = parseInt(headerParts[i + 1]);
      if (!Number.isNaN(objectId) && !Number.isNaN(relativeOffset)) {
        entries.push({ objectId, offset: relativeOffset });
      }
    }

    for (let i = 0; i < entries.length; i++) {
      const current = entries[i];
      const nextOffset = i + 1 < entries.length ? entries[i + 1].offset : contentText.length;
      const body = contentText.slice(current.offset, nextOffset).trim();
      if (body) parsed.set(current.objectId, body);
    }

    return parsed;
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
    let leafPageIds = this.resolveKids(parseInt(pagesRefMatch[1]));
    if (leafPageIds.length === 0) {
      leafPageIds = this.scanLeafPageIdsDirect();
    }

    leafPageIds.forEach((id, index) => {
      const page = this.extractPageContent(id, index + 1);
      if (page.text.trim() || page.elements?.length || page.images?.length) {
        pages.push(page);
      }
    });

    return pages.length > 0 ? pages : this.resilientStreamScan();
  }

  private scanLeafPageIdsDirect(): number[] {
    const ids: number[] = [];
    const objRegex = /(\d+)\s+0\s+obj([\s\S]*?)endobj/g;
    let match: RegExpExecArray | null;

    while ((match = objRegex.exec(this.str)) !== null) {
      const id = parseInt(match[1]);
      const body = match[2];
      if (body.includes('/Type/Page') && !body.includes('/Type/Pages')) {
        ids.push(id);
      }
    }

    return ids.sort((a, b) => a - b);
  }

  private extractPageContent(id: number, pageNumber: number): PdfPage {
    const obj = this.getFullObject(id) || '';
    const { width, height } = this.extractPageGeometry(obj);
    const fontResources = this.extractFontResources(obj);
    const imageResources = this.extractImageResources(obj);
    const extGStateResources = this.extractExtGStateResources(obj);
    const refs = this.extractContentRefs(obj);
    const elements: any[] = [];
    const images: PdfImageElement[] = [];
    const textParts: string[] = [];

    for (const ref of refs) {
      const decoded = this.decodeStream(ref);
      if (!decoded) continue;
      elements.push(...this.extractGraphicElements(decoded, height, extGStateResources));
      const streamElements = this.extractPositionedText(decoded, height, fontResources);
      elements.push(...streamElements);
      images.push(...this.extractPlacedImages(decoded, height, imageResources));
      const streamText = this.parseTextOperators(decoded).join(' ').trim();
      if (streamText) textParts.push(streamText);
    }

    const mergedText = textParts.join(' ').replace(/\s+/g, ' ').trim();
    return {
      pageNumber,
      width,
      height,
      text: mergedText,
      elements,
      images: images.length > 0 ? images : undefined,
    };
  }

  private extractPageGeometry(obj: string): { width: number; height: number } {
    const mediaBoxMatch = obj.match(/\/MediaBox\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/);
    if (!mediaBoxMatch) return { width: 595, height: 842 };
    const x0 = parseFloat(mediaBoxMatch[1]);
    const y0 = parseFloat(mediaBoxMatch[2]);
    const x1 = parseFloat(mediaBoxMatch[3]);
    const y1 = parseFloat(mediaBoxMatch[4]);
    return {
      width: Math.max(1, x1 - x0),
      height: Math.max(1, y1 - y0),
    };
  }

  private extractContentRefs(obj: string): number[] {
    const refs: number[] = [];
    const contentsMatch = obj.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const contentsArrayMatch = obj.match(/\/Contents\s*\[(.*?)\]/s);

    if (contentsMatch) {
      refs.push(parseInt(contentsMatch[1]));
    } else if (contentsArrayMatch) {
      const arrayRefs = contentsArrayMatch[1].match(/\d+\s+0\s+R/g) || [];
      for (const ref of arrayRefs) refs.push(parseInt(ref.split(' ')[0]));
    }
    return refs;
  }

  private extractFontResources(obj: string): Map<string, number> {
    const resources = new Map<string, number>();
    // Try inline Font dict first
    let fontSection = obj.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (!fontSection) {
      // Try indirect Resources reference: /Resources N 0 R
      const resRef = obj.match(/\/Resources\s+(\d+)\s+0\s+R/);
      if (resRef) {
        const resObj = this.getFullObject(parseInt(resRef[1]));
        if (resObj) {
          fontSection = resObj.match(/\/Font\s*<<([\s\S]*?)>>/);
        }
      }
    }
    if (!fontSection) return resources;
    const fontRegex = /\/([A-Za-z0-9_.-]+)\s+(\d+)\s+0\s+R/g;
    let match: RegExpExecArray | null;
    while ((match = fontRegex.exec(fontSection[1])) !== null) {
      resources.set(match[1], parseInt(match[2]));
    }
    return resources;
  }

  private extractImageResources(obj: string): Map<string, number> {
    const resources = new Map<string, number>();
    let xObjectSection = obj.match(/\/XObject\s*<<([\s\S]*?)>>/);
    if (!xObjectSection) {
      const resRef = obj.match(/\/Resources\s+(\d+)\s+0\s+R/);
      if (resRef) {
        const resObj = this.getFullObject(parseInt(resRef[1], 10));
        if (resObj) {
          xObjectSection = resObj.match(/\/XObject\s*<<([\s\S]*?)>>/);
        }
      }
    }
    if (!xObjectSection) return resources;
    const imageRegex = /\/([A-Za-z0-9_.-]+)\s+(\d+)\s+0\s+R/g;
    let match: RegExpExecArray | null;
    while ((match = imageRegex.exec(xObjectSection[1])) !== null) {
      const objectId = parseInt(match[2], 10);
      const imageObj = this.getFullObject(objectId);
      if (imageObj && /\/Subtype\s*\/Image\b/.test(imageObj)) {
        resources.set(match[1], objectId);
      }
    }
    return resources;
  }

  private extractExtGStateResources(obj: string): Map<string, number> {
    const resources = new Map<string, number>();
    let extGStateSection = obj.match(/\/ExtGState\s*<<([\s\S]*?)>>/);
    if (!extGStateSection) {
      const resRef = obj.match(/\/Resources\s+(\d+)\s+0\s+R/);
      if (resRef) {
        const resObj = this.getFullObject(parseInt(resRef[1], 10));
        if (resObj) {
          extGStateSection = resObj.match(/\/ExtGState\s*<<([\s\S]*?)>>/);
        }
      }
    }
    if (!extGStateSection) return resources;
    const gsRegex = /\/([A-Za-z0-9_.-]+)\s+(\d+)\s+0\s+R/g;
    let match: RegExpExecArray | null;
    while ((match = gsRegex.exec(extGStateSection[1])) !== null) {
      resources.set(match[1], parseInt(match[2], 10));
    }
    return resources;
  }

  private extractGraphicElements(
    content: string,
    pageHeight: number,
    extGStateResources: Map<string, number>,
  ): any[] {
    type ColorState = { r: number; g: number; b: number };
    const elements: any[] = [];
    const rgbToHex = (color: ColorState) => {
      const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value * 255))).toString(16).padStart(2, '0').toUpperCase();
      return `${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
    };
    const isWhite = (color: ColorState) => color.r > 0.95 && color.g > 0.95 && color.b > 0.95;
    const isBlack = (color: ColorState) => color.r < 0.05 && color.g < 0.05 && color.b < 0.05;

    let fillColor: ColorState = { r: 0, g: 0, b: 0 };
    let strokeColor: ColorState = { r: 0, g: 0, b: 0 };
    let lineWidth = 1;
    let fillOpacity = 1;
    let strokeOpacity = 1;

    const applyExtGState = (name: string) => {
      const objectId = extGStateResources.get(name);
      if (!objectId) return;
      const obj = this.getFullObject(objectId) || '';
      const ca = obj.match(/\/ca\s+([\d.]+)/);
      const CA = obj.match(/\/CA\s+([\d.]+)/);
      if (ca) fillOpacity = parseFloat(ca[1]) || fillOpacity;
      if (CA) strokeOpacity = parseFloat(CA[1]) || strokeOpacity;
    };

    const clipRegex = /([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+re\s+W\*?\s+n/g;
    let clipMatch: RegExpExecArray | null;
    while ((clipMatch = clipRegex.exec(content)) !== null) {
      const x = parseFloat(clipMatch[1]);
      const y = parseFloat(clipMatch[2]);
      const w = Math.abs(parseFloat(clipMatch[3]));
      const h = Math.abs(parseFloat(clipMatch[4]));
      if (w < 5 || h < 5) continue;
      if (w > pageHeight * 0.9 && h > pageHeight * 0.9) continue;
      elements.push({
        type: 'clip',
        x,
        y: pageHeight - y - h,
        width: w,
        height: h,
        text: '',
        fontSize: 0,
        fontName: '',
      });
    }

    const opRegex = /([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+rg|([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+RG|([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+sc\b|([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+SC\b|([\d.\-]+)\s+g(?:\s|$)|([\d.\-]+)\s+G(?:\s|$)|([\d.\-]+)\s+w(?:\s|$)|\/([A-Za-z0-9_.-]+)\s+gs(?:\s|$)|([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+re\b|\bf\*?\b|\bS\b|\bB\*?\b/g;
    let match: RegExpExecArray | null;
    let pendingRect: { x: number; y: number; w: number; h: number } | null = null;
    while ((match = opRegex.exec(content)) !== null) {
      const token = match[0].trim();
      if (match[1] !== undefined) {
        fillColor = { r: parseFloat(match[1]), g: parseFloat(match[2]), b: parseFloat(match[3]) };
        continue;
      }
      if (match[4] !== undefined) {
        strokeColor = { r: parseFloat(match[4]), g: parseFloat(match[5]), b: parseFloat(match[6]) };
        continue;
      }
      if (match[7] !== undefined) {
        fillColor = { r: parseFloat(match[7]), g: parseFloat(match[8]), b: parseFloat(match[9]) };
        continue;
      }
      if (match[10] !== undefined) {
        strokeColor = { r: parseFloat(match[10]), g: parseFloat(match[11]), b: parseFloat(match[12]) };
        continue;
      }
      if (match[13] !== undefined) {
        const gray = parseFloat(match[13]);
        fillColor = { r: gray, g: gray, b: gray };
        continue;
      }
      if (match[14] !== undefined) {
        const gray = parseFloat(match[14]);
        strokeColor = { r: gray, g: gray, b: gray };
        continue;
      }
      if (match[15] !== undefined) {
        lineWidth = parseFloat(match[15]) || lineWidth;
        continue;
      }
      if (match[16] !== undefined) {
        applyExtGState(match[16]);
        continue;
      }
      if (match[17] !== undefined) {
        const x = parseFloat(match[17]);
        const y = parseFloat(match[18]);
        const w = parseFloat(match[19]);
        const h = parseFloat(match[20]);
        if ((Math.abs(h) < 2 && Math.abs(w) > 5) || (Math.abs(w) < 2 && Math.abs(h) > 5)) {
          elements.push({
            type: 'border',
            x,
            y: Math.abs(h) < 2 ? pageHeight - y : pageHeight - y - Math.abs(h),
            width: Math.abs(w),
            height: Math.abs(h),
            text: '',
            fontSize: 0,
            fontName: '',
            strokeColor: rgbToHex(strokeColor),
            lineWidth,
            opacity: strokeOpacity < 1 ? strokeOpacity : undefined,
          });
          pendingRect = null;
          continue;
        }
        if (Math.abs(w) >= 5 && Math.abs(h) >= 5) {
          pendingRect = { x, y, w, h };
        }
        continue;
      }

      if (!pendingRect) continue;
      if (token === 'f' || token === 'f*' || token === 'B' || token === 'B*' || token === 'S') {
        const width = Math.abs(pendingRect.w);
        const height = Math.abs(pendingRect.h);
        if (!(width > pageHeight * 0.9 && height > pageHeight * 0.9) && !(isBlack(fillColor) && width > 300 && height > 300)) {
          elements.push({
            type: 'rect',
            x: pendingRect.x,
            y: pageHeight - pendingRect.y - height,
            width,
            height,
            text: '',
            fontSize: 0,
            fontName: '',
            fillColor: (token !== 'S' && !isWhite(fillColor)) ? rgbToHex(fillColor) : undefined,
            strokeColor: (token === 'S' || token === 'B' || token === 'B*') ? rgbToHex(strokeColor) : undefined,
            lineWidth: lineWidth !== 1 ? lineWidth : undefined,
            opacity: fillOpacity < 1 ? fillOpacity : undefined,
          });
        }
        pendingRect = null;
      }
    }

    return elements;
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

  private decodeStream(id: number): string | null {
    const offset = this.xref.get(id);
    if (offset === undefined) return null;

    const start = this.str.indexOf('stream', offset);
    const end = this.str.indexOf('endstream', start);
    if (start === -1 || end === -1) return null;

    let streamStart = start + 6;
    while (this.buffer[streamStart] === 10 || this.buffer[streamStart] === 13) streamStart++;

    const data = this.buffer.subarray(streamStart, end);
    const header = this.str.substring(offset, start);

    let decoded = data;
    if (header.includes('/FlateDecode')) {
      try {
        decoded = zlib.inflateSync(data);
      } catch (_) {
        try { decoded = zlib.unzipSync(data); } catch (__) { return null; }
      }
    }

    return decoded.toString('latin1');
  }

  private readRawStream(id: number): { header: string; data: Buffer } | null {
    const offset = this.xref.get(id);
    if (offset === undefined) return null;

    const start = this.str.indexOf('stream', offset);
    const end = this.str.indexOf('endstream', start);
    if (start === -1 || end === -1) return null;

    let streamStart = start + 6;
    while (this.buffer[streamStart] === 10 || this.buffer[streamStart] === 13) streamStart += 1;

    return {
      header: this.str.substring(offset, start),
      data: this.buffer.subarray(streamStart, end),
    };
  }

  private extractTextFromStream(id: number): string {
    const decoded = this.decodeStream(id);
    if (!decoded) return '';
    return this.parseTextOperators(decoded).join(' ');
  }

  private extractPlacedImages(
    content: string,
    pageHeight: number,
    imageResources: Map<string, number>,
  ): PdfImageElement[] {
    const images: PdfImageElement[] = [];
    const imageRegex = /(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm\s*\/([A-Za-z0-9_.-]+)\s+Do/g;
    let match: RegExpExecArray | null;

    while ((match = imageRegex.exec(content)) !== null) {
      const resourceName = match[7];
      const objectId = imageResources.get(resourceName);
      if (!objectId) continue;

      const imagePath = this.materializeImageObject(objectId);
      if (!imagePath) continue;

      const a = parseFloat(match[1]) || 0;
      const d = parseFloat(match[4]) || 0;
      const e = parseFloat(match[5]) || 0;
      const f = parseFloat(match[6]) || 0;
      const width = Math.abs(a);
      const height = Math.abs(d);
      if (width <= 0 || height <= 0) continue;

      images.push({
        path: imagePath,
        x: Math.max(0, e),
        y: Math.max(0, pageHeight - f - height),
        width,
        height,
      });
    }

    return images;
  }

  private materializeImageObject(objectId: number): string | null {
    if (this.imagePathCache.has(objectId)) {
      return this.imagePathCache.get(objectId) || null;
    }

    const raw = this.readRawStream(objectId);
    const fullObject = this.getFullObject(objectId) || '';
    if (!raw || !/\/Subtype\s*\/Image\b/.test(fullObject)) {
      this.imagePathCache.set(objectId, null);
      return null;
    }

    const softMaskObjectId = Number.parseInt(fullObject.match(/\/SMask\s+(\d+)\s+0\s+R/)?.[1] || '', 10);
    let extension = '';
    let data = raw.data;
    if (/\/DCTDecode\b/.test(raw.header)) {
      extension = '.jpg';
    } else if (/\/JPXDecode\b/.test(raw.header)) {
      extension = '.jp2';
    } else if (/\/FlateDecode\b/.test(raw.header)) {
      const alphaMask = Number.isFinite(softMaskObjectId) ? this.extractSoftMaskAlpha(softMaskObjectId) : null;
      const png = this.convertFlateImageToPng(raw.header, raw.data, alphaMask);
      if (!png) {
        this.imagePathCache.set(objectId, null);
        return null;
      }
      extension = '.png';
      data = png;
    } else if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
      extension = '.png';
    } else {
      this.imagePathCache.set(objectId, null);
      return null;
    }

    const dir = pathResolver.sharedTmp('native-pdf/images');
    safeMkdir(dir, { recursive: true });
    const outPath = path.join(dir, `pdf-image-${objectId}${extension}`);
    safeWriteFile(outPath, data);
    this.imagePathCache.set(objectId, outPath);
    return outPath;
  }

  private extractSoftMaskAlpha(objectId: number): Buffer | null {
    const raw = this.readRawStream(objectId);
    const fullObject = this.getFullObject(objectId) || '';
    if (!raw || !/\/Subtype\s*\/Image\b/.test(fullObject) || !/\/FlateDecode\b/.test(raw.header)) {
      return null;
    }
    const decoded = this.decodeFlateImage(raw.header, raw.data);
    if (!decoded || decoded.channels !== 1 || decoded.bitsPerComponent !== 8) {
      return null;
    }
    return decoded.rawPixels;
  }

  private decodeFlateImage(
    header: string,
    compressedData: Buffer,
  ): { width: number; height: number; channels: number; colorType: number; bitsPerComponent: number; rawPixels: Buffer } | null {
    const width = Number.parseInt(header.match(/\/Width\s+(\d+)/)?.[1] || '', 10);
    const height = Number.parseInt(header.match(/\/Height\s+(\d+)/)?.[1] || '', 10);
    const bitsPerComponent = Number.parseInt(header.match(/\/BitsPerComponent\s+(\d+)/)?.[1] || '', 10);
    const colorSpace = header.match(/\/ColorSpace\s*\/([A-Za-z0-9]+)/)?.[1] || '';
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
    if (bitsPerComponent !== 8) return null;

    let channels = 0;
    let colorType = 0;
    if (colorSpace === 'DeviceRGB') {
      channels = 3;
      colorType = 2;
    } else if (colorSpace === 'DeviceGray') {
      channels = 1;
      colorType = 0;
    } else {
      return null;
    }

    let rawPixels: Buffer;
    try {
      rawPixels = zlib.inflateSync(compressedData);
    } catch {
      return null;
    }

    const rowStride = width * channels;
    if (rawPixels.length < rowStride * height) return null;
    return { width, height, channels, colorType, bitsPerComponent, rawPixels: rawPixels.subarray(0, rowStride * height) };
  }

  private convertFlateImageToPng(header: string, compressedData: Buffer, alphaMask?: Buffer | null): Buffer | null {
    const decoded = this.decodeFlateImage(header, compressedData);
    if (!decoded) return null;
    const { width, height, channels, rawPixels } = decoded;
    const hasAlpha = !!alphaMask && alphaMask.length >= width * height;
    const pngChannels = hasAlpha ? channels + 1 : channels;
    const pngColorType = hasAlpha ? (channels === 3 ? 6 : 4) : decoded.colorType;
    const rowStride = width * channels;
    const pngRowStride = width * pngChannels;
    const pngScanlines = Buffer.alloc((pngRowStride + 1) * height);
    for (let row = 0; row < height; row += 1) {
      const srcStart = row * rowStride;
      const dstStart = row * (pngRowStride + 1);
      pngScanlines[dstStart] = 0;
      if (!hasAlpha) {
        rawPixels.copy(pngScanlines, dstStart + 1, srcStart, srcStart + rowStride);
        continue;
      }
      const alphaStart = row * width;
      const rowPixelsStart = dstStart + 1;
      for (let col = 0; col < width; col += 1) {
        const srcPixel = srcStart + (col * channels);
        const dstPixel = rowPixelsStart + (col * pngChannels);
        for (let channel = 0; channel < channels; channel += 1) {
          pngScanlines[dstPixel + channel] = rawPixels[srcPixel + channel];
        }
        pngScanlines[dstPixel + channels] = alphaMask![alphaStart + col];
      }
    }

    const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = pngColorType;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const idat = zlib.deflateSync(pngScanlines);
    return Buffer.concat([
      signature,
      this.buildPngChunk('IHDR', ihdr),
      this.buildPngChunk('IDAT', idat),
      this.buildPngChunk('IEND', Buffer.alloc(0)),
    ]);
  }

  private buildPngChunk(type: string, data: Buffer): Buffer {
    const typeBuffer = Buffer.from(type, 'ascii');
    const lengthBuffer = Buffer.alloc(4);
    lengthBuffer.writeUInt32BE(data.length, 0);
    const crcBuffer = Buffer.alloc(4);
    crcBuffer.writeUInt32BE(this.crc32(Buffer.concat([typeBuffer, data])), 0);
    return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
  }

  private crc32(buffer: Buffer): number {
    let crc = 0 ^ (-1);
    for (let index = 0; index < buffer.length; index += 1) {
      crc ^= buffer[index];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
      }
    }
    return (crc ^ (-1)) >>> 0;
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

  private extractPositionedText(content: string, pageHeight: number, fontResources: Map<string, number>): PdfLayoutElement[] {
    const elements: PdfLayoutElement[] = [];
    const btBlocks = content.split('BT');
    type AffineMatrix = [number, number, number, number, number, number];
    const identityMatrix: AffineMatrix = [1, 0, 0, 1, 0, 0];
    const multiplyMatrix = (left: AffineMatrix, right: AffineMatrix): AffineMatrix => [
      left[0] * right[0] + left[2] * right[1],
      left[1] * right[0] + left[3] * right[1],
      left[0] * right[2] + left[2] * right[3],
      left[1] * right[2] + left[3] * right[3],
      left[0] * right[4] + left[2] * right[5] + left[4],
      left[1] * right[4] + left[3] * right[5] + left[5],
    ];
    const ctmStack: AffineMatrix[] = [];
    let currentCtm: AffineMatrix = [...identityMatrix];
    const btCtmMap: AffineMatrix[] = [];

    const ctmTokenRegex = /\bq\b|\bQ\b|(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+cm\b|\bBT\b/g;
    let ctmTokenMatch: RegExpExecArray | null;
    while ((ctmTokenMatch = ctmTokenRegex.exec(content)) !== null) {
      const token = ctmTokenMatch[0].trim();
      if (token === 'q') {
        ctmStack.push([...currentCtm]);
        continue;
      }
      if (token === 'Q') {
        if (ctmStack.length > 0) currentCtm = ctmStack.pop() as AffineMatrix;
        continue;
      }
      if (token === 'BT') {
        btCtmMap.push([...currentCtm]);
        continue;
      }
      if (token.endsWith('cm')) {
        const cm: AffineMatrix = [
          parseFloat(ctmTokenMatch[1]) || 0,
          parseFloat(ctmTokenMatch[2]) || 0,
          parseFloat(ctmTokenMatch[3]) || 0,
          parseFloat(ctmTokenMatch[4]) || 0,
          parseFloat(ctmTokenMatch[5]) || 0,
          parseFloat(ctmTokenMatch[6]) || 0,
        ];
        currentCtm = multiplyMatrix(currentCtm, cm);
      }
    }

    for (let i = 1; i < btBlocks.length; i++) {
      const block = btBlocks[i].split('ET')[0];
      const ctm = btCtmMap[i - 1] || identityMatrix;
      const hasCtm = ctm.some((value, index) => value !== identityMatrix[index]);
      const state = {
        x: 0,
        y: 0,
        fontSize: 12,
        fontName: '',
        fontObjectId: undefined as number | undefined,
        leading: 0,
      };

      const opRegex = /\/[A-Za-z0-9_.-]+\s+-?\d*\.?\d+\s+Tf|-?\d*\.?\d+\s+-?\d*\.?\d+\s+-?\d*\.?\d+\s+-?\d*\.?\d+\s+-?\d*\.?\d+\s+-?\d*\.?\d+\s+Tm|-?\d*\.?\d+\s+-?\d*\.?\d+\s+TD|-?\d*\.?\d+\s+-?\d*\.?\d+\s+Td|-?\d*\.?\d+\s+TL|T\*|\[(?:.|\r|\n)*?\]\s*TJ|\((?:\\.|[^\\)])*\)\s*Tj|<[0-9A-Fa-f\s]+>\s*Tj/g;
      let match: RegExpExecArray | null;

      while ((match = opRegex.exec(block)) !== null) {
        const token = match[0].trim();

        if (token.endsWith(' Tf')) {
          const tfMatch = token.match(/^\/([A-Za-z0-9_.-]+)\s+(-?\d*\.?\d+)\s+Tf$/);
          if (tfMatch) {
            state.fontName = tfMatch[1];
            state.fontSize = parseFloat(tfMatch[2]) || state.fontSize;
            state.fontObjectId = fontResources.get(tfMatch[1]);
          }
          continue;
        }

        if (token.endsWith(' Tm')) {
          const tmMatch = token.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+Tm$/);
          if (tmMatch) {
            const a = parseFloat(tmMatch[1]) || 0;
            const b = parseFloat(tmMatch[2]) || 0;
            state.x = parseFloat(tmMatch[5]) || 0;
            state.y = parseFloat(tmMatch[6]) || 0;
            const tmScale = Math.sqrt(a * a + b * b);
            if (tmScale > 1 && state.fontSize <= 1) {
              state.fontSize = tmScale;
            }
          }
          continue;
        }

        if (token.endsWith(' TD')) {
          const tdMatch = token.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+TD$/);
          if (tdMatch) {
            state.x += parseFloat(tdMatch[1]) || 0;
            state.y += parseFloat(tdMatch[2]) || 0;
            state.leading = -(parseFloat(tdMatch[2]) || 0);
          }
          continue;
        }

        if (token.endsWith(' Td')) {
          const tdMatch = token.match(/^(-?\d*\.?\d+)\s+(-?\d*\.?\d+)\s+Td$/);
          if (tdMatch) {
            state.x += parseFloat(tdMatch[1]) || 0;
            state.y += parseFloat(tdMatch[2]) || 0;
          }
          continue;
        }

        if (token.endsWith(' TL')) {
          const tlMatch = token.match(/^(-?\d*\.?\d+)\s+TL$/);
          if (tlMatch) state.leading = parseFloat(tlMatch[1]) || state.leading;
          continue;
        }

        if (token === 'T*') {
          state.y -= state.leading || state.fontSize * 1.2;
          state.x = 0;
          continue;
        }

        const text = this.extractTextToken(token, state.fontObjectId);
        if (!text) continue;
        if (hasCtm) {
          const transformedState = {
            ...state,
            x: ctm[0] * state.x + ctm[2] * state.y + ctm[4],
            y: ctm[1] * state.x + ctm[3] * state.y + ctm[5],
            fontSize: state.fontSize * Math.max(1, Math.sqrt(ctm[0] * ctm[0] + ctm[1] * ctm[1])),
          };
          elements.push(this.buildTextElement(text, transformedState, pageHeight));
          continue;
        }
        elements.push(this.buildTextElement(text, state, pageHeight));
      }
    }

    return elements.filter((element) => element.text?.trim());
  }

  private extractTextToken(token: string, fontObjectId?: number): string {
    const literal = token.match(/^\(([\s\S]*)\)\s*Tj$/);
    if (literal) return this.decodeLiteralString(literal[1]);

    const hex = token.match(/^<([0-9A-Fa-f\s]+)>\s*Tj$/);
    if (hex) return this.decodeHexString(hex[1], fontObjectId);

    const array = token.match(/^\[([\s\S]*)\]\s*TJ$/);
    if (array) {
      const parts: string[] = [];
      const itemRegex = /\(([\s\S]*?)(?<!\\)\)|<([0-9A-Fa-f\s]+)>/g;
      let item: RegExpExecArray | null;
      while ((item = itemRegex.exec(array[1])) !== null) {
        if (item[1] !== undefined) parts.push(this.decodeLiteralString(item[1]));
        if (item[2] !== undefined) parts.push(this.decodeHexString(item[2], fontObjectId));
      }
      return parts.join('');
    }

    return '';
  }

  private decodeLiteralString(input: string): string {
    let normalized = '';
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch !== '\\') {
        normalized += ch;
        continue;
      }

      const next = input[i + 1];
      if (next === undefined) {
        normalized += '\\';
        break;
      }

      if (/[0-7]/.test(next)) {
        let octal = next;
        let advance = 1;
        for (let j = i + 2; j < input.length && advance < 3 && /[0-7]/.test(input[j]); j++, advance++) {
          octal += input[j];
        }
        normalized += this.decodePdfByteToChar(parseInt(octal, 8));
        i += advance;
        continue;
      }

      switch (next) {
        case '\\':
          normalized += '\\';
          break;
        case '(':
          normalized += '(';
          break;
        case ')':
          normalized += ')';
          break;
        case 'n':
          normalized += '\n';
          break;
        case 'r':
          normalized += '\r';
          break;
        case 't':
          normalized += '\t';
          break;
        case 'b':
          normalized += '\b';
          break;
        case 'f':
          normalized += '\f';
          break;
        case '\n':
        case '\r':
          break;
        default:
          normalized += next;
          break;
      }
      i += 1;
    }
    return normalized;
  }

  private buildTextElement(
    text: string,
    state: { x: number; y: number; fontSize: number; fontName: string },
    pageHeight: number,
  ): PdfLayoutElement {
    const fontSize = Math.max(8, state.fontSize || 12);
    const estimatedWidth = Math.max(fontSize * 1.2, text.length * fontSize * 0.55);
    const topDownY = Math.max(0, pageHeight - state.y);
    return {
      type: fontSize >= 16 ? 'heading' : 'text',
      x: Math.max(0, state.x),
      y: topDownY,
      width: estimatedWidth,
      height: fontSize * 1.2,
      text: text.replace(/\s+/g, ' ').trim(),
      fontSize,
      fontName: state.fontName || undefined,
    };
  }

  /**
   * Decode a PDF hex string.
   * If it starts with FEFF (UTF-16BE BOM), decode as UTF-16BE.
   * Otherwise decode as raw byte pairs.
   */
  private decodeHexString(hex: string, fontObjectId?: number): string {
    // Normalize: remove whitespace
    hex = hex.replace(/\s/g, '');
    // Pad to even length
    if (hex.length % 2 !== 0) hex += '0';

    const unicodeMap = fontObjectId ? this.getFontUnicodeMap(fontObjectId) : null;
    if (unicodeMap?.size) {
      const normalizedHex = hex.toUpperCase();
      const mapped = unicodeMap.get(normalizedHex);
      if (mapped) return mapped;
      const segmented = this.decodeMappedHexSequence(normalizedHex, unicodeMap);
      if (segmented) return segmented;
    }

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
    return bytes.map((b) => this.decodePdfByteToChar(b)).join('');
  }

  private decodePdfByteToChar(byte: number): string {
    const cp1252Map: Record<number, string> = {
      0x80: '\u20AC',
      0x82: '\u201A',
      0x83: '\u0192',
      0x84: '\u201E',
      0x85: '\u2026',
      0x86: '\u2020',
      0x87: '\u2021',
      0x88: '\u02C6',
      0x89: '\u2030',
      0x8A: '\u0160',
      0x8B: '\u2039',
      0x8C: '\u0152',
      0x8E: '\u017D',
      0x91: '\u2018',
      0x92: '\u2019',
      0x93: '\u201C',
      0x94: '\u201D',
      0x95: '\u2022',
      0x96: '\u2013',
      0x97: '\u2014',
      0x98: '\u02DC',
      0x99: '\u2122',
      0x9A: '\u0161',
      0x9B: '\u203A',
      0x9C: '\u0153',
      0x9E: '\u017E',
      0x9F: '\u0178',
    };
    if (cp1252Map[byte]) return cp1252Map[byte];
    return String.fromCharCode(byte);
  }

  private decodeMappedHexSequence(hex: string, unicodeMap: Map<string, string>): string | null {
    const lengths = Array.from(new Set([...unicodeMap.keys()].map((key) => key.length))).sort((a, b) => b - a);
    let cursor = 0;
    let result = '';

    while (cursor < hex.length) {
      let matched = false;
      for (const length of lengths) {
        const chunk = hex.slice(cursor, cursor + length);
        if (chunk.length !== length) continue;
        const decoded = unicodeMap.get(chunk);
        if (decoded !== undefined) {
          result += decoded;
          cursor += length;
          matched = true;
          break;
        }
      }
      if (!matched) return null;
    }

    return result || null;
  }

  private getFontUnicodeMap(fontObjectId: number): Map<string, string> | null {
    if (this.fontUnicodeCache.has(fontObjectId)) {
      return this.fontUnicodeCache.get(fontObjectId) || null;
    }

    const fontObject = this.getFullObject(fontObjectId);
    if (!fontObject) {
      this.fontUnicodeCache.set(fontObjectId, null);
      return null;
    }

    const toUnicodeMatch = fontObject.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (!toUnicodeMatch) {
      this.fontUnicodeCache.set(fontObjectId, null);
      return null;
    }

    const cmapStream = this.decodeStream(parseInt(toUnicodeMatch[1]));
    if (!cmapStream) {
      this.fontUnicodeCache.set(fontObjectId, null);
      return null;
    }

    const cmap = this.parseToUnicodeCMap(cmapStream);
    this.fontUnicodeCache.set(fontObjectId, cmap);
    return cmap;
  }

  private parseToUnicodeCMap(input: string): Map<string, string> {
    const cmap = new Map<string, string>();

    const bfcharRegex = /(\d+)\s+beginbfchar([\s\S]*?)endbfchar/g;
    let bfcharMatch: RegExpExecArray | null;
    while ((bfcharMatch = bfcharRegex.exec(input)) !== null) {
      const body = bfcharMatch[2];
      const pairRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let pair: RegExpExecArray | null;
      while ((pair = pairRegex.exec(body)) !== null) {
        cmap.set(pair[1].toUpperCase(), this.decodeUnicodeHex(pair[2]));
      }
    }

    const bfrangeRegex = /(\d+)\s+beginbfrange([\s\S]*?)endbfrange/g;
    let bfrangeMatch: RegExpExecArray | null;
    while ((bfrangeMatch = bfrangeRegex.exec(input)) !== null) {
      const body = bfrangeMatch[2];
      const rangeRegex = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let range: RegExpExecArray | null;
      while ((range = rangeRegex.exec(body)) !== null) {
        const start = parseInt(range[1], 16);
        const end = parseInt(range[2], 16);
        let target = parseInt(range[3], 16);
        for (let code = start; code <= end; code++) {
          cmap.set(code.toString(16).toUpperCase().padStart(range[1].length, '0'), this.decodeUnicodeHex(target.toString(16)));
          target++;
        }
      }
    }

    return cmap;
  }

  private decodeUnicodeHex(hex: string): string {
    const normalized = hex.replace(/\s/g, '').padStart(4, '0');
    let result = '';
    for (let i = 0; i + 3 < normalized.length; i += 4) {
      result += String.fromCharCode(parseInt(normalized.slice(i, i + 4), 16));
    }
    return result;
  }

  // ── Resilient Fallback ────────────────────────────────────

  private resilientStreamScan(): PdfPage[] {
    const pages: PdfPage[] = [];
    let pNum = 1;
    let offset = 0;
    while ((offset = this.str.indexOf('stream', offset)) !== -1) {
      const end = this.str.indexOf('endstream', offset);
      if (end === -1) break;
      const decoded = this.decodeRawStream(offset, end);
      if (!decoded) {
        offset = end + 9;
        continue;
      }
      const text = this.parseTextOperators(decoded).join(' ').trim();
      const elements = this.extractPositionedText(decoded, 842, new Map());
      if (text.length > 100 || elements.length > 0) {
        pages.push({ pageNumber: pNum++, width: 595, height: 842, text, elements });
      }
      offset = end + 9;
    }
    return pages;
  }

  private decodeRawStream(start: number, end: number): string | null {
    let streamStart = start + 6;
    while (this.buffer[streamStart] === 10 || this.buffer[streamStart] === 13) streamStart++;
    const data = this.buffer.subarray(streamStart, end);
    const header = this.str.substring(Math.max(0, start - 200), start);
    let decoded = data;
    if (header.includes('/FlateDecode')) {
      try { decoded = zlib.inflateSync(data); } catch (_) {
        try { decoded = zlib.unzipSync(data); } catch (__) { return null; }
      }
    }
    return decoded.toString('latin1');
  }

  private extractTextFromRawStream(start: number, end: number): string {
    const decoded = this.decodeRawStream(start, end);
    if (!decoded) return '';
    return this.parseTextOperators(decoded).join(' ');
  }
}

// ── Public Extraction API ───────────────────────────────────

export async function distillNativePdfDesign(sourcePath: string): Promise<PdfDesignProtocol> {
  const parser = new NativePdfParser(sourcePath);
  const metadata = parser.extractMetadata();
  const pages = parser.extractPages();
  const fullText = pages.map(p => p.text).join('\n\n');
  const elements = pages.flatMap((page) => [
    ...(page.elements || []),
    ...((page.images || []).map((image) => ({
      type: 'image' as const,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
    }))),
  ]);
  const fonts = Array.from(new Set(
    elements
      .filter((element): element is PdfLayoutElement => element.type !== 'image')
      .map((element) => element.fontName)
      .filter(Boolean),
  )) as string[];
  const xBuckets = Array.from(new Set(elements.map((element) => Math.round(element.x / 40))));
  const layout = xBuckets.length >= 2 ? 'multi-column' : 'single-column';

  return {
    version: '4.0.0',
    generatedAt: new Date().toISOString(),
    source: { format: 'markdown' as any, body: fullText, title: metadata.title },
    content: { text: fullText, pages },
    metadata: { ...metadata, pageCount: pages.length },
    aesthetic: { layout, elements, fonts }
  };
}
