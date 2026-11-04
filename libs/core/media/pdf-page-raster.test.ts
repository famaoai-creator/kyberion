import { describe, expect, it } from 'vitest';
import {
  dropBrokenTextElements,
  isBrokenText,
  pageNeedsRender,
  renderPdfPages,
} from './pdf-page-raster.js';
import type { PdfPage } from '../contracts/pdf-protocol.js';

const page = (extra: Partial<PdfPage> = {}): PdfPage => ({
  pageNumber: 1,
  width: 960,
  height: 540,
  text: 'Q2 results',
  ...extra,
});

const BROKEN = '\u0000\u0001\u0000\u0002\u0000\u0003\u0000\u0004\u0000\u0005';

const textElement = (text: string) =>
  ({ type: 'text', text, x: 0, y: 0, width: 10, height: 10 }) as unknown as NonNullable<
    PdfPage['elements']
  >[number];

describe('isBrokenText', () => {
  it('flags text made of unmapped glyphs and leaves normal or short text alone', () => {
    expect(isBrokenText(BROKEN)).toBe(true);
    expect(isBrokenText(`見出し ${BROKEN} 本文`)).toBe(true);
    expect(isBrokenText('倒産隔離を行い、実質的リスクを債務者のクレジットリスクに限定')).toBe(
      false
    );
    expect(isBrokenText('')).toBe(false);
    expect(isBrokenText('\u0000\u0001')).toBe(false); // too short to judge
  });
});

describe('pageNeedsRender', () => {
  it('renders pages with broken text', () => {
    expect(pageNeedsRender(page({ text: BROKEN }), false)).toBe(true);
  });

  it('renders drawing-only pages but not blank or image-carrying ones', () => {
    const vectors = [{}] as unknown as PdfPage['vectors'];
    expect(pageNeedsRender(page({ text: '', vectors }), false)).toBe(true);
    expect(pageNeedsRender(page({ text: '', vectors }), true)).toBe(false);
    expect(pageNeedsRender(page({ text: '' }), false)).toBe(false);
  });

  it('leaves healthy pages alone', () => {
    expect(pageNeedsRender(page(), false)).toBe(false);
  });
});

describe('dropBrokenTextElements', () => {
  it('removes broken positioned text so it cannot become a garbage table', () => {
    const broken = page({ elements: [textElement(BROKEN), textElement(BROKEN)] });
    expect(dropBrokenTextElements(broken)).toBe(true);
    expect(broken.elements).toEqual([]);
  });

  it('keeps healthy positioned text', () => {
    const healthy = page({ elements: [textElement('Revenue'), textElement('120')] });
    expect(dropBrokenTextElements(healthy)).toBe(false);
    expect(healthy.elements).toHaveLength(2);
  });
});

describe('renderPdfPages', () => {
  // One-page PDF with a single line of text; pdf.js repairs the missing xref.
  const MINIMAL_PDF = Buffer.from(
    [
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '4 0 obj<</Length 44>>stream',
      'BT /F1 24 Tf 20 100 Td (Hello) Tj ET',
      'endstream endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Root 1 0 R/Size 6>>',
      '%%EOF',
    ].join('\n')
  );

  it('draws requested pages as PNG without any external binary', async () => {
    const [first] = await renderPdfPages(MINIMAL_PDF, [1], { desiredWidth: 300 });
    expect(first.pageNumber).toBe(1);
    expect(first.png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('returns nothing when no page is requested', async () => {
    await expect(renderPdfPages(MINIMAL_PDF, [])).resolves.toEqual([]);
  });
});
