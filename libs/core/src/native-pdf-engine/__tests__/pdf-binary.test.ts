import { describe, it, expect } from 'vitest';
import { generateNativePdf } from '../engine.js';
import { distillPdfDesign } from '../../pdf-utils.js';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'node:zlib';
import { pathResolver } from '../../../path-resolver.js';

const OUT = pathResolver.sharedTmp('tests/native-pdf/test-native.pdf');

function ensureDir(p: string) {
  if (!fs.existsSync(path.dirname(p))) fs.mkdirSync(path.dirname(p), { recursive: true });
}

describe('Native PDF 2.0 Engine - Binary Generation', () => {

  // ── P0: Core PDF 2.0 structure ───────────────────────────

  it('should generate a valid PDF 2.0 binary with /W [1 4 2] cross-reference stream', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Hello Native PDF World!\nThis is a truly native PDF.', title: 'Native Test' },
    } as any, OUT, { compress: false });

    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('%PDF-2.0');
    expect(t).toContain('/Producer (Kyberion Native PDF 2.0 Engine)');
    expect(t).toContain('BT');
    expect(t).toContain('ET');
    expect(t).toContain('/Type /XRef');
    expect(t).toContain('/W [1 4 2]');
    expect(t).toContain('%%EOF');
  });

  it('should generate PDF with FlateDecode compressed content streams', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Compressed', title: 'C' },
    } as any, OUT, { compress: true });
    expect(fs.readFileSync(OUT, 'binary')).toContain('/Filter /FlateDecode');
  });

  it('should generate PDF without compression when disabled', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Uncompressed content test', title: 'U' },
    } as any, OUT, { compress: false, xmpMetadata: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('(Uncompressed content test) Tj');
    expect(t).toContain('/Type /XRef');
  });

  it('should encode Unicode text as UTF-16BE hex strings', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'こんにちは世界', title: 'Unicode' },
    } as any, OUT, { compress: false, unicode: true });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('<FEFF');
    expect(t).toContain('3053'); // 'こ'
  });

  it('should generate PDF with precise coordinates from aesthetic elements', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'html', body: '' },
      content: { pages: [{ pageNumber: 1, width: 500, height: 500, text: '' }] },
      aesthetic: { elements: [{ type: 'text', x: 123, y: 456, text: 'PrecisePosition', fontSize: 10 }] }
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('1 0 0 1 123 44 Tm');
    expect(t).toContain('(PrecisePosition) Tj');
  });

  it('should distill positioned text elements back into the aesthetic layer', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: '' },
      content: { pages: [{ pageNumber: 1, width: 500, height: 500, text: '' }] },
      aesthetic: {
        elements: [
          { type: 'heading', x: 72, y: 88, text: 'Document Title', fontSize: 24, fontName: 'Helvetica' },
          { type: 'text', x: 72, y: 132, text: 'Executive summary line', fontSize: 12, fontName: 'Helvetica' },
        ],
      },
    } as any, OUT, { compress: false });

    const design = await distillPdfDesign(OUT, { aesthetic: true });
    expect(design.aesthetic?.elements?.length).toBeGreaterThanOrEqual(2);
    expect(design.aesthetic?.fonts).toContain('F1');
    expect(design.aesthetic?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'heading',
          text: 'Document Title',
          x: expect.any(Number),
          y: expect.any(Number),
        }),
        expect.objectContaining({
          type: 'text',
          text: 'Executive summary line',
        }),
      ]),
    );
  });

  // ── P1-1: XMP Metadata Stream ────────────────────────────

  it('should emit an XMP Metadata stream attached to the Catalog', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'XMP test', title: 'XMP Document' },
      metadata: { title: 'XMP Document', author: 'Kyberion', subject: 'Testing' },
    } as any, OUT, { compress: false, xmpMetadata: true });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Type /Metadata');
    expect(t).toContain('/Subtype /XML');
    expect(t).toContain('<x:xmpmeta');
    expect(t).toContain('dc:title');
    expect(t).toContain('/Metadata');
  });

  it('should not emit XMP metadata when xmpMetadata is false', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'No XMP', title: 'No XMP' },
    } as any, OUT, { compress: false, xmpMetadata: false });
    expect(fs.readFileSync(OUT, 'binary')).not.toContain('/Type /Metadata');
  });

  // ── P1-2: Image XObject ──────────────────────────────────

  it('should embed a JPEG image as DCTDecode Image XObject', async () => {
    ensureDir(OUT);
    const jpegPath = pathResolver.sharedTmp('tests/native-pdf/test-pixel.jpg');
    if (!fs.existsSync(jpegPath)) {
      const j = Buffer.from([
        0xFF,0xD8,0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0x00,0x01,
        0x01,0x00,0x00,0x01,0x00,0x01,0x00,0x00,
        0xFF,0xDB,0x00,0x43,0x00,...Array(64).fill(0x10),
        0xFF,0xC0,0x00,0x0B,0x08,0x00,0x01,0x00,0x01,0x01,0x01,0x11,0x00,
        0xFF,0xC4,0x00,0x1F,0x00,0x00,0x01,0x05,0x01,0x01,0x01,0x01,0x01,
          0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x01,0x02,0x03,0x04,
          0x05,0x06,0x07,0x08,0x09,0x0A,0x0B,
        0xFF,0xC4,0x00,0xB5,0x10,...Array(179).fill(0x00),
        0xFF,0xDA,0x00,0x08,0x01,0x01,0x00,0x00,0x3F,0x00,0xF0,0x50,
        0xFF,0xD9,
      ]);
      fs.writeFileSync(jpegPath, j);
    }
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: '' },
      content: { pages: [{
        pageNumber: 1, width: 595, height: 842, text: 'Image test',
        images: [{ path: jpegPath, x: 50, y: 50, width: 200, height: 150 }]
      }] }
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Subtype /Image');
    expect(t).toContain('/Filter /DCTDecode');
    expect(t).toContain('/ColorSpace /Device');
    expect(t).toContain('/XObject');
    expect(t).toContain('/Im1 Do');
  });

  it('should distill JPEG image XObjects back into page images', async () => {
    ensureDir(OUT);
    const jpegPath = pathResolver.sharedTmp('tests/native-pdf/test-pixel.jpg');
    if (!fs.existsSync(jpegPath)) {
      throw new Error('Expected test JPEG fixture to exist.');
    }
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: '' },
      content: { pages: [{
        pageNumber: 1, width: 595, height: 842, text: '',
        images: [{ path: jpegPath, x: 50, y: 50, width: 200, height: 150 }],
      }] },
    } as any, OUT, { compress: false });

    const design = await distillPdfDesign(OUT, { aesthetic: true });
    expect(design.content?.pages?.[0]?.images?.length).toBeGreaterThanOrEqual(1);
    expect(design.content?.pages?.[0]?.images?.[0]).toEqual(
      expect.objectContaining({
        path: expect.stringMatching(/pdf-image-\d+\.jpg$/),
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
      }),
    );
    expect(design.aesthetic?.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'image',
          x: expect.any(Number),
          y: expect.any(Number),
        }),
      ]),
    );
  });

  it('should preserve Flate image soft masks as PNG alpha', async () => {
    const out = pathResolver.sharedTmp('tests/native-pdf/test-smask.pdf');
    ensureDir(out);
    const rgb = zlib.deflateSync(Buffer.from([255, 0, 0, 0, 255, 0]));
    const alpha = zlib.deflateSync(Buffer.from([255, 0]));
    const header = '%PDF-1.4\n';
    const objects = [
      '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
      '4 0 obj\n<< /Length 24 >>\nstream\nq 2 0 0 1 0 0 cm /Im1 Do Q\nendstream\nendobj\n',
      Buffer.concat([
        Buffer.from(`5 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /SMask 6 0 R /Length ${rgb.length} >>\nstream\n`, 'binary'),
        rgb,
        Buffer.from('\nendstream\nendobj\n', 'binary'),
      ]),
      Buffer.concat([
        Buffer.from(`6 0 obj\n<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /Length ${alpha.length} >>\nstream\n`, 'binary'),
        alpha,
        Buffer.from('\nendstream\nendobj\n', 'binary'),
      ]),
      'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
    ];
    fs.writeFileSync(out, Buffer.concat([Buffer.from(header, 'binary'), ...objects.map((part) => typeof part === 'string' ? Buffer.from(part, 'binary') : part)]));

    const design = await distillPdfDesign(out, { aesthetic: true });
    const image = design.content?.pages?.[0]?.images?.[0];
    expect(image).toEqual(
      expect.objectContaining({
        path: expect.stringMatching(/pdf-image-\d+\.png$/),
        width: expect.any(Number),
        height: expect.any(Number),
      }),
    );
    const png = fs.readFileSync(image!.path);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    expect(png[25]).toBe(6);
  });

  // ── P1-4: Object Streams ─────────────────────────────────

  it('should pack objects into Object Streams when objectStreams is enabled', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Object stream test', title: 'ObjStm' },
    } as any, OUT, { compress: true, objectStreams: true });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Type /ObjStm');
    expect(t).toContain('/W [1 4 2]');
    expect(t).toContain('%%EOF');
  });

  it('should distill text from PDFs that use object streams', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Object stream extraction test', title: 'ObjStm Extract' },
    } as any, OUT, { compress: true, objectStreams: true });

    const design = await distillPdfDesign(OUT, { aesthetic: true });
    expect(design.content?.text).toContain('Object stream extraction test');
    expect(design.metadata?.pageCount).toBeGreaterThanOrEqual(1);
  });

  // ── P1-5: Page Labels ────────────────────────────────────

  it('should generate /PageLabels NumberTree', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Labels', title: 'L' },
      pageLabels: [
        { startIndex: 0, style: 'roman-lower' },
        { startIndex: 2, style: 'decimal', startValue: 1 },
      ],
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/PageLabels');
    expect(t).toContain('/Nums');
    expect(t).toContain('/S /r');
    expect(t).toContain('/S /D');
  });

  // ── P2-1: Bookmarks / Outlines ───────────────────────────

  it('should generate /Outlines tree with /First /Last', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Chapter 1\n\nChapter 2' },
      content: {
        pages: [
          { pageNumber: 1, width: 595, height: 842, text: 'Chapter 1' },
          { pageNumber: 2, width: 595, height: 842, text: 'Chapter 2' },
        ]
      },
      outlines: [
        { title: 'Chapter 1', pageIndex: 0 },
        { title: 'Chapter 2', pageIndex: 1, children: [
          { title: 'Section 2.1', pageIndex: 1, top: 700 }
        ]},
      ],
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Type /Outlines');
    expect(t).toContain('/First');
    expect(t).toContain('/Last');
    expect(t).toContain('/Dest');
    expect(t).toContain('/UseOutlines');
    // Titles encoded UTF-16BE
    expect(t).toContain('Chapter');
  });

  // ── P2-2: Annotations ────────────────────────────────────

  it('should generate Link annotation with URI action', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Click the link' },
      content: { pages: [{
        pageNumber: 1, width: 595, height: 842, text: 'Click the link',
        annotations: [
          { type: 'Link', rect: [50, 100, 200, 20], uri: 'https://kyberion.ai', borderWidth: 1 }
        ]
      }] }
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Subtype /Link');
    expect(t).toContain('/S /URI');
    expect(t).toContain('kyberion.ai');
    expect(t).toContain('/Annots');
  });

  it('should generate Text annotation (sticky note)', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'See annotation' },
      content: { pages: [{
        pageNumber: 1, width: 595, height: 842, text: 'See annotation',
        annotations: [
          { type: 'Text', rect: [300, 100, 20, 20], content: 'Important note', title: 'Reviewer' }
        ]
      }] }
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Subtype /Text');
    expect(t).toContain('/Contents');
    expect(t).toContain('/Open false');
  });

  // ── P2-3: Graphics State / Vectors ───────────────────────

  it('should generate vector rect with fill opacity and ExtGState', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: '' },
      content: { pages: [{
        pageNumber: 1, width: 595, height: 842, text: 'Vectors',
        vectors: [
          {
            shape: { kind: 'rect', x: 50, y: 100, width: 200, height: 100 },
            fillColor: [0.2, 0.4, 0.8],
            strokeColor: [0, 0, 0],
            lineWidth: 2,
            fillOpacity: 0.5,
            blendMode: 'Multiply',
          },
          {
            shape: { kind: 'line', x1: 50, y1: 250, x2: 300, y2: 250 },
            strokeColor: [1, 0, 0],
            lineWidth: 1.5,
            dashPattern: [4, 2],
          }
        ]
      }] }
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('re');         // rect operator
    expect(t).toContain(' m ');        // moveto
    expect(t).toContain(' l\n');       // lineto
    expect(t).toContain('/ca 0.5000'); // fill opacity
    expect(t).toContain('/BM /Multiply');
    expect(t).toContain('/ExtGState');
    expect(t).toContain('0.2000 0.4000 0.8000 rg'); // fill color (R G B rg)
  });

  // ── P2-4: Associated Files ────────────────────────────────

  it('should embed an associated file in /EmbeddedFiles', async () => {
    ensureDir(OUT);
    const dataPath = pathResolver.sharedTmp('tests/native-pdf/sample-data.json');
    fs.writeFileSync(dataPath, JSON.stringify({ key: 'value', version: 2 }));

    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Document with attachment' },
      associatedFiles: [
        { name: 'data.json', path: dataPath, mimeType: 'application/json', relationship: 'Data', description: 'Source data' }
      ],
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/EmbeddedFile');
    expect(t).toContain('/Type /Filespec');
    expect(t).toContain('data.json');
    expect(t).toContain('/Names');
    expect(t).toContain('/EmbeddedFiles');
  });

  // ── P2-5: Form XObjects ───────────────────────────────────

  it('should define a /Form XObject with /BBox', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Form XObject test' },
      formXObjects: [
        {
          name: 'Logo',
          bbox: [0, 0, 100, 50],
          content: 'BT /F1 10 Tf 10 25 Td (Logo Content) Tj ET',
        }
      ],
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Subtype /Form');
    expect(t).toContain('/BBox');
    expect(t).toContain('Logo Content');
  });

  // ── P2-6: Tagged PDF ─────────────────────────────────────

  it('should emit /MarkInfo and /StructTreeRoot for Tagged PDF', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Accessible document' },
      structTree: {
        tag: 'Document',
        children: [
          { tag: 'H1', actualText: 'Heading One', lang: 'en' },
          { tag: 'P',  actualText: 'Paragraph text', lang: 'en' },
          { tag: 'Figure', alt: 'A descriptive image' },
        ]
      },
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/MarkInfo');
    expect(t).toContain('/Marked true');
    expect(t).toContain('/StructTreeRoot');
    expect(t).toContain('/Type /StructElem');
    expect(t).toContain('/S /Document');
    expect(t).toContain('/S /H1');
    expect(t).toContain('/S /Figure');
    expect(t).toContain('/Alt');
    expect(t).toContain('/ActualText');
  });

  // ── P3-1: AcroForms ──────────────────────────────────────

  it('should generate /AcroForm with text, checkbox, and dropdown fields', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Form document' },
      acroForm: {
        fields: [
          { name: 'FullName', type: 'text', rect: [50, 700, 200, 20], value: 'John Doe', pageIndex: 0 },
          { name: 'Agree', type: 'checkbox', rect: [50, 670, 15, 15], checked: true, pageIndex: 0 },
          { name: 'Country', type: 'dropdown', rect: [50, 640, 150, 20], options: ['Japan', 'USA', 'UK'], value: 'Japan', pageIndex: 0 },
        ],
        needAppearances: true,
      },
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/AcroForm');
    expect(t).toContain('/FT /Tx');           // text field
    expect(t).toContain('/FT /Btn');          // checkbox
    expect(t).toContain('/FT /Ch');           // dropdown
    expect(t).toContain('/NeedAppearances true');
    expect(t).toContain('(FullName)');
    expect(t).toContain('/Subtype /Widget');
    expect(t).toContain('/Subtype /Form');    // Appearance Stream
  });

  // ── P3-2: Optional Content Groups / Layers ───────────────

  it('should generate /OCProperties with ON/OFF layers', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Layered document' },
      layers: [
        { name: 'Background', visible: true, intent: 'View' },
        { name: 'Watermark', visible: false, intent: 'View' },
        { name: 'Comments', visible: true },
      ],
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/OCProperties');
    expect(t).toContain('/Type /OCG');
    expect(t).toContain('/BaseState /ON');
    expect(t).toContain('/OFF');
    expect(t).toContain('Background');
    expect(t).toContain('Watermark');
  });

  // ── P3-3: Linearization ──────────────────────────────────

  it('should emit /Linearized dict when linearize option is enabled', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Web optimized PDF' },
    } as any, OUT, { compress: false, linearize: true });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Linearized 1.0');
    expect(t).toContain('/L ');
    expect(t).toContain('/N ');
  });

  // ── P3-4: AES-256 Encryption ─────────────────────────────

  it('should generate /Encrypt dict with V=5 R=7 AES-256', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Encrypted document' },
    } as any, OUT, {
      compress: false,
      encrypt: { ownerPassword: 'owner123', userPassword: 'user456', algorithm: 'AES256' },
    });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Filter /Standard');
    expect(t).toContain('/V 5');
    expect(t).toContain('/R 7');
    expect(t).toContain('/CFM /AESV3');
    expect(t).toContain('/StmF /StdCF');
    expect(t).toContain('/Encrypt');          // in Catalog
  });

  // ── P3-5: PDF MAC ─────────────────────────────────────────

  it('should append a PDF MAC token comment', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'MAC protected document' },
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('%% PdfMac:');
    // MAC is a 64-char hex string (SHA-256)
    expect(t).toMatch(/%% PdfMac: [0-9A-F]{64}/);
  });

  // ── P3-7: Digital Signatures ──────────────────────────────

  it('should generate /Sig field annotation with /ByteRange placeholder', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: 'Signed document' },
      signature: {
        subFilter: 'adbe.pkcs7.detached',
        signerName: 'Alice',
        reason: 'Approval',
        location: 'Tokyo',
        pageIndex: 0,
      },
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/Type /Sig');
    expect(t).toContain('/SubFilter /adbe.pkcs7.detached');
    expect(t).toContain('/ByteRange [0 0 0 0]');
    expect(t).toContain('/Contents <');
    expect(t).toContain('/AcroForm');
    expect(t).toContain('/SigFlags 3');
  });

  // ── P3-8: Document Parts ─────────────────────────────────

  it('should emit /DPartRoot with /DParts referencing page objects', async () => {
    ensureDir(OUT);
    await generateNativePdf({
      version: '1.0.0', generatedAt: new Date().toISOString(),
      source: { format: 'markdown', body: '' },
      content: {
        pages: [
          { pageNumber: 1, width: 595, height: 842, text: 'Part 1 Page 1' },
          { pageNumber: 2, width: 595, height: 842, text: 'Part 1 Page 2' },
          { pageNumber: 3, width: 595, height: 842, text: 'Part 2 Page 1' },
        ]
      },
      documentParts: [
        { name: 'Introduction', pageIndices: [0, 1], metadata: { Author: 'Alice' } },
        { name: 'Appendix', pageIndices: [2] },
      ],
    } as any, OUT, { compress: false });
    const t = fs.readFileSync(OUT, 'binary');
    expect(t).toContain('/DPartRoot');
    expect(t).toContain('/DParts');
    expect(t).toContain('/DMeta');
    expect(t).toContain('Introduction');
    expect(t).toContain('Appendix');
  });
});
