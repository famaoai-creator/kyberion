/**
 * PDF stream filter decoders (ISO 32000-2 §7.4) for the native reader.
 *
 * Algorithms follow the PDF / TIFF / PNG specs. Behaviour was cross-checked
 * against PdfCraft's `pdfcraft-filters` (MIT OR Apache-2.0) for the portable
 * general-purpose filters: ASCIIHex, ASCII85, RunLength, Flate, and predictors.
 * Image codecs (DCT/JPX/JBIG2/CCITT) stay opaque here.
 */
import * as zlib from 'node:zlib';

/** Default inflate / decode cap — ~64 MiB intermediate bytes. */
export const DEFAULT_MAX_DECODED = 64 * 1024 * 1024;
const MAX_FILTER_CHAIN = 8;

export type DecodeParms = {
  predictor: number;
  colors: number;
  bitsPerComponent: number;
  columns: number;
  /** LZW `/EarlyChange` — 1 (default) grows width one code early. */
  earlyChange: number;
};

export const DEFAULT_DECODE_PARMS: DecodeParms = {
  predictor: 1,
  colors: 1,
  bitsPerComponent: 8,
  columns: 1,
  earlyChange: 1,
};

const FILTER_ALIASES: Record<string, string> = {
  FlateDecode: 'FlateDecode',
  Fl: 'FlateDecode',
  ASCIIHexDecode: 'ASCIIHexDecode',
  AHx: 'ASCIIHexDecode',
  ASCII85Decode: 'ASCII85Decode',
  A85: 'ASCII85Decode',
  RunLengthDecode: 'RunLengthDecode',
  RL: 'RunLengthDecode',
  LZWDecode: 'LZWDecode',
  LZW: 'LZWDecode',
};

function isPdfWhitespace(b: number): boolean {
  return b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;
}

/** Resolve `/Filter /Name` or `/Filter [/A /B]` (also accepts `/Filter/Name`). */
export function parseFilterNames(header: string): string[] {
  const arrayMatch = header.match(/\/Filter\s*\[([^\]]*)\]/);
  if (arrayMatch) {
    const names: string[] = [];
    const re = /\/([A-Za-z0-9]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(arrayMatch[1])) !== null) {
      const canon = FILTER_ALIASES[m[1]];
      if (canon) names.push(canon);
      else names.push(m[1]);
    }
    return names;
  }
  const single = header.match(/\/Filter\s*\/([A-Za-z0-9]+)/);
  if (!single) return [];
  return [FILTER_ALIASES[single[1]] ?? single[1]];
}

/** Best-effort `/DecodeParms` (direct dict only; common Flate+Predictor case). */
export function parseDecodeParms(header: string): DecodeParms {
  const parms = { ...DEFAULT_DECODE_PARMS };
  const block =
    header.match(/\/DecodeParms\s*<<([\s\S]*?)>>/)?.[1] ??
    header.match(/\/DP\s*<<([\s\S]*?)>>/)?.[1] ??
    '';
  if (!block) return parms;
  const num = (key: string, fallback: number): number => {
    const m = block.match(new RegExp(`\\/${key}\\s+(-?\\d+)`));
    return m ? Number.parseInt(m[1], 10) : fallback;
  };
  parms.predictor = num('Predictor', parms.predictor);
  parms.colors = num('Colors', parms.colors);
  parms.bitsPerComponent = num('BitsPerComponent', parms.bitsPerComponent);
  parms.columns = num('Columns', parms.columns);
  parms.earlyChange = num('EarlyChange', parms.earlyChange);
  return parms;
}

/**
 * LZWDecode (ISO 32000-2 §7.4.4.2) — PdfCraft `filters/lzw.rs` behaviour:
 * 9–12 bit MSB codes, clear=256, EOD=257; tolerate missing EOD / late clear.
 */
