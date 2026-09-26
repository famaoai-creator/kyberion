import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { READ_USAGE, runReadCommand } from './cli-read.js';

describe('pnpm kyberion read', () => {
  let workDir = '';
  let xlsxPath = '';

  beforeAll(async () => {
    workDir = pathResolver.sharedTmp(`cli-read-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Deals');
    sheet.addRow(['Deal', 'Amount']);
    sheet.addRow(['Alpha', 100]);
    xlsxPath = path.join(workDir, 'deals.xlsx');
    safeWriteFile(xlsxPath, Buffer.from(await workbook.xlsx.writeBuffer()));
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('prints Markdown for a repository file', async () => {
    const output: string[] = [];
    await runReadCommand([path.relative(pathResolver.rootDir(), xlsxPath)], (text) =>
      output.push(text)
    );
    expect(output.join('\n')).toContain('| Alpha | 100 |');
  });

  it('prints JSON and writes --out files', async () => {
    const out = path.join(workDir, 'deals.json');
    const output: string[] = [];
    await runReadCommand([xlsxPath, '--json', '--out', out], (text) => output.push(text));
    const written = JSON.parse(String(safeReadFile(out, { encoding: 'utf8' })));
    expect(written.format).toBe('xlsx');
    expect(written.tables[0].name).toBe('Deals');
    expect(output.join('\n')).toMatch(/\[read\] wrote/);
  });

  it('writes embedded images with --images and lists where each came from', async () => {
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    const ns =
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    zip.addFile(
      'ppt/presentation.xml',
      Buffer.from(
        `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`
      )
    );
    zip.addFile(
      'ppt/_rels/presentation.xml.rels',
      Buffer.from(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${rel}/slide" Target="slides/slide1.xml"/></Relationships>`
      )
    );
    zip.addFile(
      'ppt/slides/slide1.xml',
      Buffer.from(
        `<p:sld ${ns}><p:cSld><p:spTree><p:pic><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>`
      )
    );
    zip.addFile(
      'ppt/slides/_rels/slide1.xml.rels',
      Buffer.from(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="${rel}/image" Target="../media/image1.png"/></Relationships>`
      )
    );
    zip.addFile('ppt/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const deck = path.join(workDir, 'deck.pptx');
    safeWriteFile(deck, zip.toBuffer());
    const imagesDir = path.join(workDir, 'images');
    const output: string[] = [];
    const result = await runReadCommand([deck, '--images', imagesDir], (text) => output.push(text));
    expect(result?.images).toEqual([
      {
        location: 'slide 1',
        source: 'ppt/media/image1.png',
        path: path.join(imagesDir, 'slide-1-image1.png'),
      },
    ]);
    expect(safeReadFile(path.join(imagesDir, 'slide-1-image1.png'), { encoding: null })).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
    expect(output.join('\n')).toContain('[read] 1 image(s) written to');
  });

  it('refuses files outside the repository with the copy-in instruction', async () => {
    await expect(runReadCommand(['/Users/someone/Downloads/deck.pptx'], () => {})).rejects.toThrow(
      /outside the repository[\s\S]*active\/shared\/tmp/
    );
  });

  it('reads html files as Markdown', async () => {
    const html = path.join(workDir, 'page.html');
    safeWriteFile(
      html,
      '<html><head><title>Page</title></head><body><p>Hello <b>there</b></p></body></html>'
    );
    const output: string[] = [];
    await runReadCommand([html], (text) => output.push(text));
    expect(output.join('\n')).toBe('# Page\n\nHello **there**');
  });

  it('refuses URLs with a pointer to the governed fetch path', async () => {
    await expect(runReadCommand(['https://example.com/a.html'], () => {})).rejects.toThrow(
      /is a URL[\s\S]*network:fetch/
    );
  });

  it('refuses unsupported types and prints usage without a file', async () => {
    const csv = path.join(workDir, 'data.csv');
    safeWriteFile(csv, 'a,b');
    await expect(runReadCommand([csv], () => {})).rejects.toThrow(/unsupported file type/);
    await expect(runReadCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion read/);
    const output: string[] = [];
    await runReadCommand(['--help'], (text) => output.push(text));
    expect(output[0]).toBe(READ_USAGE);
  });
});
