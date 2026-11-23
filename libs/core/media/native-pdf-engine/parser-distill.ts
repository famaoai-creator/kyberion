import type { PdfDesignProtocol, PdfLayoutElement } from '../../contracts/pdf-protocol.js';
import { nowIso } from '../../foundation/time.js';
import { NativePdfParser } from './parser.js';
import {
  graphicElementsToPageVectors,
  type PdfExtractedGraphicElement,
} from './parser-graphic-vectors.js';

/**
 * Distill a parsed PDF into the shared design protocol: positioned text/graphics
 * become `aesthetic.elements`/`content.pages`, and content-stream rects are
 * projected onto `page.vectors` so the render path keeps fills and strokes.
 */
export async function distillNativePdfDesign(sourcePath: string): Promise<PdfDesignProtocol> {
  const parser = new NativePdfParser(sourcePath);
  const metadata = parser.extractMetadata();
  const pages = parser.extractPages();
  for (const page of pages) {
    const vectors = graphicElementsToPageVectors(
      page.elements as unknown as PdfExtractedGraphicElement[]
    );
    if (vectors.length > 0) page.vectors = vectors;
  }
  const outlines = parser.extractOutlines();
  const acroForm = parser.extractAcroForm();
  const fullText = pages.map((p) => p.text).join('\n\n');
  const elements = pages.flatMap((page) => [
    ...(page.elements || []),
    ...(page.images || []).map((image) => ({
      type: 'image' as const,
      x: image.x,
      y: image.y,
      width: image.width,
      height: image.height,
    })),
  ]);
  const fonts = Array.from(
    new Set(
      elements
        .filter((element): element is PdfLayoutElement => element.type !== 'image')
        .map((element) => element.fontName)
        .filter(Boolean)
    )
  ) as string[];
  const xBuckets = Array.from(new Set(elements.map((element) => Math.round(element.x / 40))));
  const layout = xBuckets.length >= 2 ? 'multi-column' : 'single-column';

  return {
    version: '4.0.0',
    generatedAt: nowIso(),
    source: { format: 'markdown' as const, body: fullText, title: metadata.title },
    content: { text: fullText, pages },
    metadata: { ...metadata, pageCount: pages.length },
    outlines,
    acroForm,
    aesthetic: { layout, elements, fonts },
  };
}
