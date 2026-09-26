import { describe, expect, it } from 'vitest';
import type { OcrResult } from '@agent/core/ocr-types';
import { buildPdfPageOcrOverlayLinesFromResult } from './media-pdf-helpers.js';

const page = { pageNumber: 1, width: 1000, height: 1000 };
const image = { x: 100, y: 200, width: 400, height: 200 };

function result(
  box: { x: number; y: number; width: number; height: number },
  extra: Partial<OcrResult>
): OcrResult {
  return {
    status: 'succeeded',
    provider: 'tesseract',
    text: 'Hello world',
    confidence: 90,
    elapsedMs: 0,
    lines: [{ text: 'Hello world', confidence: 90, boundingBox: box }],
    ...extra,
  };
}

describe('buildPdfPageOcrOverlayLinesFromResult bounding box units', () => {
  it('scales declared normalized boxes by the image size', () => {
    const [line] = buildPdfPageOcrOverlayLinesFromResult(
      page,
      image,
      result({ x: 0.5, y: 0.5, width: 0.25, height: 0.25 }, { boundingBoxUnits: 'normalized' })
    );
    expect(line).toMatchObject({ x: 300, y: 300, width: 100, height: 50 });
  });

  it('keeps declared pixel boxes as pixels even when they fall inside 0..1', () => {
    const [line] = buildPdfPageOcrOverlayLinesFromResult(
      page,
      image,
      result({ x: 0, y: 0, width: 1, height: 1 }, { boundingBoxUnits: 'pixel' })
    );
    expect(line).toMatchObject({ x: 100, y: 200, width: 1, height: 1 });
  });

  it('falls back to the provider heuristic when units are undeclared', () => {
    const [line] = buildPdfPageOcrOverlayLinesFromResult(
      page,
      image,
      result({ x: 0.5, y: 0.5, width: 0.25, height: 0.25 }, { provider: 'apple_vision' })
    );
    expect(line).toMatchObject({ x: 300, y: 300, width: 100, height: 50 });
  });
});
