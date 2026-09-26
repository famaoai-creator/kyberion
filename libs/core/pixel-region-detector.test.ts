import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import { iou, type SomBox } from './set-of-marks.js';
import {
  PixelRegionDetector,
  detectPixelRegions,
  type PixelBitmap,
} from './pixel-region-detector.js';

const dir = pathResolver.sharedTmp(`pixel-region-detector-tests/${process.pid}`);

afterAll(() => {
  safeRmSync(dir, { recursive: true, force: true });
});

type Rgb = readonly [number, number, number];

function canvas(width: number, height: number, background: (x: number, y: number) => Rgb) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = background(x, y);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  return { width, height, data } satisfies PixelBitmap;
}

function paint(bitmap: PixelBitmap, x: number, y: number, rgb: Rgb) {
  const offset = (y * bitmap.width + x) * 4;
  bitmap.data[offset] = rgb[0];
  bitmap.data[offset + 1] = rgb[1];
  bitmap.data[offset + 2] = rgb[2];
}

function fillRect(bitmap: PixelBitmap, box: SomBox, rgb: Rgb) {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) paint(bitmap, x, y, rgb);
  }
}

function outlineRect(bitmap: PixelBitmap, box: SomBox, stroke: number, rgb: Rgb) {
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const inside =
        x >= box.x + stroke &&
        x < box.x + box.width - stroke &&
        y >= box.y + stroke &&
        y < box.y + box.height - stroke;
      if (!inside) paint(bitmap, x, y, rgb);
    }
  }
}

/** A gear-like icon: a filled disc with a hole, no text anywhere. */
function ringIcon(bitmap: PixelBitmap, cx: number, cy: number, radius: number, rgb: Rgb) {
  for (let y = cy - radius; y <= cy + radius; y += 1) {
    for (let x = cx - radius; x <= cx + radius; x += 1) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= radius && d >= radius / 3) paint(bitmap, x, y, rgb);
    }
  }
}

const FILLED: SomBox = { x: 40, y: 40, width: 100, height: 32 };
const OUTLINED: SomBox = { x: 200, y: 40, width: 120, height: 36 };
const ICON: SomBox = { x: 50, y: 190, width: 21, height: 21 };
const CROSS: SomBox = { x: 150, y: 190, width: 20, height: 20 };

function uiScene(background: (x: number, y: number) => Rgb): PixelBitmap {
  const bitmap = canvas(400, 300, background);
  fillRect(bitmap, FILLED, [30, 90, 200]);
  outlineRect(bitmap, OUTLINED, 2, [90, 90, 90]);
  ringIcon(bitmap, 60, 200, 10, [40, 40, 40]);
  fillRect(bitmap, { x: 158, y: 190, width: 4, height: 20 }, [20, 20, 20]);
  fillRect(bitmap, { x: 150, y: 198, width: 20, height: 4 }, [20, 20, 20]);
  return bitmap;
}

function bestIou(boxes: readonly SomBox[], target: SomBox): number {
  return Math.max(0, ...boxes.map((box) => iou(box, target)));
}

