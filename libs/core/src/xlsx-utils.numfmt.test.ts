import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { distillXlsxDesign } from './xlsx-utils.js';

describe('distillXlsxDesign number formats', () => {
  it('decodes XML-escaped format codes (quotes, ampersands) to the real code', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('S');
    sheet.getCell('A1').value = -1;
    sheet.getCell('A1').numFmt = '#,##0;"▲"#,##0';
    sheet.getCell('A2').value = 1;
    sheet.getCell('A2').numFmt = '0"円"&"税込"';
    const design = await distillXlsxDesign(Buffer.from(await workbook.xlsx.writeBuffer()));
    const codes = design.styles.numFmts.map((format) => format.formatCode);
    expect(codes).toContain('#,##0;"▲"#,##0');
    expect(codes).toContain('0"円"&"税込"');
    expect(codes.some((code) => code.includes('&quot;') || code.includes('&amp;'))).toBe(false);
  });
});
