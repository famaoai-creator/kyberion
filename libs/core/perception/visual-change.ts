import { sniffImageDimensions } from './image-dimensions.js';
import { Jimp } from 'jimp';
import { safeReadFile, assertSafeRepositoryPath, validateFileSize } from '../secure-io.js';
import { pathResolver } from '../path-resolver.js';
import { resolvePerceptionScope } from './observation.js';
import { dhashRegion, hamming } from '../media/image-dhash.js';

export interface VisualFingerprint {
  hash: string;
  pixels: number[];
}
export interface VisualChange {
  changed: boolean;
  hash_distance: number;
  pixel_difference: number;
  regions: Array<{ x: number; y: number; width: number; height: number; difference: number }>;
}

/** Small bounded fingerprint combines perceptual hash with color differences. */
export async function fingerprintImage(file: string): Promise<VisualFingerprint> {
  const absolute = assertSafeRepositoryPath(pathResolver.rootResolve(file));
  resolvePerceptionScope(absolute);
  validateFileSize(absolute, 16);
  const bytes = safeReadFile(absolute, { encoding: null }) as Buffer;
  if (bytes.subarray(0, 3).toString('ascii') === 'GIF')
    throw new Error(
      '[PERCEPTION_IMAGE_LIMIT] animated GIF comparison is unsupported; use a PNG/JPEG/BMP still'
    );
  const dimensions = sniffImageDimensions(bytes);
  if (
    !dimensions ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width * dimensions.height > 16_000_000
  )
    throw new Error(
      '[PERCEPTION_IMAGE_LIMIT] PNG/JPEG/BMP dimensions must be known and at most 16 million pixels before decoding'
    );
  const image = await Jimp.read(bytes);
  if (image.width * image.height > 16_000_000)
    throw new Error('[PERCEPTION_IMAGE_LIMIT] image exceeds 16 million pixels');
  image.resize({ w: 32, h: 32 });
  return { hash: dhashRegion(image.bitmap), pixels: Array.from(image.bitmap.data) };
}
export function compareFingerprints(
  before: VisualFingerprint,
  after: VisualFingerprint,
  threshold = 0.03
): VisualChange {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1)
    throw new Error('[PERCEPTION_INVALID] change threshold must be >0 and <=1');
  if (
    before.pixels.length !== 4096 ||
    after.pixels.length !== 4096 ||
    ![...before.pixels, ...after.pixels].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)
  )
    throw new Error('[PERCEPTION_INVALID] invalid fingerprint');
  const regions: VisualChange['regions'] = [];
  let total = 0;
  for (let row = 0; row < 4; row++)
    for (let col = 0; col < 4; col++) {
      let difference = 0;
      for (let y = row * 8; y < (row + 1) * 8; y++)
        for (let x = col * 8; x < (col + 1) * 8; x++)
          for (let channel = 0; channel < 3; channel++) {
            const i = (y * 32 + x) * 4 + channel;
            difference += Math.abs(before.pixels[i]! - after.pixels[i]!) / 255;
          }
      difference /= 8 * 8 * 3;
      total += difference;
      if (difference >= threshold)
        regions.push({ x: col / 4, y: row / 4, width: 0.25, height: 0.25, difference });
    }
  const hash_distance = hamming(before.hash, after.hash);
  return {
    changed: regions.length > 0 || hash_distance > 6,
    hash_distance,
    pixel_difference: total / 16,
    regions,
  };
}
export async function compareImages(
  before: string,
  after: string,
  threshold?: number
): Promise<VisualChange> {
  const a = resolvePerceptionScope(before),
    b = resolvePerceptionScope(after);
  if (a.tier !== b.tier || a.tenant_slug !== b.tenant_slug)
    throw new Error('[PERCEPTION_SCOPE] comparison inputs must share the same effective scope');
  return compareFingerprints(
    await fingerprintImage(before),
    await fingerprintImage(after),
    threshold
  );
}
