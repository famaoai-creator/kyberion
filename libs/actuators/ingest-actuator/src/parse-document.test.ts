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

// --- pptx fixture: minimal PresentationML package built with adm-zip -------
// Two slides listed in reverse file order (deck order ≠ file numbering), a
// multi-paragraph shape, a table, an image and speaker notes.
const PML_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const pptxShape = (paragraphs: string[]) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs
    .map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`)
    .join('')}</p:txBody></p:sp>`;
const pptxCell = (text: string) =>
  `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
const pptxSlide = (body: string) =>
  `<p:sld ${PML_NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;

function buildPptxFixture(): Buffer {
  const zip = new AdmZip();
  const add = (name: string, xml: string) => zip.addFile(name, Buffer.from(xml, 'utf8'));
  add(
    'ppt/presentation.xml',
    `<p:presentation ${PML_NS}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst></p:presentation>`
  );
  add(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships ${REL_NS}><Relationship Id="rId2" Type="${REL_TYPE}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL_TYPE}/slide" Target="slides/slide2.xml"/></Relationships>`
  );
  add('ppt/slides/slide2.xml', pptxSlide(pptxShape(['Board Meeting'])));
  add(
    'ppt/slides/slide1.xml',
    pptxSlide(
      pptxShape(['Results', 'Revenue up']) +
        `<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tr h="1">${pptxCell('Item')}${pptxCell('Amount')}</a:tr><a:tr h="1">${pptxCell('Sales')}${pptxCell('41,593')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>` +
        '<p:pic><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill></p:pic>'
    )
  );
  add(
    'ppt/slides/_rels/slide1.xml.rels',
    `<Relationships ${REL_NS}><Relationship Id="rIdImg" Type="${REL_TYPE}/image" Target="../media/image1.png"/><Relationship Id="rIdN" Type="${REL_TYPE}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`
  );
  zip.addFile('ppt/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  add(
    'ppt/notesSlides/notesSlide1.xml',
    `<p:notes ${PML_NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="3" name="N"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Mention the Q2 close</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`
  );
  return zip.toBuffer();
}

// --- real-world docx/xlsx shapes: line breaks, tables, pictures, merges ----
const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const wCell = (text: string) => `<w:tc><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;

function buildRichDocxFixture(): Buffer {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(DOCX_CONTENT_TYPES, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(DOCX_RELS, 'utf8'));
  zip.addFile(
    'word/_rels/document.xml.rels',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
      'utf8'
    )
  );
  zip.addFile('word/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>` +
        '<w:p><w:r><w:t>1. Summary</w:t></w:r><w:r><w:br/><w:t>Outage lasted 31 minutes.</w:t></w:r></w:p>' +
        `<w:tbl><w:tr>${wCell('Time')}${wCell('Event')}</w:tr><w:tr>${wCell('0:32')}${wCell('Stopped | rolled back')}</w:tr></w:tbl>` +
        '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="100" cy="100"/><wp:docPr id="1" name="Figure 1"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
        '</w:body></w:document>',
      'utf8'
    )
  );
  return zip.toBuffer();
}

async function buildRichXlsxFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Schedule');
  sheet.addRow(['Split schedule', '', '']);
  sheet.mergeCells('A1:C1');
  sheet.addRow(['No.', 'Date', 'Task']);
  sheet.addRow([1, '7/26', 'Confirm scope\nList contracts']);
  const hidden = workbook.addWorksheet('Scratch');
  hidden.state = 'hidden';
  hidden.addRow(['internal']);
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
  it('docx → markdown IR (native docx reader)', { timeout: 60_000 }, async () => {
    const raw = buildDocxFixture();
    const ir = await parseDocument({
      content_base64: raw.toString('base64'),
      format: 'docx',
      source_meta: { source_system: 'box', source_id: 'FILE-42' },
    });
    expect(ir.text_markdown).toBe('# Quarterly Report\n\nRevenue grew steadily.');
    expect(ir.title).toBe('Quarterly Report');
    expect(ir.sections).toEqual([
      { heading: 'Quarterly Report', level: 1, text: 'Revenue grew steadily.' },
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

  it('xlsx → markdown tables per sheet (native xlsx reader)', { timeout: 60_000 }, async () => {
    const raw = await buildXlsxFixture();
    const ir = await parseDocument({ content_base64: raw.toString('base64'), format: 'xlsx' });
    const expectedTable = [
      '| Deal | Amount |',
      '|---|---|',
      '| Alpha | 100 |',
      '| Beta | 250 |',
    ].join('\n');
    expect(ir.text_markdown).toBe(`## Deals\n\n${expectedTable}`);
    expect(ir.tables).toEqual([{ name: 'Deals', markdown: expectedTable }]);
    expect(ir.meta.content_sha256).toBe(sha256(raw));
  });

  it('pptx → per-slide markdown in deck order with tables and notes (no OCR by default)', async () => {
    const raw = buildPptxFixture();
    const ir = await parseDocument({ content_base64: raw.toString('base64'), format: 'pptx' });
    const table = ['| Item | Amount |', '| --- | --- |', '| Sales | 41,593 |'].join('\n');
    expect(ir.title).toBe('Board Meeting');
    expect(ir.text_markdown).toBe(
      [
        '## Slide 1: Board Meeting',
        'Board Meeting',
        '## Slide 2: Results',
        'Results\nRevenue up',
        table,
        "_1 image(s) not OCR'd_",
        '### Speaker notes',
        '> Mention the Q2 close',
      ].join('\n\n')
    );
    expect(ir.tables).toEqual([{ name: 'slide 2 table 1', markdown: table }]);
    expect(ir.meta.content_sha256).toBe(sha256(raw));
  });

  it('docx keeps line breaks and tables, and replaces pictures with markers (no base64)', async () => {
    const ir = await parseDocument({
      content_base64: buildRichDocxFixture().toString('base64'),
      format: 'docx',
    });
    expect(ir.text_markdown).toContain('1. Summary\nOutage lasted 31 minutes.');
    expect(ir.text_markdown).toContain('| Time | Event |');
    expect(ir.text_markdown).toContain('| 0:32 | Stopped \\| rolled back |');
    expect(ir.text_markdown).toContain('_[image: media/image1.png]_');
    expect(ir.text_markdown).not.toContain('base64');
  });

  it('xlsx keeps merged banners in one cell, cell newlines on one row, and skips hidden sheets', async () => {
    const raw = await buildRichXlsxFixture();
    const ir = await parseDocument({ content_base64: raw.toString('base64'), format: 'xlsx' });
    const lines = ir.text_markdown.split('\n');
    expect(lines).toContain('| Split schedule |  |  |');
    expect(lines).toContain('| 1 | 7/26 | Confirm scope<br>List contracts |');
    expect(ir.text_markdown).not.toContain('internal');
    expect(ir.text_markdown).toContain('_Hidden sheets not read: Scratch_');
  });

  it('rejects password-protected Office files with an actionable message', async () => {
    const encrypted = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504),
    ]);
    await expect(
      parseDocument({ content_base64: encrypted.toString('base64'), format: 'xlsx' })
    ).rejects.toThrow(/password-protected/);
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
    await expect(
      parseDocument({
        content_text: '[{"user":"alice","ts":"1","text":"ok","__proto__":{"x":true}}]',
        format: 'slack_thread',
      })
    ).rejects.toThrow(/dangerous JSON key/);
  });
});
