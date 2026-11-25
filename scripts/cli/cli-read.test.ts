import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { pathResolver, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core';
import { READ_USAGE, runReadCommand } from './cli-read.js';

// Only the transport is stubbed — the governed wiring around it
// (runExternalOperation admission, user-origin attestation, assertNetworkEgress
// on the entry URL and every redirect hop) runs for real.
vi.mock('@agent/core/network', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent/core/network')>();
  return { ...actual, secureFetch: vi.fn(actual.secureFetch) };
});

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

  it('reads http(s) URLs through the governed fetch boundary', async () => {
    const fetched: string[] = [];
    const output: string[] = [];
    await runReadCommand(['https://example.com/page.html'], (text) => output.push(text), {
      fetchUrl: async (url) => {
        fetched.push(url);
        return Buffer.from(
          '<html><head><title>Remote</title></head><body><p>Hello <b>web</b></p></body></html>'
        );
      },
    });
    expect(fetched).toEqual(['https://example.com/page.html']);
    expect(output.join('\n')).toBe('# Remote\n\nHello **web**');
  });

  it('sniffs html content when the URL has no extension', async () => {
    const output: string[] = [];
    const result = await runReadCommand(
      ['https://example.com/articles/7/aoto/'],
      (text) => output.push(text),
      { fetchUrl: async () => Buffer.from('<html><body><p>Hi</p></body></html>') }
    );
    expect(result?.format).toBe('html');
    expect(output.join('\n')).toContain('Hi');
  });

  it('refuses Office-zip URLs without an extension and names the save-and-read path', async () => {
    await expect(
      runReadCommand(['https://example.com/download'], () => {}, {
        fetchUrl: async () => Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]),
      })
    ).rejects.toThrow(/Office document[\s\S]*active\/shared\/tmp/);
  });

  it('classifies URL fetch failures into the error contract', async () => {
    const { SecureFetchError } = await import('@agent/core/network');
    const cases: Array<[Error, string]> = [
      [new Error('Unsupported protocol: file:'), 'INVALID_INPUT'],
      [new Error('Blocked URL: localhost'), 'OUTSIDE_ALLOWED_SCOPE'],
      [new Error('[NETWORK_POLICY_VIOLATION] host denied'), 'OUTSIDE_ALLOWED_SCOPE'],
      [new Error('[SANDBOX_NETWORK_DENIED] sandbox blocked'), 'OUTSIDE_ALLOWED_SCOPE'],
      [new Error('[POLICY_BLOCKED] operation denied'), 'OUTSIDE_ALLOWED_SCOPE'],
      [new SecureFetchError('Network Error: not found (404)', 404), 'NOT_FOUND'],
      [new SecureFetchError('Network Error: boom (503)', 503), 'FETCH_FAILED'],
    ];
    for (const [cause, code] of cases) {
      await expect(
        runReadCommand(['https://example.com/x'], () => {}, {
          fetchUrl: async () => {
            throw cause;
          },
        })
      ).rejects.toMatchObject({ details: expect.objectContaining({ code }) });
    }
  });

  it('wires the default fetch through the governed secureFetch boundary', async () => {
    const { secureFetch } = await import('@agent/core/network');
    const mocked = vi.mocked(secureFetch);
    mocked.mockClear();
    mocked.mockResolvedValue(
      new TextEncoder().encode('<html><body><p>wired</p></body></html>').buffer as ArrayBuffer
    );
    const output: string[] = [];
    await runReadCommand(['https://example.com/wired'], (text) => output.push(text));
    expect(output.join('\n')).toContain('wired');
    expect(mocked).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/wired',
        method: 'GET',
        responseType: 'arraybuffer',
      })
    );
    // Redirect re-validation: a hop to a private-network host must be denied
    // through the same egress gate instead of being followed blindly.
    const request = mocked.mock.calls[0]?.[0] as {
      beforeRedirect: (options: Record<string, unknown>) => void;
    };
    expect(() => request.beforeRedirect({ href: 'http://127.0.0.1/meta' })).toThrow();
    expect(() => request.beforeRedirect({ href: 'https://example.com/next' })).not.toThrow();
  });

  it('reads csv/json text-native files and refuses unknown types', async () => {
    const csv = path.join(workDir, 'data.csv');
    safeWriteFile(csv, 'Name,Score\nAlpha,10\n');
    const csvOut: string[] = [];
    await runReadCommand([csv], (text) => csvOut.push(text));
    expect(csvOut.join('\n')).toContain('| Alpha | 10 |');

    const json = path.join(workDir, 'payload.json');
    safeWriteFile(json, '{"ok":true}');
    const jsonOut: string[] = [];
    await runReadCommand([json], (text) => jsonOut.push(text));
    expect(jsonOut.join('\n')).toContain('"ok": true');

    const unknown = path.join(workDir, 'blob.bin');
    safeWriteFile(unknown, 'x');
    await expect(runReadCommand([unknown], () => {})).rejects.toThrow(/unsupported file type/);
    await expect(runReadCommand([], () => {})).rejects.toThrow(/Usage: pnpm kyberion read/);
    const output: string[] = [];
    await runReadCommand(['--help'], (text) => output.push(text));
    expect(output[0]).toBe(READ_USAGE);
  });
});