describe('detectPixelRegions', () => {
  it.each([
    ['plain background', () => [245, 245, 245] as const],
    [
      'gradient background',
      (x: number, y: number) =>
        [200 + Math.round((x / 400) * 50), 205 + Math.round((y / 300) * 40), 230] as const,
    ],
  ])('finds unlabelled controls and icons on a %s', (_name, background) => {
    const regions = detectPixelRegions(uiScene(background));
    const boxes = regions.map((region) => region.box);
    for (const target of [FILLED, OUTLINED, ICON, CROSS]) {
      expect(bestIou(boxes, target)).toBeGreaterThan(0.75);
    }
    expect(regions).toHaveLength(4);
    const icon = regions.find((region) => iou(region.box, ICON) > 0.75);
    expect(icon?.kind).toBe('icon');
    expect(regions.find((region) => iou(region.box, OUTLINED) > 0.75)?.kind).toBe('control');
    for (const region of regions) {
      expect(region.score).toBeGreaterThanOrEqual(0.3);
      expect(region.score).toBeLessThanOrEqual(0.6);
    }
  });

  it('merges the glyph inside a button into the button', () => {
    const bitmap = uiScene(() => [245, 245, 245]);
    fillRect(bitmap, { x: 80, y: 50, width: 20, height: 12 }, [255, 255, 255]);
    const regions = detectPixelRegions(bitmap);
    const inFilled = regions.filter((region) => {
      const cx = region.box.x + region.box.width / 2;
      const cy = region.box.y + region.box.height / 2;
      return (
        cx >= FILLED.x &&
        cx < FILLED.x + FILLED.width &&
        cy >= FILLED.y &&
        cy < FILLED.y + FILLED.height
      );
    });
    expect(inFilled).toHaveLength(1);
    expect(iou(inFilled[0].box, FILLED)).toBeGreaterThan(0.75);
    // Without the nested merge the glyph would be a second region.
    const unmerged = detectPixelRegions(bitmap, { minNestedShare: 1, mergeIou: 1 });
    expect(unmerged.length).toBe(regions.length + 1);
  });

  it('finds nothing on a blank image and does not flood a noisy one', () => {
    expect(detectPixelRegions(canvas(320, 200, () => [128, 128, 128]))).toEqual([]);
    let seed = 42;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % 256;
    };
    const noisy = canvas(320, 200, () => {
      const v = next();
      return [v, v, v] as const;
    });
    expect(detectPixelRegions(noisy).length).toBeLessThanOrEqual(3);
  });

  it('is deterministic, downscales large images and scales boxes back', () => {
    const small = uiScene(() => [245, 245, 245]);
    const large = canvas(1600, 1200, () => [245, 245, 245]);
    for (let y = 0; y < 1200; y += 1) {
      for (let x = 0; x < 1600; x += 1) {
        const source = ((Math.floor(y / 4) * 400 + Math.floor(x / 4)) * 4) as number;
        const offset = (y * 1600 + x) * 4;
        large.data[offset] = small.data[source];
        large.data[offset + 1] = small.data[source + 1];
        large.data[offset + 2] = small.data[source + 2];
      }
    }
    const first = detectPixelRegions(large, { maxWorkSide: 400 });
    expect(detectPixelRegions(large, { maxWorkSide: 400 })).toEqual(first);
    const scaled = (box: SomBox) => ({
      x: box.x * 4,
      y: box.y * 4,
      width: box.width * 4,
      height: box.height * 4,
    });
    for (const target of [FILLED, OUTLINED, ICON, CROSS]) {
      expect(
        bestIou(
          first.map((region) => region.box),
          scaled(target)
        )
      ).toBeGreaterThan(0.75);
    }
  });

  it('caps the number of regions', () => {
    const bitmap = canvas(400, 300, () => [245, 245, 245]);
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        fillRect(bitmap, { x: 10 + col * 48, y: 10 + row * 48, width: 24, height: 24 }, [0, 0, 0]);
      }
    }
    expect(detectPixelRegions(bitmap)).toHaveLength(48);
    expect(detectPixelRegions(bitmap, { maxRegions: 5 })).toHaveLength(5);
  });
});

describe('size guards', () => {
  it('skips an image over the pixel limit before decoding it', async () => {
    let decoded = 0;
    const detector = new PixelRegionDetector({
      readBitmap: async () => {
        decoded += 1;
        return uiScene(() => [245, 245, 245]);
      },
    });
    const huge = { image_path: 'huge.png', image_size: { width: 10_000, height: 5_000 } };
    expect(await detector.detect(huge)).toEqual([]);
    expect(decoded).toBe(0);
    expect(
      detectPixelRegions(
        uiScene(() => [245, 245, 245]),
        { maxImagePixels: 1000 }
      )
    ).toEqual([]);
  });

  it('keeps only the strongest components before merging', () => {
    const bitmap = canvas(400, 300, () => [245, 245, 245]);
    for (let row = 0; row < 6; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        fillRect(bitmap, { x: 10 + col * 48, y: 10 + row * 48, width: 24, height: 24 }, [0, 0, 0]);
      }
    }
    expect(detectPixelRegions(bitmap, { maxComponents: 7 })).toHaveLength(7);
  });
});

describe('PixelRegionDetector', () => {
  it('reads the screenshot from disk and returns detector candidates without labels', async () => {
    const bitmap = uiScene(() => [245, 245, 245]);
    const file = path.join(dir, 'scene.png');
    safeWriteFile(file, await new Jimp(bitmap).getBuffer('image/png'));
    const detector = new PixelRegionDetector();
    const request = { image_path: file, image_size: { width: 400, height: 300 } };
    expect(await detector.isAvailable(request)).toBe(true);
    const candidates = await detector.detect(request);
    expect(candidates).toHaveLength(4);
    for (const candidate of candidates) {
      expect(candidate.source).toBe('detector');
      expect(candidate.label).toBeUndefined();
    }
  });

  it('is unavailable for a missing image', async () => {
    const detector = new PixelRegionDetector();
    expect(
      await detector.isAvailable({
        image_path: path.join(dir, 'missing.png'),
        image_size: { width: 1, height: 1 },
      })
    ).toBe(false);
  });
});
