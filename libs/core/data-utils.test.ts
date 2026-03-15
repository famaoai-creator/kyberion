import { describe, expect, it } from 'vitest';
import { detectFormat, parseData, stringifyData } from './data-utils.js';

describe('data-utils', () => {
  it('detects supported file formats', () => {
    expect(detectFormat('report.json')).toBe('json');
    expect(detectFormat('report.yaml')).toBe('yaml');
    expect(detectFormat('report.csv')).toBe('csv');
  });

  it('throws for unsupported file formats', () => {
    expect(() => detectFormat('report.txt')).toThrow('Unsupported file extension: .txt');
  });

  it('parses and stringifies json', () => {
    const parsed = parseData('{"ok":true}', 'json');
    expect(parsed).toEqual({ ok: true });
    expect(stringifyData(parsed, 'json')).toContain('"ok": true');
  });

  it('parses and stringifies yaml', () => {
    const parsed = parseData('name: kyberion', 'yaml');
    expect(parsed).toEqual({ name: 'kyberion' });
    expect(stringifyData(parsed, 'yaml')).toContain('name: kyberion');
  });

  it('parses and stringifies csv', () => {
    const parsed = parseData('name,score\nkyberion,10\n', 'csv');
    expect(parsed).toEqual([{ name: 'kyberion', score: '10' }]);
    expect(stringifyData(parsed, 'csv')).toContain('name,score');
  });

  it('wraps parser and stringifier errors', () => {
    expect(() => parseData('{', 'json')).toThrow('Failed to parse json');
    expect(() => stringifyData(1n as unknown as object, 'json')).toThrow('Failed to stringify json');
  });
});