export function decodeLzw(data: Buffer, earlyChange = 1, max = DEFAULT_MAX_DECODED): Buffer | null {
  const CLEAR = 256;
  const EOD = 257;
  const FIRST = 258;
  const TABLE = 4096;
  const early = earlyChange !== 0;
  const widthFor = (next: number): number => {
    const n = next + (early ? 1 : 0);
    if (n < 512) return 9;
    if (n < 1024) return 10;
    if (n < 2048) return 11;
    return 12;
  };

  const prefix = new Uint16Array(TABLE);
  const last = new Uint8Array(TABLE);
  const first = new Uint8Array(TABLE);
  const len = new Uint16Array(TABLE);
  for (let i = 0; i < 256; i += 1) {
    last[i] = i;
    first[i] = i;
    len[i] = 1;
  }

  let next = FIRST;
  let w = 9;
  let prev: number | null = null;
  let pos = 0;
  let acc = 0;
  let bits = 0;
  const out: number[] = [];

  const readBits = (n: number): number | null => {
    while (bits < n) {
      if (pos >= data.length) return null;
      acc = (acc << 8) | data[pos++];
      bits += 8;
    }
    bits -= n;
    const v = (acc >> bits) & ((1 << n) - 1);
    acc &= (1 << bits) - 1;
    return v;
  };

  while (true) {
    const codeRaw = readBits(w);
    if (codeRaw === null) break;
    if (codeRaw === CLEAR) {
      next = FIRST;
      w = 9;
      prev = null;
      continue;
    }
    if (codeRaw === EOD) break;

    const code = codeRaw;
    if (prev !== null) {
      const head = code < next ? first[code] : code === next && next < TABLE ? first[prev] : -1;
      if (head < 0) return out.length ? Buffer.from(out) : null;
      if (next < TABLE) {
        prefix[next] = prev;
        last[next] = head;
        first[next] = first[prev];
        len[next] = len[prev] + 1;
        next += 1;
      }
    } else if (code >= 256) {
      return out.length ? Buffer.from(out) : null;
    }

    const n = len[code];
    if (out.length + n > max) return null;
    const start = out.length;
    for (let i = 0; i < n; i += 1) out.push(0);
    let c = code;
    for (let i = n - 1; i >= 0; i -= 1) {
      out[start + i] = last[c];
      c = prefix[c];
    }
    prev = code;
    w = widthFor(next);
  }
  return Buffer.from(out);
}

function decodeAsciiHex(data: Buffer, max: number): Buffer | null {
  const out: number[] = [];
  let hi: number | null = null;
  for (let i = 0; i < data.length; i += 1) {
    const b = data[i];
    if (isPdfWhitespace(b)) continue;
    if (b === 0x3e /* > */) break;
    const n =
      b >= 0x30 && b <= 0x39
        ? b - 0x30
        : b >= 0x41 && b <= 0x46
          ? b - 0x41 + 10
          : b >= 0x61 && b <= 0x66
            ? b - 0x61 + 10
            : -1;
    if (n < 0) return out.length ? Buffer.from(out) : null;
    if (hi === null) {
      hi = n;
    } else {
      if (out.length >= max) return null;
      out.push((hi << 4) | n);
      hi = null;
    }
  }
  if (hi !== null) {
    if (out.length >= max) return null;
    out.push(hi << 4);
  }
  return Buffer.from(out);
}

