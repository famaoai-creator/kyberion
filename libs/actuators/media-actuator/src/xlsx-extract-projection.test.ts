import { describe, expect, it } from 'vitest';
import { colLettersToNum, parseA1Range, projectXlsxDesign, unwrapCellValue } from './xlsx-extract-projection.js';

const design = {
  version: '1.0.0',
  sheets: [
    {
      name: 'Sheet1',
      rows: [
        { index: 1, cells: [{ ref: 'A1', value: 'hdr' }, { ref: 'C1', value: 60 }, { ref: 'AF1', value: 'total' }] },
        { index: 5, cells: [{ ref: 'C5', value: 0 }, { ref: 'D5', value: 100 }, { ref: 'AF5', value: { formula: 'SUM', result: 100 } }] },
        { index: 6, cells: [{ ref: 'C6', value: '' }, { ref: 'D6', value: null }] },
      ],
    },
    { name: '2410', rows: [{ index: 1, cells: [{ ref: 'A1', value: 'x' }] }] },
  ],
};

describe('xlsx-extract-projection helpers', () => {
  it('colLettersToNum maps A1 columns', () => {
    expect(colLettersToNum('A')).toBe(1);
    expect(colLettersToNum('C')).toBe(3);
    expect(colLettersToNum('AF')).toBe(32);
  });

  it('parseA1Range handles cell, row-only, and col-only ranges', () => {
    expect(parseA1Range('C55:AF66')).toEqual({ colStart: 3, colEnd: 32, rowStart: 55, rowEnd: 66 });
    expect(parseA1Range('5:6')).toMatchObject({ rowStart: 5, rowEnd: 6 });
    expect(parseA1Range('C:AF')).toMatchObject({ colStart: 3, colEnd: 32 });
    expect(parseA1Range(undefined)).toBeNull();
  });

  it('unwrapCellValue reduces formula and rich text values to scalars', () => {
    expect(unwrapCellValue({ formula: 'SUM', result: 42 })).toBe(42);
    expect(unwrapCellValue({ richText: [{ text: 'a' }, { text: 'b' }] })).toBe('ab');
    expect(unwrapCellValue(7)).toBe(7);
  });
});

describe('projectXlsxDesign', () => {
  it('emits values keyed by column letter and drops empty cells', () => {
    const out = projectXlsxDesign(design, { valuesOnly: true });
    const sheet = out.sheets.find((s: any) => s.name === 'Sheet1');
    expect(sheet.rows).toEqual([
      { row: 1, cells: { A: 'hdr', C: 60, AF: 'total' } },
      { row: 5, cells: { C: 0, D: 100, AF: 100 } },
    ]);
  });

  it('filters to one sheet', () => {
    const out = projectXlsxDesign(design, { sheet: 'Sheet1' });
    expect(out.sheets).toHaveLength(1);
    expect(out.sheets[0].name).toBe('Sheet1');
  });

  it('filters by A1 range', () => {
    const out = projectXlsxDesign(design, { sheet: 'Sheet1', range: 'D5:AF5' });
    expect(out.sheets[0].rows).toEqual([{ row: 5, cells: { D: 100, AF: 100 } }]);
  });

  it('skipZero drops zero-valued cells', () => {
    const out = projectXlsxDesign(design, { sheet: 'Sheet1', skipZero: true });
    const row5 = out.sheets[0].rows.find((r: any) => r.row === 5);
    expect(row5.cells).toEqual({ D: 100, AF: 100 });
  });

  it('records extraction metadata', () => {
    const out = projectXlsxDesign(design, { sheet: 'Sheet1', range: '5:6', valuesOnly: true, skipZero: true });
    expect(out.extracted).toEqual({ sheet: 'Sheet1', range: '5:6', values_only: true, skip_zero: true });
  });
});
