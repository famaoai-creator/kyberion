import { pathResolver } from '../path-resolver.js';
import { safeWriteFile, safeRmSync } from '../secure-io.js';
import { randomUUID } from 'node:crypto';
import { fingerprintImage } from './visual-change.js';
import { describe, it, expect } from 'vitest';
import { compareFingerprints } from './visual-change.js';
import { observation, ocrObservations } from './observation.js';
const source = { path: 'a.png', sha256: 'a'.repeat(64), scope: { tier: 'public' as const } };
describe('grounded visual perception', () => {
  it('rejects oversized BMP and animated GIF before raster decoding', async () => {
    const file = pathResolver.sharedTmp('perception-dimensions-' + randomUUID() + '.bmp');
    try {
      const bmp = Buffer.alloc(26);
      bmp.write('BM');
      bmp.writeInt32LE(65535, 18);
      bmp.writeInt32LE(65535, 22);
      safeWriteFile(file, bmp);
      await expect(fingerprintImage(file)).rejects.toThrow('before decoding');
      const gif = Buffer.from('GIF89a000000');
      safeWriteFile(file, gif);
      await expect(fingerprintImage(file)).rejects.toThrow('animated GIF');
    } finally {
      safeRmSync(file, { force: true });
    }
  });
  it('detects uniform color changes even when dHash does not change', () => {
    const a = { hash: '0000000000000000', pixels: Array(4096).fill(0) },
      b = { hash: a.hash, pixels: Array(4096).fill(255) };
    expect(compareFingerprints(a, a)).toMatchObject({ changed: false });
    expect(compareFingerprints(a, b)).toMatchObject({ changed: true, pixel_difference: 1 });
    expect(compareFingerprints(a, b).regions).toHaveLength(16);
  });
  it('validates limits and rejects nonfinite threshold', () => {
    expect(() =>
      compareFingerprints({ hash: 'bad', pixels: [] }, { hash: 'bad', pixels: [] })
    ).toThrow();
    expect(() =>
      compareFingerprints(
        { hash: '0'.repeat(16), pixels: [] },
        { hash: '0'.repeat(16), pixels: [] },
        NaN
      )
    ).toThrow();
  });
  it('preserves normalized OCR location and source evidence', () => {
    const result = ocrObservations(
      source,
      {
        status: 'succeeded',
        provider: 'native',
        text: 'hello',
        confidence: 95,
        elapsedMs: 1,
        lines: [
          { text: 'hello', confidence: 95, boundingBox: { x: 20, y: 10, width: 40, height: 20 } },
        ],
      },
      { width: 100, height: 100 }
    );
    expect(result[0]).toMatchObject({
      source,
      confidence: 0.95,
      region: { x: 0.2, y: 0.1, width: 0.4, height: 0.2, units: 'normalized' },
    });
    expect(result[0]!.id).toBe(
      ocrObservations(
        source,
        {
          status: 'succeeded',
          provider: 'native',
          text: 'hello',
          confidence: 95,
          elapsedMs: 1,
          lines: [
            { text: 'hello', confidence: 95, boundingBox: { x: 20, y: 10, width: 40, height: 20 } },
          ],
        },
        { width: 100, height: 100 }
      )[0]!.id
    );
  });
  it('normalizes the canonical OCR-wide 0..100 confidence even below one percent', () => {
    expect(
      ocrObservations(source, {
        status: 'succeeded',
        provider: 'native',
        text: '?',
        confidence: 1,
        elapsedMs: 1,
      })[0]!.confidence
    ).toBe(0.01);
  });
  it('rejects inverted time ranges and invalid boxes', () => {
    expect(() =>
      observation(source, {
        modality: 'audio',
        kind: 'speech',
        provider: 'x',
        finality: 'final',
        time: { start_sec: 3, end_sec: 2, basis: 'aligned' },
      })
    ).toThrow();
    expect(() =>
      observation(source, {
        modality: 'image',
        kind: 'text',
        provider: 'x',
        finality: 'final',
        region: { x: 0.9, y: 0, width: 0.2, height: 1, units: 'normalized' },
      })
    ).toThrow();
  });
});