function decodeAscii85(data: Buffer, max: number): Buffer | null {
  let start = 0;
  while (start < data.length && isPdfWhitespace(data[start])) start += 1;
  let body = data.subarray(start);
  if (body.length >= 2 && body[0] === 0x3c /* < */ && body[1] === 0x7e /* ~ */) {
    body = body.subarray(2);
  }
  const out: number[] = [];
  let acc = 0;
  let n = 0;
  const pushBytes = (bytes: number[]): boolean => {
    if (out.length + bytes.length > max) return false;
    out.push(...bytes);
    return true;
  };
  for (let i = 0; i < body.length; i += 1) {
    const b = body[i];
    if (b >= 0x21 && b <= 0x75) {
      acc = acc * 85 + (b - 0x21);
      n += 1;
      if (n === 5) {
        if (acc > 0xffffffff) return null;
        const v = acc >>> 0;
        if (!pushBytes([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff])) {
          return null;
        }
        acc = 0;
        n = 0;
      }
    } else if (b === 0x7a /* z */) {
      if (n !== 0) return null;
      if (!pushBytes([0, 0, 0, 0])) return null;
    } else if (b === 0x7e /* ~ */) {
      break;
    } else if (isPdfWhitespace(b)) {
      continue;
    } else {
      return null;
    }
  }
  if (n === 1) return null;
  if (n > 1) {
    const keep = n - 1;
    for (let p = n; p < 5; p += 1) acc = acc * 85 + 84;
    if (acc > 0xffffffff) return null;
    const v = acc >>> 0;
    const bytes = [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
    if (!pushBytes(bytes.slice(0, keep))) return null;
  }
  return Buffer.from(out);
}

function decodeRunLength(data: Buffer, max: number): Buffer | null {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const l = data[i++];
    if (l === 128) break;
    if (l <= 127) {
      const n = l + 1;
      if (i + n > data.length || out.length + n > max) return null;
      for (let k = 0; k < n; k += 1) out.push(data[i + k]);
      i += n;
    } else {
      if (i >= data.length) return null;
      const b = data[i++];
      const n = 257 - l;
      if (out.length + n > max) return null;
      for (let k = 0; k < n; k += 1) out.push(b);
    }
  }
  return Buffer.from(out);
}

/** zlib, then raw deflate; tolerate trailing junk (PdfCraft flate behaviour). */
export function decodeFlate(data: Buffer, max: number, tolerant = true): Buffer | null {
  const tryInflate = (fn: () => Buffer): Buffer | null => {
    try {
      const out = fn();
      if (out.length > max) return null;
      return out;
    } catch {
      return null;
    }
  };
  const zlibOut = tryInflate(() => zlib.inflateSync(data));
  if (zlibOut) return zlibOut;
  const unzipOut = tryInflate(() => zlib.unzipSync(data));
  if (unzipOut) return unzipOut;
  // Misleading / missing zlib header → raw deflate
  const raw = tryInflate(() => zlib.inflateRawSync(data));
  if (raw) return raw;
  if (!tolerant) return null;
  // Partial: inflate as far as zlib allows via inflate with finishFlush-like retry on prefix
  for (let end = data.length - 1; end > 2; end -= Math.max(1, Math.floor((end + 1) / 8))) {
    const partial = tryInflate(() =>
      zlib.inflateSync(data.subarray(0, end), { finishFlush: zlib.constants.Z_SYNC_FLUSH })
    );
    if (partial && partial.length > 0) return partial;
  }
  return null;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function applyPredictor(data: Buffer, parms: DecodeParms): Buffer | null {
  const { predictor, colors, bitsPerComponent: bpc, columns } = parms;
  if (predictor === 1) return data;
  if (colors < 1 || colors > 255 || columns < 1) return null;
  if (![1, 2, 4, 8, 16].includes(bpc)) return null;
  const samples = columns * colors;
  const rowBytes = Math.ceil((samples * bpc) / 8);
  const bpp = Math.ceil((colors * bpc) / 8);

  if (predictor === 2) {
    // TIFF horizontal differencing
    const out = Buffer.from(data);
    const mask = bpc === 16 ? 0xffff : (1 << bpc) - 1;
    const get = (row: Buffer, i: number): number => {
      if (bpc === 16) return row.readUInt16BE(i * 2);
      if (bpc === 8) return row[i];
      const bit = i * bpc;
      const shift = 8 - bpc - (bit % 8);
      return (row[Math.floor(bit / 8)] >> shift) & mask;
    };
    const set = (row: Buffer, i: number, v: number): void => {
      if (bpc === 16) row.writeUInt16BE(v & mask, i * 2);
      else if (bpc === 8) row[i] = v & mask;
      else {
        const bit = i * bpc;
        const shift = 8 - bpc - (bit % 8);
        const m = ((1 << bpc) - 1) << shift;
        const idx = Math.floor(bit / 8);
        row[idx] = (row[idx] & ~m) | ((v << shift) & m);
      }
    };
    for (let off = 0; off < out.length; off += rowBytes) {
      const row = out.subarray(off, Math.min(off + rowBytes, out.length));
      const avail = Math.min(samples, Math.floor((row.length * 8) / bpc));
      for (let i = colors; i < avail; i += 1) {
        set(row, i, (get(row, i) + get(row, i - colors)) & mask);
      }
    }
    return out;
  }

  if (predictor < 10 || predictor > 15) return null;

  // PNG predictors 10–15: each row begins with a filter-type byte
  const out: number[] = [];
  let up = Buffer.alloc(rowBytes);
  let pos = 0;
  while (pos < data.length) {
    const tag = data[pos++];
    if (tag > 4) return null;
    const avail = Math.min(rowBytes, data.length - pos);
    const src = data.subarray(pos, pos + avail);
    pos += avail;
    const cur = Buffer.alloc(avail);
    for (let i = 0; i < avail; i += 1) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = up[i] ?? 0;
      const c = i >= bpp ? (up[i - bpp] ?? 0) : 0;
      let pred = 0;
      if (tag === 1) pred = a;
      else if (tag === 2) pred = b;
      else if (tag === 3) pred = Math.floor((a + b) / 2);
      else if (tag === 4) pred = paeth(a, b, c);
      cur[i] = (src[i] + pred) & 0xff;
    }
    out.push(...cur);
    up = Buffer.alloc(rowBytes);
    cur.copy(up);
  }
  return Buffer.from(out);
}

