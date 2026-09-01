// DA-04 acceptance (1): docx/pdf/xlsx/html/slack_thread normalization is
// reproduced by golden tests. All fixtures are built in-test (docx via
// adm-zip, xlsx via exceljs, pdf as embedded base64, html/slack inline) so
// the suite is hermetic; goldens are exact-match and contain no runtime
// timestamps.
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from './parse-document.js';

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

// --- docx fixture: minimal OOXML package built with adm-zip -----------------
const DOCX_CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
const DOCX_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p><w:p><w:r><w:t>Revenue grew steadily.</w:t></w:r></w:p></w:body></w:document>`;

function buildDocxFixture(): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(DOCX_CONTENT_TYPES, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(DOCX_RELS, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(DOCX_DOCUMENT, 'utf8'));
  return zip.toBuffer();
}

// --- pdf fixture: minimal single-page PDF (Helvetica, one text run) ---------
// Base64 of a hand-assembled PDF 1.4 file whose only content stream is
// `BT /F1 12 Tf 72 720 Td (Hello Ingest PDF) Tj ET`.
const PDF_FIXTURE_B64 =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA0NyA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDcyIDcyMCBUZCAoSGVsbG8gSW5nZXN0IFBERikgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMzggMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDgKJSVFT0YK';

// --- xlsx fixture: built with exceljs ---------------------------------------
async function buildXlsxFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Deals');
  sheet.addRow(['Deal', 'Amount']);
  sheet.addRow(['Alpha', 100]);
  sheet.addRow(['Beta', 250]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

// --- html / slack fixtures: inline strings ----------------------------------
const HTML_FIXTURE = [
  '<html><head><title>ignored</title><style>p { color: red; }</style></head><body>',
  '<h1>Release Notes</h1>',
  '<p>See <a href="https://example.com/doc">the doc</a> for <strong>details</strong>.</p>',
  '<ul><li>Item one</li><li>Item two</li></ul>',
  '<ol><li>First</li><li>Second</li></ol>',
  '<table><tr><th>K</th><th>V</th></tr><tr><td>a</td><td>1</td></tr></table>',
  '<pre>code line</pre>',
  '</body></html>',
].join('\n');

const SLACK_FIXTURE = JSON.stringify([
  { user: 'bob', ts: '1722137000.000200', text: 'Second message' },
  { user: 'alice', ts: '1722136000.000100', text: 'First message\nwith continuation' },
  { user: 'carol', ts: '1722138000.000300', text: 'Third' },
]);

describe('ingest:parse_document golden normalization (DA-04 acceptance 1)', () => {
  it('docx → markdown IR (mammoth)', { timeout: 60_000 }, async () => {
    const raw = buildDocxFixture();
    const ir = await parseDocument({
      content_base64: raw.toString('base64'),
      format: 'docx',
      source_meta: { source_system: 'box', source_id: 'FILE-42' },
    });
    expect(ir.text_markdown).toBe('# Quarterly Report\n\nRevenue grew steadily\\.');
    expect(ir.title).toBe('Quarterly Report');
    expect(ir.sections).toEqual([
      { heading: 'Quarterly Report', level: 1, text: 'Revenue grew steadily\\.' },
    ]);
    expect(ir.meta).toEqual({
      source_system: 'box',
      source_id: 'FILE-42',
      format: 'docx',
      content_sha256: sha256(raw),
      char_count: ir.text_markdown.length,
    });
  });

  it('pdf → text IR without page-joiner noise (pdf-parse)', { timeout: 60_000 }, async () => {
    const raw = Buffer.from(PDF_FIXTURE_B64, 'base64');
    const ir = await parseDocument({ content_base64: PDF_FIXTURE_B64, format: 'pdf' });
    expect(ir.text_markdown).toBe('Hello Ingest PDF');
    expect(ir.title).toBeUndefined();
    expect(ir.meta.content_sha256).toBe(sha256(raw));
    expect(ir.meta.format).toBe('pdf');
    expect(ir.meta.char_count).toBe('Hello Ingest PDF'.length);
  });

  it('xlsx → markdown tables per sheet (exceljs)', { timeout: 60_000 }, async () => {
    const raw = await buildXlsxFixture();
    const ir = await parseDocument({ content_base64: raw.toString('base64'), format: 'xlsx' });
    const expectedTable = [
      '| Deal | Amount |',
      '| --- | --- |',
      '| Alpha | 100 |',
      '| Beta | 250 |',
    ].join('\n');
    expect(ir.text_markdown).toBe(`## Deals\n\n${expectedTable}`);
    expect(ir.tables).toEqual([{ name: 'Deals', markdown: expectedTable }]);
    expect(ir.meta.content_sha256).toBe(sha256(raw));
  });

  it('html → conservative markdown (built-in converter; turndown is not vendored)', async () => {
    const ir = await parseDocument({ content_text: HTML_FIXTURE, format: 'html' });
    expect(ir.text_markdown).toBe(
      [
        '# Release Notes',
        '',
        'See [the doc](https://example.com/doc) for **details**.',
        '',
        '- Item one',
        '- Item two',
        '',
        '1. First',
        '2. Second',
        '',
        '| K | V |',
        '| --- | --- |',
        '| a | 1 |',
        '',
        '```',
        'code line',
        '```',
      ].join('\n')
    );
    expect(ir.title).toBe('Release Notes');
    expect(ir.meta.content_sha256).toBe(sha256(Buffer.from(HTML_FIXTURE, 'utf8')));
  });

  it('slack_thread → chronological transcript', async () => {
    const ir = await parseDocument({ content_text: SLACK_FIXTURE, format: 'slack_thread' });
    expect(ir.text_markdown).toBe(
      [
        '- **alice** [1722136000.000100]: First message',
        '  with continuation',
        '- **bob** [1722137000.000200]: Second message',
        '- **carol** [1722138000.000300]: Third',
      ].join('\n')
    );
    expect(ir.meta.content_sha256).toBe(sha256(Buffer.from(SLACK_FIXTURE, 'utf8')));
  });

  it('markdown passthrough extracts the title from the first heading', async () => {
    const ir = await parseDocument({ content_text: '# Notes\n\nBody text\n', format: 'markdown' });
    expect(ir.text_markdown).toBe('# Notes\n\nBody text');
    expect(ir.title).toBe('Notes');
  });

  it('rejects input without any content source', async () => {
    await expect(parseDocument({ format: 'text' })).rejects.toThrow(
      /source_path, content_base64 or content_text/
    );
  });

  it('rejects a source path outside the repository before reading it', async () => {
    await expect(
      parseDocument({ source_path: '/tmp/external-ingest-source.txt', format: 'text' })
    ).rejects.toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects malformed slack_thread payloads', async () => {
    await expect(
      parseDocument({ content_text: '{"not":"an array"}', format: 'slack_thread' })
    ).rejects.toThrow(/JSON array/);
  });
});
