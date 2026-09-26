import { describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { dhashBuffer, dhashFile, dhashRegion, hamming, type DHashBitmap } from './image-dhash.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';

/** Deterministic textured bitmap: a diagonal gradient with vertical stripes. */
function texturedBitmap(width: number, height: number, seed = 0): DHashBitmap {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const stripe = Math.floor((x + seed) / 7) % 2 === 0 ? 60 : 0;
      const value = Math.min(255, Math.floor(((x + y * 2 + seed * 13) % 160) + stripe));
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data };
}

function withBlock(
  bitmap: DHashBitmap,
  block: { x: number; y: number; size: number; value: number }
): DHashBitmap {
  const data = new Uint8Array(bitmap.data);
  for (let y = block.y; y < block.y + block.size; y += 1) {
    for (let x = block.x; x < block.x + block.size; x += 1) {
      const offset = (y * bitmap.width + x) * 4;
      data[offset] = block.value;
      data[offset + 1] = block.value;
      data[offset + 2] = block.value;
    }
  }
  return { ...bitmap, data };
}

describe('dhashRegion', () => {
  it('is a 64-bit hex hash and deterministic', () => {
    const bitmap = texturedBitmap(90, 80);
    const first = dhashRegion(bitmap);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(dhashRegion(texturedBitmap(90, 80))).toBe(first);
  });

  it('gives distance 0 for identical images', () => {
    expect(hamming(dhashRegion(texturedBitmap(90, 80)), dhashRegion(texturedBitmap(90, 80)))).toBe(
      0
    );
  });

  it('gives a small distance for a small local change', () => {
    const base = texturedBitmap(180, 160);
    const edited = withBlock(base, { x: 40, y: 40, size: 6, value: 255 });
    const distance = hamming(dhashRegion(base), dhashRegion(edited));
    expect(distance).toBeGreaterThan(0);
    expect(distance).toBeLessThanOrEqual(5);
  });

  it('gives a large distance for unrelated content', () => {
    const base = texturedBitmap(180, 160);
    const other = { ...base, data: new Uint8Array(base.data) };
    for (let y = 0; y < other.height; y += 1) {
      for (let x = 0; x < other.width; x += 1) {
        const offset = (y * other.width + x) * 4;
        const value = 255 - base.data[(y * base.width + (base.width - 1 - x)) * 4];
        other.data[offset] = value;
        other.data[offset + 1] = value;
        other.data[offset + 2] = value;
      }
    }
    expect(hamming(dhashRegion(base), dhashRegion(other))).toBeGreaterThan(20);
  });

  it('hashes a sub-region independently of pixels outside it', () => {
    const base = texturedBitmap(200, 100);
    const edited = withBlock(base, { x: 150, y: 10, size: 40, value: 0 });
    const left = { x: 0, y: 0, width: 100, height: 100 };
    expect(dhashRegion(edited, left)).toBe(dhashRegion(base, left));
  });

  it('refuses an empty region', () => {
    expect(() => dhashRegion(texturedBitmap(10, 10), { x: 20, y: 0, width: 5, height: 5 })).toThrow(
      /DHASH_EMPTY_REGION/
    );
  });
});

describe('hamming', () => {
  it('counts differing bits', () => {
    expect(hamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hamming('0000000000000001', '0000000000000003')).toBe(1);
  });

  it('rejects malformed hashes', () => {
    expect(() => hamming('xyz', '0000000000000000')).toThrow(/DHASH_INVALID/);
  });
});

describe('dhashBuffer / dhashFile', () => {
  it('decodes an encoded image and matches the bitmap hash', async () => {
    const bitmap = texturedBitmap(64, 48, 3);
    const png = await new Jimp({
      data: Buffer.from(bitmap.data),
      width: bitmap.width,
      height: bitmap.height,
    }).getBuffer('image/png');
    expect(await dhashBuffer(png)).toBe(dhashRegion(bitmap));

    const file = pathResolver.sharedTmp('image-dhash-tests/fixture.png');
    safeWriteFile(file, png);
    try {
      expect(await dhashFile(file)).toBe(dhashRegion(bitmap));
    } finally {
      safeRmSync(file, { force: true });
    }
  });
});
