import { Jimp } from 'jimp';
import { safeExistsSync, safeLstat, safeReadFile } from './secure-io.js';
import { boxArea, coverageRatio, iou, type SomBox, type SomCandidate } from './set-of-marks.js';
import type { UiElementDetectionRequest, UiElementDetector } from './ui-element-detector.js';

/**
 * `pixel_regions` UI element detector: control-like regions found from pixels
 * alone, so unlabelled icons and buttons get a mark even when OCR sees no text.
 *
 * Pure, local and deterministic (no model, no network):
 *
 * 1. box-average downscale so the long side is at most MAX_WORK_SIDE;
 * 2. luma, then gradient magnitude |dL/dx| + |dL/dy| (central differences);
 * 3. adaptive threshold: a pixel is an edge when its gradient clears an
 *    absolute floor AND the mean gradient of its neighbourhood (integral image),
 *    so smooth background gradients and uniform areas never produce edges;
 * 4. morphological close (separable dilate then erode) joins the outline of a
 *    control and the glyphs of one label into one blob;
 * 5. 8-connected components with an explicit queue (no recursion);
 * 6. boxes are scaled back to image pixels and filtered by plausible control
 *    size, aspect and area share (panels, separators and specks are dropped);
 * 7. heavily overlapping boxes and small-enough nested boxes (the label or
 *    glyph inside a button) merge into the outer box; the count is capped.
 *
 * Boxes carry no label (Set-of-Marks fusion lets an OCR line inside a region
 * become its label) and score below exact sources, so DOM and accessibility
 * boxes win non-maximum suppression over the same element.
 */

export const PIXEL_REGION_DEFAULTS = {
  /** Long side of the working bitmap; larger images are box-averaged down. */
  maxWorkSide: 1400,
  /** Absolute gradient floor (0..510 scale of |dx| + |dy| on 0..255 luma). */
  edgeFloor: 24,
  /** An edge must also exceed this multiple of the local mean gradient. */
  adaptiveK: 1.1,
  /** Half-size of the local-mean window, in working pixels. */
  adaptiveRadius: 7,
  /** Morphological close radius, in working pixels. */
  closeRadius: 1,
  /** Smallest accepted side and area, in image pixels. */
  minSide: 8,
  minArea: 120,
  /** Largest accepted width/height/area as a share of the image. */
  maxWidthShare: 0.6,
  maxHeightShare: 0.35,
  maxAreaShare: 0.08,
  /** Accepted aspect range: width/height at most maxAspect, height/width at most maxTallAspect. */
  maxAspect: 20,
  maxTallAspect: 4,
  /** Overlapping boxes above this IoU merge. */
  mergeIou: 0.6,
  /** A box this covered by another, and at least minNestedShare of its area, merges into it. */
  nestedCoverage: 0.9,
  minNestedShare: 0.06,
  /** Icon: roughly square and at most this many image pixels on its long side. */
  iconMaxSide: 64,
  iconMaxAspect: 1.6,
  maxRegions: 150,
} as const;

export type PixelRegionOptions = Partial<{
  -readonly [K in keyof typeof PIXEL_REGION_DEFAULTS]: number;
}>;

export interface PixelBitmap {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  data: Uint8Array | Buffer;
}

export interface PixelRegion {
  box: SomBox;
  kind: 'icon' | 'control';
  /** 0.3..0.6: rises with edge density inside the box. */
  score: number;
}

interface Gray {
  width: number;
  height: number;
  factor: number;
  luma: Float32Array;
}

function toWorkingGray(bitmap: PixelBitmap, maxWorkSide: number): Gray {
  const factor = Math.max(1, Math.ceil(Math.max(bitmap.width, bitmap.height) / maxWorkSide));
  const width = Math.max(1, Math.floor(bitmap.width / factor));
  const height = Math.max(1, Math.floor(bitmap.height / factor));
  const luma = new Float32Array(width * height);
  const cell = factor * factor;
  const data = bitmap.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy += 1) {
        let offset = ((y * factor + dy) * bitmap.width + x * factor) * 4;
        for (let dx = 0; dx < factor; dx += 1) {
          sum += 0.299 * data[offset] + 0.587 * data[offset + 1] + 0.114 * data[offset + 2];
          offset += 4;
        }
      }
      luma[y * width + x] = sum / cell;
    }
  }
  return { width, height, factor, luma };
}

