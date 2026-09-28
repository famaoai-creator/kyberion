/**
 * Render an xlsx cell's numeric value the way Excel displays it, from the
 * cell's number-format code — so a reader sees `33.5%`, `1,234,567`, `▲28,957`
 * or `2026-05-31` instead of `0.334794339836785`, `1234567`, `-28957` or
 * `46173`.
 *
 * A pragmatic subset of ECMA-376 §18.8.31: sections (pos;neg;zero), percent,
 * thousands separators, decimal places, quoted / escaped literals, currency
 * tags (`[$¥-411]`), colour / condition tags, and date-time tokens
 * (y, m, d, h, s, AM/PM). Anything it does not understand falls back to the
 * General rendering, never to an exception.
 */

/** Excel serial date epoch (1900 system, including the 1900-02-29 bug). */
const EXCEL_EPOCH_UTC = Date.UTC(1899, 11, 30);

/** General format: integers as-is, fractions to 10 significant digits. */
export function formatGeneralNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toPrecision(10)));
}

function splitSections(code: string): string[] {
  const sections: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '"') quoted = !quoted;
    if (ch === '\\' && !quoted) {
      current += ch + (code[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (ch === ';' && !quoted) {
      sections.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  sections.push(current);
  return sections;
}

interface Token {
  literal?: string;
  pattern?: string;
}

/** Split a section into literal text and format pattern characters. */
function tokenize(section: string): Token[] {
  const tokens: Token[] = [];
  const pushLiteral = (text: string) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last?.literal !== undefined) last.literal += text;
    else tokens.push({ literal: text });
  };
  const pushPattern = (text: string) => {
    const last = tokens[tokens.length - 1];
    if (last?.pattern !== undefined) last.pattern += text;
    else tokens.push({ pattern: text });
  };
  for (let i = 0; i < section.length; i += 1) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      pushLiteral(section.slice(i + 1, end === -1 ? undefined : end));
      i = end === -1 ? section.length : end;
    } else if (ch === '\\') {
      pushLiteral(section[i + 1] ?? '');
      i += 1;
    } else if (ch === '[') {
      const end = section.indexOf(']', i);
      const tag = section.slice(i + 1, end === -1 ? undefined : end);
      // [$¥-411] → "¥"; colour / condition / locale tags carry no text.
      const currency = /^\$([^-\]]*)/.exec(tag)?.[1];
      if (currency) pushLiteral(currency);
      else if (/^(h+|m+|s+)$/i.test(tag)) pushPattern(`[${tag}]`); // elapsed time
      i = end === -1 ? section.length : end;
    } else if (ch === '_') {
      pushLiteral(' '); // "_x" reserves the width of x
      i += 1;
    } else if (ch === '*') {
      i += 1; // "*x" fills with x — nothing to render in text
    } else if (/[0#?.,%eE+\-/:ymdhsAaPpMm]/.test(ch) || /^General/i.test(section.slice(i))) {
      if (/^General/i.test(section.slice(i))) {
        pushPattern('General');
        i += 'General'.length - 1;
      } else pushPattern(ch);
    } else {
      pushLiteral(ch);
    }
  }
  return tokens;
}

