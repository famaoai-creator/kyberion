/**
 * document-reader: the one pdf / pptx / docx / xlsx / html / md / txt → Markdown path shared by
 * `pnpm kyberion read`, media:document_digest and ingest:parse_document.
 * Fixtures are synthesized in memory (and one uniquely named sharedTmp dir).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import { assertReadableOfficeBytes, inferDocumentFormat, readDocument } from './document-reader.js';
import { generateNativePdf } from './src/native-pdf-engine/engine.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

const PML_NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function pptxFixture(): Buffer {
  const zip = new AdmZip();
  const add = (name: string, xml: string) => zip.addFile(name, Buffer.from(xml, 'utf8'));
  add(
    'ppt/presentation.xml',
    `<p:presentation ${PML_NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`
  );
  add(
    'ppt/_rels/presentation.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/></Relationships>`
  );
  add(
    'ppt/slides/slide1.xml',
    `<p:sld ${PML_NS}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Board Meeting</a:t></a:r></a:p></p:txBody></p:sp>` +
      '<p:pic><p:blipFill><a:blip r:embed="rIdImg"/></p:blipFill></p:pic></p:spTree></p:cSld></p:sld>'
  );
  add(
    'ppt/slides/_rels/slide1.xml.rels',
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImg" Type="${REL}/image" Target="../media/image1.png"/></Relationships>`
  );
  zip.addFile('ppt/media/image1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return zip.toBuffer();
}

function docxFixture(): Buffer {
  const zip = new AdmZip();
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
    )
  );
  zip.addFile(
    '_rels/.rels',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`
    )
  );
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Incident Report</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Line one</w:t></w:r><w:r><w:br/><w:t>Line two</w:t></w:r></w:p>' +
        '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Time</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Event</w:t></w:r></w:p></w:tc></w:tr>' +
        '<w:tr><w:tc><w:p><w:r><w:t>0:32</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Stopped</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
        '</w:body></w:document>'
    )
  );
  return zip.toBuffer();
}

async function xlsxFixture(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Deals');
  sheet.addRow(['Deal', 'Amount']);
  sheet.addRow(['Alpha', 100]);
  workbook.addWorksheet('Scratch').state = 'hidden';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('document-reader', () => {
  let workDir = '';

  beforeAll(() => {
    workDir = pathResolver.sharedTmp(`document-reader-test-${randomUUID()}`);
    safeMkdir(workDir, { recursive: true });
  });

  afterAll(() => {
    if (workDir) safeRmSync(workDir, { recursive: true, force: true });
  });

  it('infers formats from extensions and rejects others', () => {
    expect(inferDocumentFormat('a/b/Deck.PPTX')).toBe('pptx');
    expect(inferDocumentFormat('book.xlsm')).toBe('xlsx');
    expect(inferDocumentFormat('page.HTM')).toBe('html');
    expect(inferDocumentFormat('README.markdown')).toBe('markdown');
    expect(inferDocumentFormat('notes.txt')).toBe('text');
    expect(inferDocumentFormat('data.csv')).toBeUndefined();
    expect(inferDocumentFormat('archive.mhtml')).toBeUndefined();
  });

  it('reads html into Markdown with the <title> as heading and flags stripped scripts', async () => {
    const html =
      '<!doctype html><html><head><title>Q3 &amp; Plan</title><script>alert(1)</script></head>' +
      '<body><h2>Goals</h2><ul><li>Grow</li><li>Hire</li></ul>' +
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>';
    const result = await readDocument(Buffer.from(html), 'html');
    expect(result.format).toBe('html');
    expect(result.title).toBe('Q3 & Plan');
    expect(result.markdown).toMatch(/^# Q3 & Plan\n\n## Goals/);
    expect(result.markdown).toContain('- Grow\n- Hire');
    expect(result.markdown).toContain('| 1 | 2 |');
    expect(result.markdown).not.toContain('alert');
    expect(result.warnings).toEqual([expect.stringMatching(/1 <script> block/)]);
    expect(result.tables).toEqual([]);
  });

  it('reads markdown and text as-is and warns on an empty body', async () => {
    const md = await readDocument(Buffer.from('\uFEFFintro\r\n# Title\r\n\nbody'), 'markdown');
    expect(md).toMatchObject({ format: 'markdown', title: 'Title', warnings: [] });
    expect(md.markdown).toBe('intro\n# Title\n\nbody');
    const text = await readDocument(Buffer.from('# not a title\n'), 'text');
    expect(text.title).toBeUndefined();
    expect(text.markdown).toBe('# not a title\n');
    const empty = await readDocument(Buffer.from('<html><body> </body></html>'), 'html');
    expect(empty.warnings).toContain('document body is empty');
  });

  it('reads pptx slides and flags images that were not OCR’d', async () => {
    const result = await readDocument(pptxFixture(), 'pptx');
    expect(result.title).toBe('Board Meeting');
    expect(result.markdown).toContain('## Slide 1: Board Meeting');
    expect(result.markdown).toContain("_1 image(s) not OCR'd_");
    expect(result.warnings.join(' ')).toMatch(/not OCR/);
  });

  it('reads docx headings, line breaks and tables', async () => {
    const result = await readDocument(docxFixture(), 'docx');
    expect(result.title).toBe('Incident Report');
    expect(result.markdown).toContain('Line one\nLine two');
    expect(result.markdown).toContain('| 0:32 | Stopped |');
  });

  it('reads xlsx sheets as tables and reports hidden sheets', async () => {
    const result = await readDocument(await xlsxFixture(), 'xlsx');
    expect(result.tables.map((table) => table.name)).toEqual(['Deals']);
    expect(result.markdown).toContain('| Alpha | 100 |');
    expect(result.warnings).toEqual(['hidden sheets not read: Scratch']);
  });

  it('renders xlsx numbers with their number formats', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Profit');
    sheet.addRow(['Metric', 'Value']);
    sheet.addRow(['Margin', 0.334794339836785]).getCell(2).numFmt = '0.0%';
    sheet.addRow(['Revenue', 41593000]).getCell(2).numFmt = '#,##0';
    sheet.addRow(['Delta', -28957]).getCell(2).numFmt = '#,##0;"▲"#,##0';
    sheet.addRow(['Raw', 0.332425738938115]);
    const result = await readDocument(Buffer.from(await workbook.xlsx.writeBuffer()), 'xlsx');
    expect(result.markdown).toContain('| Margin | 33.5% |');
    expect(result.markdown).toContain('| Revenue | 41,593,000 |');
    expect(result.markdown).toContain('| Delta | ▲28,957 |');
    expect(result.markdown).toContain('| Raw | 0.3324257389 |');
  });

  it('reads a pdf from a repository path without surfacing the author', async () => {
    const pdfPath = path.join(workDir, 'report.pdf');
    await generateNativePdf(
      {
        version: '1.0.0',
        generatedAt: '2026-01-01T00:00:00.000Z',
        source: { format: 'markdown', body: 'Quarterly revenue grew.', title: 'Quarterly Review' },
        metadata: { title: 'Quarterly Review', author: 'Jane Example' },
      } as unknown as Parameters<typeof generateNativePdf>[0],
      pdfPath,
      { compress: false, xmpMetadata: true }
    );
    const result = await readDocument(pdfPath, 'pdf');
    expect(result.title).toBe('Quarterly Review');
    expect(result.markdown).toContain('Quarterly revenue grew.');
    expect(result.markdown).not.toContain('Jane Example');
  });

  it('rejects password-protected Office bytes and paths outside the repository', async () => {
    const encrypted = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(504),
    ]);
    expect(() => assertReadableOfficeBytes(encrypted, 'xlsx')).toThrow(/password-protected/);
    await expect(readDocument(encrypted, 'docx')).rejects.toThrow(/password-protected/);
    await expect(readDocument('/etc/hosts', 'pdf')).rejects.toThrow(/RESOURCE_PATH_SCOPE/);
  });

  it('leaves nothing behind in its staging area', async () => {
    const pdfPath = path.join(workDir, 'again.pdf');
    safeWriteFile(
      pdfPath,
      safeReadFile(path.join(workDir, 'report.pdf'), { encoding: null }) as Buffer
    );
    await readDocument(pdfPath, 'pdf');
    const staging = pathResolver.sharedTmp('document-reader');
    const { safeExistsSync, safeReaddir } = await import('./secure-io.js');
    const leftovers = safeExistsSync(staging) ? safeReaddir(staging) : [];
    expect(leftovers.filter((name: string) => name.startsWith('pdf-'))).toEqual([]);
  });
});
