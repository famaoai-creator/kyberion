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
});
