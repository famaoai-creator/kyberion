import { describe, expect, it } from 'vitest';
import { selectPdfOcrImages } from './pdf-utils.js';
import { pdfToMarkdown } from './protocol-to-markdown.js';
import type { PdfDesignProtocol, PdfPage } from './types/pdf-protocol.js';

const page = (images: PdfPage['images'], extra: Partial<PdfPage> = {}): PdfPage => ({
  pageNumber: 1,
  width: 960,
  height: 540,
  text: 'Q2 results',
  images,
  ...extra,
});

describe('selectPdfOcrImages', () => {
  it('keeps pasted tables and charts but skips logos, duplicates and unextracted images', () => {
    const selected = selectPdfOcrImages(
      page([
        { x: 0, y: 0, width: 731, height: 374, path: '/tmp-free/table.png' },
        { x: 0, y: 0, width: 125, height: 80, path: '/tmp-free/logo.png' },
        { x: 0, y: 0, width: 731, height: 374, path: '/tmp-free/table.png' },
        { x: 0, y: 0, width: 500, height: 300, path: '' },
      ])
    );
    expect(selected.map((image) => image.path)).toEqual(['/tmp-free/table.png']);
  });

  it('honours a custom minimum area ratio', () => {
    const logo = { x: 0, y: 0, width: 125, height: 80, path: '/tmp-free/logo.png' };
    expect(selectPdfOcrImages(page([logo]), { minAreaRatio: 0.01 })).toHaveLength(1);
  });
});

describe('pdfToMarkdown image OCR', () => {
  it('renders OCR text and unreadable-image notes per page', () => {
    const protocol = {
      version: '1.0.0',
      content: {
        text: 'Q2 results',
        pages: [
          page([], {
            imageOcr: [{ imagePath: '/tmp-free/table.png', text: '売上高 41,593' }],
            imageOcrSkipped: [{ imagePath: '/tmp-free/chart.emf', reason: 'unsupported' }],
          }),
        ],
      },
    } as unknown as PdfDesignProtocol;
    const markdown = pdfToMarkdown(protocol);
    expect(markdown).toContain('Image text (OCR — unverified):');
    expect(markdown).toContain('売上高 41,593');
    expect(markdown).toContain('_Unreadable images: 1_');
  });
});
