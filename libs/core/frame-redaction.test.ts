import { describe, expect, it } from 'vitest';
import { prepareDistillationEgress, redactFrame, type RgbaFrame } from './frame-redaction.js';

const frame = (): RgbaFrame => ({
  width: 4,
  height: 4,
  pixels: new Uint8Array(4 * 4 * 4).fill(255),
});
const ocr = (text: string) => ({
  status: 'succeeded' as const,
  provider: 'fixture',
  text,
  confidence: 1,
  elapsedMs: 0,
  lines: [{ text, confidence: 1, boundingBox: { x: 0, y: 0, width: 4, height: 2 } }],
});

describe('frame redaction and egress', () => {
  it('uses opaque rectangles and cross-feeds a text secret even when OCR is imperfect', () => {
    const result = redactFrame({
      frame: frame(),
      ocr: ocr('blurred text'),
      knownSensitiveText: ['token-value-123'],
    });
    expect(result.status).toBe('redacted');
    expect(result.regions[0].reason).toBe('known_sensitive_value');
    expect(result.frame?.pixels[0]).toBe(0);
    expect(result.frame?.pixels[3]).toBe(255);
  });

  it('withholds both channels when scanning cannot complete', () => {
    const result = prepareDistillationEgress({
      text: 'safe text',
      frame: frame(),
      ocr: {
        status: 'failed',
        provider: 'fixture',
        text: '',
        confidence: 0,
        elapsedMs: 1,
        error: 'scanner failed',
      },
    });
    expect(result.status).toBe('withheld');
    expect(result.text).toBeUndefined();
    expect(result.frame).toBeUndefined();
  });

  it('keeps high-entropy frame heuristics out of the text path', () => {
    const token = 'Ab3dEf5gHi7jKl9mNop2';
    const textOnly = prepareDistillationEgress({ text: token });
    expect(textOnly.status).toBe('ready');
    expect(textOnly.text).toBe(token);
  });

  it('withholds text when a caller-provided secret is present even without a frame', () => {
    const result = prepareDistillationEgress({
      text: 'captured token-value-123',
      known_sensitive_text: ['token-value-123'],
    });
    expect(result).toMatchObject({ status: 'withheld', reason: 'known_sensitive_text_detected' });
  });

  it('withholds a frame when OCR finds PII but cannot provide coordinates', () => {
    const result = redactFrame({
      frame: frame(),
      ocr: { ...ocr('person@example.com'), lines: [{ text: 'person@example.com', confidence: 1 }] },
    });
    expect(result).toMatchObject({ status: 'withheld', reason: 'pii_coordinates_unavailable' });
    expect(result.frame).toBeUndefined();
  });

  describe('bounding box units', () => {
    const wide = (): RgbaFrame => ({
      width: 100,
      height: 50,
      pixels: new Uint8Array(100 * 50 * 4).fill(255),
    });
    const piiOcr = (
      boundingBox: { x: number; y: number; width: number; height: number },
      units?: string
    ) => ({
      ...ocr('person@example.com'),
      lines: [{ text: 'person@example.com', confidence: 1, boundingBox }],
      ...(units !== undefined ? { boundingBoxUnits: units as 'pixel' } : {}),
    });
    const black = (result: ReturnType<typeof redactFrame>, x: number, y: number) =>
      result.frame?.pixels[(y * 100 + x) * 4] === 0;

    it('scales normalized boxes to the frame before filling', () => {
      const result = redactFrame({
        frame: wide(),
        ocr: piiOcr({ x: 0.2, y: 0.4, width: 0.5, height: 0.2 }, 'normalized'),
      });
      expect(result.status).toBe('redacted');
      expect(result.regions[0]).toMatchObject({ x: 20, y: 20, width: 50, height: 10 });
      expect(black(result, 20, 20)).toBe(true);
      expect(black(result, 45, 25)).toBe(true);
      expect(black(result, 69, 29)).toBe(true);
      expect(black(result, 19, 25)).toBe(false);
      expect(black(result, 70, 25)).toBe(false);
      expect(black(result, 45, 30)).toBe(false);
    });

    it('scales a normalized known-sensitive box too', () => {
      const result = redactFrame({
        frame: wide(),
        ocr: {
          ...ocr('key sk-live-1'),
          lines: [
            {
              text: 'key sk-live-1',
              confidence: 1,
              boundingBox: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 },
            },
          ],
          boundingBoxUnits: 'normalized' as const,
        },
        knownSensitiveText: ['sk-live-1'],
      });
      expect(result.regions[0]).toMatchObject({ x: 50, y: 25, width: 50, height: 25 });
      expect(black(result, 99, 49)).toBe(true);
      expect(black(result, 10, 10)).toBe(false);
    });

    it('keeps pixel semantics when units are undeclared or pixel', () => {
      for (const units of [undefined, 'pixel']) {
        const result = redactFrame({
          frame: wide(),
          ocr: piiOcr({ x: 0, y: 0, width: 1, height: 1 }, units),
        });
        expect(result.regions[0]).toMatchObject({ x: 0, y: 0, width: 1, height: 1 });
        expect(black(result, 0, 0)).toBe(true);
        expect(black(result, 1, 0)).toBe(false);
      }
    });

    it('withholds the frame when the units are unknown', () => {
      const result = redactFrame({
        frame: wide(),
        ocr: piiOcr({ x: 0.2, y: 0.4, width: 0.5, height: 0.2 }, 'inches'),
      });
      expect(result).toMatchObject({
        status: 'withheld',
        reason: 'ocr_bounding_box_units_unknown',
      });
      expect(result.frame).toBeUndefined();
    });

    it('withholds the frame when a finding has a non-finite box', () => {
      const result = redactFrame({
        frame: wide(),
        ocr: piiOcr({ x: Number.NaN, y: 0, width: 1, height: 1 }, 'normalized'),
      });
      expect(result).toMatchObject({ status: 'withheld', reason: 'pii_coordinates_unavailable' });
    });
  });
});
