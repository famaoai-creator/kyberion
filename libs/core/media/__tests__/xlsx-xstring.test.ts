import { describe, expect, it } from 'vitest';
import {
  computeSheetDimension,
  decodeXstring,
  encodeXstring,
  escapeXlsxAttr,
  parseIsoDatetimeToSerial,
} from '../xlsx-xstring.js';

describe('xlsx ST_Xstring (GridCraft-aligned)', () => {
  it('round-trips control characters via _xHHHH_', () => {
    const raw = 'line\u0001break';
    expect(encodeXstring(raw)).toBe('line_x0001_break');
    expect(decodeXstring(encodeXstring(raw))).toBe(raw);
  });

  it('protects literal _xHHHH_ sequences with _x005F_', () => {
    expect(encodeXstring('_x000D_')).toBe('_x005F_x000D_');
    expect(decodeXstring('_x000D_')).toBe('\r');
  });

  it('parses ISO datetimes to Excel serials', () => {
    // 1900 system uses the 1899-12-30 epoch (same as formatXlsxNumber).
    expect(parseIsoDatetimeToSerial('2024-01-01T12:00:00')).toBe(45292.5);
    expect(parseIsoDatetimeToSerial('1904-01-02', true)).toBe(1);
    expect(parseIsoDatetimeToSerial('06:00:00')).toBe(0.25);
    expect(parseIsoDatetimeToSerial('garbage')).toBeNull();
  });

  it('escapes attribute whitespace as character refs', () => {
    expect(escapeXlsxAttr('a"b\nc')).toBe('a&quot;b&#10;c');
  });

  it('computes used range dimensions', () => {
    expect(
      computeSheetDimension([{ cells: [{ ref: 'B2' }, { ref: 'D2' }] }, { cells: [{ ref: 'A5' }] }])
    ).toBe('A2:D5');
  });
});
