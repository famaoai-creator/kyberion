import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { pathResolver, safeMkdir, safeRmSync, safeWriteFile } from '@agent/core';
import { generateNativeDocx } from '@agent/core/media-contracts';
import { distillXlsxDesign } from '@agent/core/xlsx-utils';
import type { DocxDesignProtocol } from '@agent/core/types/docx-protocol';
import { diffDesigns, runDiffCommand, DIFF_USAGE } from './cli-diff.js';

function makeDocxProtocol(text: string): DocxDesignProtocol {
  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    theme: { colors: {} },
    styles: { definitions: [] },
    body: [
      {
        type: 'paragraph',
        paragraph: {
          content: [{ type: 'run', run: { content: [{ type: 'text', text }] } }],
        },
      },
    ],
    sections: [],
    headersFooters: [],
    relationships: [],
  };
}

describe('pnpm kyberion diff', () => {
  let workDir = '';
  let docxA = '';
  let docxB = '';
  let docxC = '';
  let xlsxA = '';
  let xlsxB = '';

  beforeAll(async () => {
    workDir = pathResolver.sharedTmp(`cli-diff-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    docxA = path.join(workDir, 'a.docx');
    docxB = path.join(workDir, 'b.docx');
    docxC = path.join(workDir, 'c.docx');
    await generateNativeDocx(makeDocxProtocol('same text'), docxA);
    await generateNativeDocx(makeDocxProtocol('same text'), docxB);
    await generateNativeDocx(makeDocxProtocol('different text'), docxC);

    const makeXlsx = async (rows: string[][]) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('S');
      rows.forEach((row) => sheet.addRow(row));
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };
    xlsxA = path.join(workDir, 'a.xlsx');
    xlsxB = path.join(workDir, 'b.xlsx');
    safeWriteFile(
      xlsxA,
      await makeXlsx([
        ['K', 'V'],
        ['a', '1'],
      ])
    );
    safeWriteFile(
      xlsxB,
      await makeXlsx([
        ['K', 'V'],
        ['a', '2'],
      ])
    );
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  const rel = (absolute: string) => path.relative(pathResolver.rootDir(), absolute);

  it('reports identical designs for equal docx files', async () => {
    const output: string[] = [];
    const result = await runDiffCommand([rel(docxA), rel(docxB)], (text) => output.push(text));
    expect(result?.identical).toBe(true);
    expect(result?.diff_count).toBe(0);
    expect(output.join('\n')).toContain('designs identical');
  });

  it('reports the changed body block for a modified docx', async () => {
    const output: string[] = [];
    const result = await runDiffCommand([rel(docxA), rel(docxC)], (text) => output.push(text));
    expect(result?.identical).toBe(false);
    expect(result?.diffs.some((entry) => entry.path.startsWith('body[0]'))).toBe(true);
  });

  it('diffs xlsx designs and reports cell differences', async () => {
    const result = await runDiffCommand([rel(xlsxA), rel(xlsxB), '--json'], () => undefined);
    expect(result?.format).toBe('.xlsx');
    expect(result?.identical).toBe(false);
    expect(result?.diff_count).toBeGreaterThan(0);
  });

  it('emits machine-readable JSON', async () => {
    const output: string[] = [];
    await runDiffCommand([rel(docxA), rel(docxC), '--json'], (text) => output.push(text));
    const parsed = JSON.parse(output.join(''));
    expect(parsed.format).toBe('.docx');
    expect(parsed.identical).toBe(false);
    expect(Array.isArray(parsed.diffs)).toBe(true);
  });

  it('ignores volatile keys and reorders keyed arrays by identity', async () => {
    const a = {
      generatedAt: '2026-01-01T00:00:00Z',
      relationships: [
        { id: 'rId1', type: 'styles', target: 'styles.xml' },
        { id: 'rId8', type: 'footer', target: 'footer1.xml' },
      ],
      parts: [{ path: 'word/settings.xml', content: 'x' }],
    };
    const b = {
      generatedAt: '2026-09-26T00:00:00Z',
      relationships: [
        // footer first, styles renumbered — order and bare id are not fidelity
        { id: 'rId8', type: 'footer', target: 'footer1.xml' },
        { id: 'rId2', type: 'styles', target: 'styles.xml' },
      ],
      parts: [{ path: 'word/settings.xml', content: 'x' }],
    };
    const result = await diffDesigns(a, b, { format: '.docx', fileA: 'a.docx', fileB: 'b.docx' });
    expect(result.identical).toBe(true);
  });

  it('extracts an empty shared-string cell as empty, not as its SST index', async () => {
    // Crafted package: B1 references sharedStrings[1] which is ''.
    const { default: JSZip } = await import('jszip');
    const NS = 'http://schemas.openxmlformats.org';
    const zip = new JSZip();
    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0"?><Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`
    );
    zip.file(
      '_rels/.rels',
      `<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    );
    zip.file(
      'xl/workbook.xml',
      `<workbook xmlns="${NS}/spreadsheetml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<Relationships xmlns="${NS}/package/2006/relationships"><Relationship Id="rId1" Type="${NS}/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS}/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
    );
    zip.file(
      'xl/sharedStrings.xml',
      `<sst xmlns="${NS}/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>alpha</t></si><si><t></t></si></sst>`
    );
    zip.file(
      'xl/worksheets/sheet1.xml',
      `<worksheet xmlns="${NS}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row></sheetData></worksheet>`
    );
    const filePath = path.join(workDir, 'empty-sst.xlsx');
    safeWriteFile(filePath, await zip.generateAsync({ type: 'nodebuffer' }));
    const design = await distillXlsxDesign(filePath);
    const cells = design.sheets[0].rows[0].cells;
    expect(cells.find((c: any) => c.ref === 'A1')?.value).toBe('alpha');
    expect(cells.find((c: any) => c.ref === 'B1')?.value).toBe('');
  });

  it('shows usage when called without files', async () => {
    const output: string[] = [];
    await expect(runDiffCommand([], (text) => output.push(text))).rejects.toThrow();
    expect(DIFF_USAGE).toContain('pnpm kyberion diff');
  });
});