/**
 * Apply a `/Filter` chain (first → last as stored). Image codecs are left encoded
 * (caller keeps the bytes). Returns null on unsupported / corrupt chains.
 */
export function decodeFilterChain(
  data: Buffer,
  filters: string[],
  parms: DecodeParms = DEFAULT_DECODE_PARMS,
  maxOutput: number = DEFAULT_MAX_DECODED
): Buffer | null {
  if (filters.length === 0) return data;
  if (filters.length > MAX_FILTER_CHAIN) return null;

  const imageCodecs = new Set([
    'DCTDecode',
    'DCT',
    'JPXDecode',
    'JPX',
    'JBIG2Decode',
    'CCITTFaxDecode',
    'CCF',
  ]);
  let cur: Buffer = data;
  for (let i = 0; i < filters.length; i += 1) {
    const name = filters[i];
    if (imageCodecs.has(name)) {
      // Leave remaining chain encoded — image path handles DCT/JPX specially.
      if (i === 0 && filters.length === 1) return data;
      return null;
    }
    let next: Buffer | null = null;
    if (name === 'ASCIIHexDecode') next = decodeAsciiHex(cur, maxOutput);
    else if (name === 'ASCII85Decode') next = decodeAscii85(cur, maxOutput);
    else if (name === 'RunLengthDecode') next = decodeRunLength(cur, maxOutput);
    else if (name === 'FlateDecode') {
      next = decodeFlate(cur, maxOutput, true);
      if (next && parms.predictor > 1 && i === filters.length - 1) {
        next = applyPredictor(next, parms);
      }
    } else if (name === 'LZWDecode') {
      next = decodeLzw(cur, parms.earlyChange, maxOutput);
      if (next && parms.predictor > 1 && i === filters.length - 1) {
        next = applyPredictor(next, parms);
      }
    } else {
      return null;
    }
    if (!next) return null;
    cur = next;
  }
  return cur;
}
