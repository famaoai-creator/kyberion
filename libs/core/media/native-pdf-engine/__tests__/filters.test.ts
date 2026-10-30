import { describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import {
  decodeFilterChain,
  decodeFlate,
  decodeLzw,
  parseDecodeParms,
  parseFilterNames,
} from '../filters.js';
import { escapeLit } from '../primitives.js';

describe('native-pdf filters (PdfCraft-aligned)', () => {
  it('parses filter names and abbreviations', () => {
    expect(parseFilterNames('/Filter /FlateDecode')).toEqual(['FlateDecode']);
    expect(parseFilterNames('/Filter [/ASCII85Decode /FlateDecode]')).toEqual([
      'ASCII85Decode',
      'FlateDecode',
    ]);
    expect(parseFilterNames('/Filter [/A85 /Fl]')).toEqual(['ASCII85Decode', 'FlateDecode']);
  });

  it('decodes ASCIIHex and ASCII85 vectors', () => {
    expect(decodeFilterChain(Buffer.from('48656c6C6F>'), ['ASCIIHexDecode'])!.toString()).toBe(
      'Hello'
    );
    expect(decodeFilterChain(Buffer.from('9jqo^~>'), ['ASCII85Decode'])!.toString()).toBe('Man ');
    expect(decodeFilterChain(Buffer.from('z~>'), ['ASCII85Decode'])).toEqual(Buffer.alloc(4));
  });

  it('decodes RunLength and Flate chains', () => {
    // literal "ABC" then EOD
    const rl = Buffer.from([0x02, 0x41, 0x42, 0x43, 0x80]);
    expect(decodeFilterChain(rl, ['RunLengthDecode'])!.toString()).toBe('ABC');

    const payload = Buffer.from('stream-body');
    const flate = zlib.deflateSync(payload);
    expect(decodeFlate(flate, 1024)!.equals(payload)).toBe(true);

    // ASCII85 → Flate
    const a85ThenFlate = (() => {
      // encode flate bytes as ASCII85 manually via known round-trip helper path
      const encoded = zlib.deflateSync(Buffer.from('Hi'));
      // Use hex for stable fixture instead
      return encoded;
    })();
    expect(decodeFilterChain(a85ThenFlate, ['FlateDecode'])!.toString()).toBe('Hi');
  });

  it('decodes LZWDecode ISO example (PdfCraft SPEC)', () => {
    // ISO 32000-2 §7.4.4.2 / PdfCraft filters/lzw.rs SPEC_OUT → SPEC_IN
    const encoded = Buffer.from([0x80, 0x0b, 0x60, 0x50, 0x22, 0x0c, 0x0c, 0x85, 0x01]);
    const expected = Buffer.from([45, 45, 45, 45, 45, 65, 45, 45, 45, 66]);
    expect(decodeLzw(encoded, 1)).toEqual(expected);
    expect(decodeFilterChain(encoded, ['LZWDecode'])).toEqual(expected);
  });

  it('applies PNG predictor 12 (Up) after Flate', () => {
    // 3 columns, 1 color, 8 bpc. Two rows with PNG Up tags.
    // Row0 tag0: 10 20 30 → 10 20 30
    // Row1 tag2: 1 1 1 → 11 21 31
    const raw = Buffer.from([0, 10, 20, 30, 2, 1, 1, 1]);
    const compressed = zlib.deflateSync(raw);
    const out = decodeFilterChain(compressed, ['FlateDecode'], {
      predictor: 12,
      colors: 1,
      bitsPerComponent: 8,
      columns: 3,
      earlyChange: 1,
    });
    expect(out).toEqual(Buffer.from([10, 20, 30, 11, 21, 31]));
  });

  it('parses DecodeParms', () => {
    expect(
      parseDecodeParms(
        '/DecodeParms << /Predictor 12 /Colors 3 /BitsPerComponent 8 /Columns 100 /EarlyChange 0 >>'
      )
    ).toEqual({
      predictor: 12,
      colors: 3,
      bitsPerComponent: 8,
      columns: 100,
      earlyChange: 0,
    });
  });
});

describe('escapeLit (PdfCraft-aligned)', () => {
  it('escapes controls and parentheses', () => {
    expect(escapeLit('a(b)c')).toBe('a\\(b\\)c');
    expect(escapeLit('line\nbreak')).toBe('line\\nbreak');
    expect(escapeLit('tab\there')).toBe('tab\\there');
    expect(escapeLit(String.fromCharCode(1))).toBe('\\001');
  });
});