function isDatePattern(pattern: string): boolean {
  return /[yd]|h|s|(?<![#0?.,])m/i.test(pattern.replace(/General/gi, '')) && !/[0#?]/.test(pattern);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function formatDate(serial: number, pattern: string): string {
  const millis = EXCEL_EPOCH_UTC + Math.round(serial * 86_400_000);
  const date = new Date(millis);
  const hasAmPm = /AM\/PM|A\/P/i.test(pattern);
  let out = '';
  let previousWasHour = false;
  for (let i = 0; i < pattern.length;) {
    const rest = pattern.slice(i);
    const run = /^(y+|m+|d+|h+|s+|AM\/PM|A\/P|\[h+\]|\[m+\]|\[s+\])/i.exec(rest);
    if (!run) {
      out += pattern[i];
      i += 1;
      continue;
    }
    const token = run[0];
    const lower = token.toLowerCase();
    i += token.length;
    const hours = date.getUTCHours();
    if (lower.startsWith('y')) {
      out +=
        lower.length <= 2 ? pad(date.getUTCFullYear() % 100, 2) : String(date.getUTCFullYear());
      previousWasHour = false;
    } else if (lower.startsWith('m') && !lower.startsWith('[')) {
      // "m" after an hour (or before seconds) means minutes.
      const minutes = previousWasHour || /^[^ymdh]*s/i.test(pattern.slice(i));
      const value = minutes ? date.getUTCMinutes() : date.getUTCMonth() + 1;
      out += lower.length >= 2 ? pad(value, 2) : String(value);
      previousWasHour = false;
    } else if (lower.startsWith('d')) {
      out += lower.length >= 2 ? pad(date.getUTCDate(), 2) : String(date.getUTCDate());
      previousWasHour = false;
    } else if (lower.startsWith('h')) {
      const value = hasAmPm ? hours % 12 || 12 : hours;
      out += lower.length >= 2 ? pad(value, 2) : String(value);
      previousWasHour = true;
    } else if (lower.startsWith('s')) {
      out += lower.length >= 2 ? pad(date.getUTCSeconds(), 2) : String(date.getUTCSeconds());
    } else if (lower === 'am/pm') {
      out += hours < 12 ? 'AM' : 'PM';
    } else if (lower === 'a/p') {
      out += hours < 12 ? 'A' : 'P';
    } else if (lower.startsWith('[h')) {
      out += String(Math.floor(serial * 24));
      previousWasHour = true;
    } else {
      out += token;
    }
  }
  return out;
}

function formatNumberPattern(value: number, pattern: string): string {
  if (/General/i.test(pattern)) return formatGeneralNumber(value);
  const percentCount = (pattern.match(/%/g) || []).length;
  let scaled = value * 100 ** percentCount;
  const numeric = pattern.replace(/%/g, '');
  if (/[eE][+-]/.test(numeric)) {
    const decimals = (/\.([0#?]+)/.exec(numeric)?.[1] ?? '').length;
    return scaled.toExponential(decimals).replace('e', 'E') + '%'.repeat(percentCount);
  }
  const [integerPart, fractionPart = ''] = numeric.split('.');
  // Trailing commas after the last digit scale by 1000 each.
  const trailingCommas = /,+$/.exec(integerPart.replace(/[^0#?,]/g, ''))?.[0].length ?? 0;
  scaled /= 1000 ** trailingCommas;
  const decimals = (fractionPart.match(/[0#?]/g) || []).length;
  const requiredDecimals = (fractionPart.match(/0/g) || []).length;
  const grouping = /[0#?],[0#?]/.test(integerPart);
  const minIntegerDigits = (integerPart.match(/0/g) || []).length;
  let text = Math.abs(scaled).toFixed(decimals);
  let [intText, fracText = ''] = text.split('.');
  // Optional (#) decimals drop trailing zeros beyond the required ones.
  if (decimals > requiredDecimals) {
    fracText = fracText.replace(/0+$/, '');
    if (fracText.length < requiredDecimals) fracText = fracText.padEnd(requiredDecimals, '0');
  }
  if (minIntegerDigits === 0 && intText === '0' && fracText) intText = '';
  else intText = intText.padStart(minIntegerDigits, '0');
  if (grouping) intText = intText.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  text = fracText ? `${intText}.${fracText}` : intText;
  return text + '%'.repeat(percentCount);
}

/**
 * Format a numeric cell value with its number-format code. Returns the
 * General rendering when the code is empty, "General" or not understood.
 */
export function formatXlsxNumber(value: number, formatCode: string | undefined): string {
  if (!Number.isFinite(value)) return String(value);
  const code = String(formatCode ?? '').trim();
  if (!code || /^General$/i.test(code) || code === '@') return formatGeneralNumber(value);
  try {
    const sections = splitSections(code);
    let section = sections[0];
    let negativeHandled = false;
    if (value < 0 && sections.length >= 2 && sections[1].trim()) {
      section = sections[1];
      negativeHandled = true; // the negative section spells its own sign (▲, -, parentheses)
    } else if (value === 0 && sections.length >= 3 && sections[2].trim()) {
      section = sections[2];
    }
    const tokens = tokenize(section);
    const pattern = tokens.map((token) => token.pattern ?? '').join('');
    if (!pattern) {
      return tokens.map((token) => token.literal ?? '').join('') || formatGeneralNumber(value);
    }
    const date = isDatePattern(pattern);
    if (date) {
      // Dates interleave literals with tokens ("yyyy年m月d日"): keep each
      // literal in place behind a marker the date formatter passes through.
      const literals: string[] = [];
      const composed = tokens
        .map((token) =>
          token.pattern !== undefined
            ? token.pattern
            : `\u0001${literals.push(token.literal ?? '') - 1}\u0002`
        )
        .join('');
      return formatDate(value, composed).replace(
        /\u0001(\d+)\u0002/g,
        (_marker, index: string) => literals[Number(index)] ?? ''
      );
    }
    let rendered = '';
    let numberWritten = false;
    for (const token of tokens) {
      if (token.literal !== undefined) {
        rendered += token.literal;
      } else if (!numberWritten) {
        const allPatterns = tokens
          .filter((t) => t.pattern !== undefined)
          .map((t) => t.pattern)
          .join('');
        rendered += formatNumberPattern(negativeHandled ? Math.abs(value) : value, allPatterns);
        numberWritten = true;
      }
    }
    if (value < 0 && !negativeHandled && !/^-/.test(rendered)) rendered = `-${rendered}`;
    return rendered.trim() || formatGeneralNumber(value);
  } catch {
    return formatGeneralNumber(value);
  }
}