function gradientMagnitude(gray: Gray): Float32Array {
  const { width, height, luma } = gray;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const up = Math.max(0, y - 1) * width;
    const down = Math.min(height - 1, y + 1) * width;
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const left = Math.max(0, x - 1);
      const right = Math.min(width - 1, x + 1);
      out[row + x] =
        Math.abs(luma[row + right] - luma[row + left]) + Math.abs(luma[down + x] - luma[up + x]);
    }
  }
  return out;
}

function adaptiveThreshold(
  gradient: Float32Array,
  width: number,
  height: number,
  floor: number,
  k: number,
  radius: number
): Uint8Array {
  // Integral image of the gradient (Float64 to keep large sums exact enough).
  const stride = width + 1;
  const integral = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += gradient[y * width + x];
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + rowSum;
    }
  }
  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height, y + radius + 1);
    for (let x = 0; x < width; x += 1) {
      const value = gradient[y * width + x];
      if (value < floor) continue;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width, x + radius + 1);
      const sum =
        integral[y1 * stride + x1] -
        integral[y0 * stride + x1] -
        integral[y1 * stride + x0] +
        integral[y0 * stride + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      if (value >= mean * k) mask[y * width + x] = 1;
    }
  }
  return mask;
}

/** Separable binary dilate (max) or erode (min) with a square window. */
function morph(mask: Uint8Array, width: number, height: number, radius: number, dilate: boolean) {
  const target = dilate ? 1 : 0;
  const horizontal = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      let value = 1 - target;
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      for (let i = x0; i <= x1; i += 1) {
        if (mask[row + i] === target) {
          value = target;
          break;
        }
      }
      horizontal[row + x] = value;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x += 1) {
      let value = 1 - target;
      for (let j = y0; j <= y1; j += 1) {
        if (horizontal[j * width + x] === target) {
          value = target;
          break;
        }
      }
      out[y * width + x] = value;
    }
  }
  return out;
}

interface Component {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pixels: number;
}

function connectedComponents(mask: Uint8Array, width: number, height: number): Component[] {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components: Component[] = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    const component: Component = {
      x0: width,
      y0: height,
      x1: -1,
      y1: -1,
      pixels: 0,
    };
    while (head < tail) {
      const index = queue[head++];
      const x = index % width;
      const y = (index - x) / width;
      component.pixels += 1;
      if (x < component.x0) component.x0 = x;
      if (x > component.x1) component.x1 = x;
      if (y < component.y0) component.y0 = y;
      if (y > component.y1) component.y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          const neighbour = ny * width + nx;
          if (mask[neighbour] && !seen[neighbour]) {
            seen[neighbour] = 1;
            queue[tail++] = neighbour;
          }
        }
      }
    }
    components.push(component);
  }
  return components;
}

