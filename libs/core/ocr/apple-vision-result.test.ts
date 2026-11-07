import { describe, expect, it } from 'vitest';
import { normalizeAppleVisionResult } from './apple-vision-result.js';

const box = { x: 0.1, y: 0.2, width: 0.3, height: 0.05 };
const line = { text: 'Native OCR', confidence: 93.25, boundingBox: box };
const result = () => ({ text: line.text, labels: [], confidence: 93.25, lines: [{ ...line }] });

describe('native Apple Vision OCR result normalization', () => {
  it('preserves actual confidence and normalized top-left geometry without rescaling', () => {
    expect(normalizeAppleVisionResult(result())).toEqual(result());
  });
  it('preserves old text-and-label binaries without inventing confidence or geometry', () => {
    expect(normalizeAppleVisionResult({ text: 'Legacy text', labels: [] })).toEqual({
      text: 'Legacy text',
      labels: [],
    });
  });
  it('retains genuine empty OCR output', () => {
    expect(normalizeAppleVisionResult({ text: '', labels: [], confidence: 0, lines: [] })).toEqual({
      text: '',
      labels: [],
      confidence: 0,
      lines: [],
    });
  });
  it.each([-1, 100.01, NaN, Infinity, '93'])(
    'rejects invalid overall confidence %s',
    (confidence) => {
      expect(normalizeAppleVisionResult({ ...result(), confidence })).toBeUndefined();
    }
  );
  it.each([-1, 100.01, NaN, Infinity, '93'])('rejects invalid line confidence %s', (confidence) => {
    expect(
      normalizeAppleVisionResult({ ...result(), lines: [{ ...line, confidence }] })
    ).toBeUndefined();
  });
  it.each([
    undefined,
    null,
    [],
    { ...box, x: -0.01 },
    { ...box, y: -0.01 },
    { ...box, width: 0 },
    { ...box, height: 0 },
    { ...box, width: 1.1 },
    { ...box, x: 0.9 },
    { ...box, y: 0.99 },
    { ...box, height: Infinity },
    { ...box, x: '0.1' },
  ])('rejects malformed or out-of-image geometry %j', (boundingBox) => {
    expect(
      normalizeAppleVisionResult({ ...result(), lines: [{ ...line, boundingBox }] })
    ).toBeUndefined();
  });
  it('rejects an entire result when a sensitive line has malformed geometry', () => {
    expect(
      normalizeAppleVisionResult({
        text: 'Native OCR\nSecret',
        labels: [],
        confidence: 90,
        lines: [line, { text: 'Secret', confidence: 90, boundingBox: null }],
      })
    ).toBeUndefined();
  });
  it('rejects nonempty text with empty lines or incomplete text coverage', () => {
    expect(normalizeAppleVisionResult({ ...result(), lines: [] })).toBeUndefined();
    expect(
      normalizeAppleVisionResult({ ...result(), text: line.text + '\nSecret' })
    ).toBeUndefined();
  });
});
