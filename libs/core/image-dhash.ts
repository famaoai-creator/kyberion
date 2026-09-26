import { Jimp } from 'jimp';
import { safeReadFile } from './secure-io.js';

/**
 * Difference hash (dHash) for cheap "did this picture change?" checks.
 *
 * The region is reduced to a 9x8 luminance grid by box-averaging (not by
 * resampling, so every source pixel contributes and small edits are not
 * skipped), then each of the 64 bits records whether a cell is brighter than
 * its right-hand neighbour. Two hashes are compared by Hamming distance:
 * 0 means visually identical, a handful means minor noise, and ~32 means
 * unrelated content.
 */

const HASH_COLS = 9;
const HASH_ROWS = 8;
export const DHASH_BITS = 64;

export interface DHashBitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array | Buffer;
}

export interface DHashRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

function luma(data: DHashBitmap['data'], offset: number): number {
  return 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
}

/** dHash of a rectangular region of an RGBA bitmap, as 16 lowercase hex chars. */
export function dhashRegion(bitmap: DHashBitmap, region?: DHashRegion): string {
  const x0 = Math.max(0, Math.floor(region?.x ?? 0));
  const y0 = Math.max(0, Math.floor(region?.y ?? 0));
  const x1 = Math.min(bitmap.width, x0 + Math.floor(region?.width ?? bitmap.width));
  const y1 = Math.min(bitmap.height, y0 + Math.floor(region?.height ?? bitmap.height));
  const width = x1 - x0;
  const height = y1 - y0;
  if (width <= 0 || height <= 0) {
    throw new Error('[DHASH_EMPTY_REGION] region has no pixels inside the bitmap');
  }

  const cells = new Float64Array(HASH_COLS * HASH_ROWS);
  for (let row = 0; row < HASH_ROWS; row += 1) {
    const cy0 = y0 + Math.floor((row * height) / HASH_ROWS);
    const cy1 = Math.max(cy0 + 1, y0 + Math.floor(((row + 1) * height) / HASH_ROWS));
    for (let col = 0; col < HASH_COLS; col += 1) {
      const cx0 = x0 + Math.floor((col * width) / HASH_COLS);
      const cx1 = Math.max(cx0 + 1, x0 + Math.floor(((col + 1) * width) / HASH_COLS));
      let sum = 0;
      let count = 0;
      for (let y = cy0; y < Math.min(cy1, y1); y += 1) {
        for (let x = cx0; x < Math.min(cx1, x1); x += 1) {
          sum += luma(bitmap.data, (y * bitmap.width + x) * 4);
          count += 1;
        }
      }
      cells[row * HASH_COLS + col] = count > 0 ? sum / count : 0;
    }
  }

  let hash = 0n;
  for (let row = 0; row < HASH_ROWS; row += 1) {
    for (let col = 0; col < HASH_COLS - 1; col += 1) {
      const left = cells[row * HASH_COLS + col];
      const right = cells[row * HASH_COLS + col + 1];
      hash = (hash << 1n) | (left > right ? 1n : 0n);
    }
  }
  return hash.toString(16).padStart(DHASH_BITS / 4, '0');
}

/** dHash of an encoded image (PNG / JPEG / BMP ...). */
export async function dhashBuffer(buffer: Buffer): Promise<string> {
  const image = await Jimp.read(buffer);
  return dhashRegion(image.bitmap);
}

/** dHash of an image file, read through secure-io. */
export async function dhashFile(filePath: string): Promise<string> {
  const payload = safeReadFile(filePath, { encoding: null });
  return dhashBuffer(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
}

const HEX_HASH = /^[0-9a-f]{16}$/;

/** Number of differing bits between two dHashes (0..64). */
export function hamming(a: string, b: string): number {
  if (!HEX_HASH.test(a) || !HEX_HASH.test(b)) {
    throw new Error('[DHASH_INVALID] dHash must be 16 lowercase hex characters');
  }
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}