function mergeBoxes(
  regions: PixelRegion[],
  mergeIou: number,
  nestedCoverage: number,
  minNestedShare: number
) {
  // Largest first: an outer box absorbs what it contains or nearly duplicates.
  const ordered = [...regions].sort(
    (a, b) => boxArea(b.box) - boxArea(a.box) || a.box.y - b.box.y || a.box.x - b.box.x
  );
  const kept: PixelRegion[] = [];
  for (const region of ordered) {
    const owner = kept.find(
      (outer) =>
        iou(outer.box, region.box) >= mergeIou ||
        (coverageRatio(region.box, outer.box) >= nestedCoverage &&
          boxArea(region.box) >= boxArea(outer.box) * minNestedShare)
    );
    if (!owner) {
      kept.push({ ...region, box: { ...region.box } });
      continue;
    }
    const x0 = Math.min(owner.box.x, region.box.x);
    const y0 = Math.min(owner.box.y, region.box.y);
    const x1 = Math.max(owner.box.x + owner.box.width, region.box.x + region.box.width);
    const y1 = Math.max(owner.box.y + owner.box.height, region.box.y + region.box.height);
    owner.box = { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
    owner.score = Math.max(owner.score, region.score);
  }
  return kept;
}

/** Control-like regions of an RGBA bitmap, in bitmap pixels. Deterministic. */
export function detectPixelRegions(
  bitmap: PixelBitmap,
  options: PixelRegionOptions = {}
): PixelRegion[] {
  const o = { ...PIXEL_REGION_DEFAULTS, ...options };
  if (bitmap.width < 2 || bitmap.height < 2) return [];
  const gray = toWorkingGray(bitmap, o.maxWorkSide);
  const { width, height, factor } = gray;
  const edges = adaptiveThreshold(
    gradientMagnitude(gray),
    width,
    height,
    o.edgeFloor,
    o.adaptiveK,
    o.adaptiveRadius
  );
  const radius = Math.max(0, Math.round(o.closeRadius));
  const closed =
    radius > 0
      ? morph(morph(edges, width, height, radius, true), width, height, radius, false)
      : edges;

  const imageArea = bitmap.width * bitmap.height;
  const regions: PixelRegion[] = [];
  for (const component of connectedComponents(closed, width, height)) {
    const box: SomBox = {
      x: component.x0 * factor,
      y: component.y0 * factor,
      width: Math.min(bitmap.width, (component.x1 + 1) * factor) - component.x0 * factor,
      height: Math.min(bitmap.height, (component.y1 + 1) * factor) - component.y0 * factor,
    };
    const area = box.width * box.height;
    if (box.width < o.minSide || box.height < o.minSide || area < o.minArea) continue;
    if (box.width > bitmap.width * o.maxWidthShare) continue;
    if (box.height > bitmap.height * o.maxHeightShare) continue;
    if (area > imageArea * o.maxAreaShare) continue;
    if (box.width / box.height > o.maxAspect || box.height / box.width > o.maxTallAspect) continue;
    const density =
      component.pixels / ((component.x1 - component.x0 + 1) * (component.y1 - component.y0 + 1));
    const longSide = Math.max(box.width, box.height);
    const aspect = longSide / Math.min(box.width, box.height);
    regions.push({
      box,
      kind: longSide <= o.iconMaxSide && aspect <= o.iconMaxAspect ? 'icon' : 'control',
      score: Math.round((0.3 + 0.3 * Math.min(1, density)) * 1000) / 1000,
    });
  }

  const merged = mergeBoxes(regions, o.mergeIou, o.nestedCoverage, o.minNestedShare);
  return merged
    .sort((a, b) => b.score - a.score || a.box.y - b.box.y || a.box.x - b.box.x)
    .slice(0, Math.max(0, Math.floor(o.maxRegions)));
}

export function pixelRegionCandidates(regions: readonly PixelRegion[]): SomCandidate[] {
  return regions.map((region) => ({
    box: region.box,
    source: 'detector' as const,
    kind: region.kind,
    score: region.score,
  }));
}

export async function readPixelBitmap(imagePath: string): Promise<PixelBitmap> {
  const payload = safeReadFile(imagePath, { encoding: null });
  const image = await Jimp.read(Buffer.isBuffer(payload) ? payload : Buffer.from(payload));
  return image.bitmap;
}

export function isReadableImageFile(imagePath: string): boolean {
  try {
    return Boolean(imagePath) && safeExistsSync(imagePath) && safeLstat(imagePath).isFile();
  } catch {
    return false;
  }
}

export interface PixelRegionDetectorDeps {
  /** Decodes the screenshot; defaults to Jimp through secure-io. */
  readBitmap?: (imagePath: string) => Promise<PixelBitmap>;
  options?: PixelRegionOptions;
}

export class PixelRegionDetector implements UiElementDetector {
  readonly id = 'pixel_regions';
  readonly kind = 'pixels' as const;

  constructor(private readonly deps: PixelRegionDetectorDeps = {}) {}

  async isAvailable(request: UiElementDetectionRequest): Promise<boolean> {
    return this.deps.readBitmap
      ? Boolean(request.image_path)
      : isReadableImageFile(request.image_path);
  }

  async detect(request: UiElementDetectionRequest): Promise<SomCandidate[]> {
    const bitmap = await (this.deps.readBitmap ?? readPixelBitmap)(request.image_path);
    return pixelRegionCandidates(detectPixelRegions(bitmap, this.deps.options));
  }
}
