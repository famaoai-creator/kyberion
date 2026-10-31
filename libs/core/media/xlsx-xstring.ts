/**
 * SpreadsheetML ST_Xstring helpers (ECMA-376 §22.9.2.19).
 *
 * Characters XML 1.0 cannot carry (and bare CRs) are stored as `_xHHHH_`.
 * Behaviour aligned with GridCraft `crates/xlsx/src/xml.rs`
 * (`decode_xstring` / `encode_xstring` / `esc` / `esc_attr`, MIT OR Apache-2.0).
 */
import { escapeXml } from '../text-escaping.js';

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

function looksLikeEscape(chars: string[], i: number): boolean {
  if (chars[i + 1] !== 'x' || chars[i + 6] !== '_') return false;
  for (let k = i + 2; k < i + 6; k += 1) {
    const c = chars[k];
    if (!c || !/[0-9a-fA-F]/.test(c)) return false;
  }
  return true;
}

function escapeUnit(chars: string[], i: number): number | null {
  const hex = chars.slice(i + 2, i + 6).join('');
  if (hex.length !== 4) return null;
  const n = Number.parseInt(hex, 16);
  return Number.isFinite(n) ? n : null;
}

/** Encode text for SpreadsheetML `<t>` (still needs XML escaping afterwards). */
export function encodeXstring(s: string): string {
  const chars = [...s];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    const code = c.codePointAt(0) ?? 0;
    if (c === '_' && looksLikeEscape(chars, i)) {
      out += '_x005F_';
    } else if (!isXmlChar(code) || (code < 0x20 && code !== 0x9 && code !== 0xa)) {
      // Control chars (except tab/LF) and non-XML chars → _xHHHH_ (BMP unit).
      out += `_x${(code & 0xffff).toString(16).toUpperCase().padStart(4, '0')}_`;
    } else {
      out += c;
    }
  }
  return out;
}

/** Inverse of {@link encodeXstring}, including UTF-16 surrogate pairs. */
export function decodeXstring(s: string): string {
  if (!s.includes('_x')) return s;
  const chars = [...s];
  let out = '';
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '_' && looksLikeEscape(chars, i)) {
      const unit = escapeUnit(chars, i);
      if (unit !== null && unit <= 0x10ffff) {
        if (
          unit >= 0xd800 &&
          unit <= 0xdbff &&
          chars[i + 7] === '_' &&
          looksLikeEscape(chars, i + 7)
        ) {
          const low = escapeUnit(chars, i + 7);
          if (low !== null && low >= 0xdc00 && low <= 0xdfff) {
            out += String.fromCodePoint(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00));
            i += 14;
            continue;
          }
        }
        if (unit !== 0xfffe && unit !== 0xffff && !(unit >= 0xd800 && unit <= 0xdfff)) {
          out += String.fromCodePoint(unit);
          i += 7;
          continue;
        }
      }
    }
    out += chars[i];
    i += 1;
  }
  return out;
}

/** Encode + XML-escape for element text content. */
export function escapeXlsxText(s: string): string {
  // GridCraft also maps bare CR to &#13; after encode.
  return escapeXml(encodeXstring(s)).replace(/\r/g, '&#13;');
}

/** Attribute escaping (double-quoted): encodes whitespace controls as character refs. */
export function escapeXlsxAttr(s: string): string {
  let out = '';
  for (const c of s) {
    const code = c.codePointAt(0) ?? 0;
    if (c === '&') out += '&amp;';
    else if (c === '<') out += '&lt;';
    else if (c === '>') out += '&gt;';
    else if (c === '"') out += '&quot;';
    else if (c === '\n') out += '&#10;';
    else if (c === '\r') out += '&#13;';
    else if (c === '\t') out += '&#9;';
    else if (isXmlChar(code)) out += c;
  }
  return out;
}

/**
 * ISO datetime / time → Excel serial (GridCraft `parse_iso_datetime`).
 * `date1904` selects the 1904 date system.
 */
export function parseIsoDatetimeToSerial(raw: string, date1904 = false): number | null {
  let s = raw.trim();
  if (s.endsWith('Z') || s.endsWith('z')) s = s.slice(0, -1);
  let datePart = '';
  let timePart: string | undefined;
  if (s.includes('T')) {
    const [d, t] = s.split('T');
    datePart = d;
    timePart = t?.split('+')[0];
  } else if (s.includes(':')) {
    timePart = s.split('+')[0];
  } else {
    datePart = s;
  }

  let serial = 0;
  if (datePart) {
    const parts = datePart.split('-').map((p) => Number.parseInt(p, 10));
    if (parts.length < 3) return null;
    const [y, m, d] = parts;
    if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
    const utc = Date.UTC(y, m - 1, d);
    if (date1904) {
      serial = (utc - Date.UTC(1904, 0, 1)) / 86_400_000;
    } else {
      // Match Kyberion / Excel 1900 epoch (1899-12-30), including Excel's leap-year quirk.
      serial = (utc - Date.UTC(1899, 11, 30)) / 86_400_000;
    }
  }
  if (timePart) {
    const tp = timePart.split(':');
    const h = Number.parseFloat(tp[0] ?? '');
    const mi = Number.parseFloat(tp[1] ?? '0');
    const se = Number.parseFloat(tp[2] ?? '0');
    if (!(h >= 0 && h < 24) || !(mi >= 0 && mi < 60) || !(se >= 0 && se < 61)) return null;
    serial += (h * 3600 + mi * 60 + se) / 86400;
  }
  return Number.isFinite(serial) ? serial : null;
}

/** Compute `A1` or `A1:C10` covering every cell ref on the sheet. */
export function computeSheetDimension(
  rows: Array<{ cells: Array<{ ref: string }> }>
): string | undefined {
  let minCol = Infinity;
  let maxCol = -Infinity;
  let minRow = Infinity;
  let maxRow = -Infinity;
  for (const row of rows) {
    for (const cell of row.cells) {
      const m = /^([A-Z]+)(\d+)$/i.exec(cell.ref);
      if (!m) continue;
      const col = colLettersToIndex(m[1].toUpperCase());
      const r = Number.parseInt(m[2], 10);
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (r < minRow) minRow = r;
      if (r > maxRow) maxRow = r;
    }
  }
  if (!Number.isFinite(minCol) || !Number.isFinite(minRow)) return undefined;
  const a = `${indexToColLetters(minCol)}${minRow}`;
  const b = `${indexToColLetters(maxCol)}${maxRow}`;
  return a === b ? a : `${a}:${b}`;
}

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n;
}

function indexToColLetters(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out || 'A';
}
