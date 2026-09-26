import { describe, expect, it } from 'vitest';
import { formatGeneralNumber, formatXlsxNumber } from './xlsx-number-format.js';

describe('formatXlsxNumber', () => {
  it('renders General like Excel: integers as-is, fractions to 10 significant digits', () => {
    expect(formatGeneralNumber(1234567)).toBe('1234567');
    expect(formatGeneralNumber(0.334794339836785)).toBe('0.3347943398');
    expect(formatXlsxNumber(0.334794339836785, 'General')).toBe('0.3347943398');
    expect(formatXlsxNumber(12.5, undefined)).toBe('12.5');
  });

  it('applies percent, decimals and thousands separators', () => {
    expect(formatXlsxNumber(0.334794339836785, '0.0%')).toBe('33.5%');
    expect(formatXlsxNumber(0.21, '0%')).toBe('21%');
    expect(formatXlsxNumber(1234567, '#,##0')).toBe('1,234,567');
    expect(formatXlsxNumber(1234567.891, '#,##0.00')).toBe('1,234,567.89');
    expect(formatXlsxNumber(0.5, '0.00')).toBe('0.50');
    expect(formatXlsxNumber(2.1, '#,##0.0#')).toBe('2.1');
    expect(formatXlsxNumber(1234567, '#,##0,')).toBe('1,235');
  });

  it('uses the negative section (▲, parentheses) and a sign otherwise', () => {
    expect(formatXlsxNumber(-28957, '#,##0;"▲"#,##0')).toBe('▲28,957');
    expect(formatXlsxNumber(-28957, '#,##0;[Red]\\(#,##0\\)')).toBe('(28,957)');
    expect(formatXlsxNumber(-1234.5, '#,##0.0')).toBe('-1,234.5');
    expect(formatXlsxNumber(0, '#,##0;▲#,##0;"-"')).toBe('-');
  });

  it('keeps currency tags and literal text', () => {
    expect(formatXlsxNumber(8253575, '[$¥-411]#,##0')).toBe('¥8,253,575');
    expect(formatXlsxNumber(41593, '#,##0"千円"')).toBe('41,593千円');
    expect(formatXlsxNumber(1500, '#,##0_);\\(#,##0\\)')).toBe('1,500');
  });

  it('renders Excel serial dates and times', () => {
    expect(formatXlsxNumber(46173, 'yyyy/mm/dd')).toBe('2026/05/31');
    expect(formatXlsxNumber(46173, 'yyyy"年"m"月"d"日"')).toBe('2026年5月31日');
    expect(formatXlsxNumber(46173.5, 'yyyy-mm-dd hh:mm')).toBe('2026-05-31 12:00');
    expect(formatXlsxNumber(0.75, 'h:mm AM/PM')).toBe('6:00 PM');
  });

  it('never throws on formats it does not understand', () => {
    expect(formatXlsxNumber(3.14159, '[>=100]0;0.00')).toBeTypeOf('string');
    expect(formatXlsxNumber(42, '@')).toBe('42');
  });
});
