import path from 'node:path';
import { Jimp } from 'jimp';
import { dhashRegion } from './image-dhash.js';
import { redactScreenCaptureFile } from './screen-frame-redaction.js';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';
import type { SomImageSize, SomMark } from './set-of-marks.js';

/**
 * Set-of-Marks overlay: numbered boxes drawn on a redacted copy of the
 * screenshot, plus an equivalent SVG (boxes + numbers only, no pixels) for
 * audit and for viewers that composite the overlay themselves.
 *
 * Numbers are drawn with a built-in 5x7 digit font so rendering needs no font
 * files and is byte-for-byte deterministic.
 */

const DIGIT_GLYPHS: Record<string, readonly string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
};
const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_SPACING = 1;

/** Distinct, high-contrast colours; mark n uses PALETTE[(n - 1) % length]. */
export const SOM_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
  [230, 25, 75],
  [60, 180, 75],
  [0, 130, 200],
  [245, 130, 48],
  [145, 30, 180],
  [240, 50, 230],
  [0, 128, 128],
  [128, 0, 0],
];

export interface SomBitmap {
  width: number;
  height: number;
  /** RGBA, row-major. Mutated in place. */
  data: Uint8Array | Buffer;
}

export interface DrawSomOptions {
  /** Box stroke width in pixels. Default 2. */
  stroke?: number;
  /** Integer glyph scale. Default 2 (10x14 px digits). */
  glyphScale?: number;
}

export type SomRedactFn = (inputPath: string, outputPath: string) => Promise<void>;

export interface RenderSomOverlayInput {
  /** Screenshot to annotate. It is read, never modified or removed. */
  image_path: string;
  marks: readonly SomMark[];
  /** Annotated PNG destination. */
  output_path: string;
  /** SVG destination; defaults to output_path with an .svg extension. */
  svg_output_path?: string;
}

export interface RenderSomOverlayDeps {
  /** Must write a redacted copy to outputPath; may consume inputPath. */
  redact?: SomRedactFn;
}

export interface SomOverlayResult {
  annotated_path: string;
  svg_path: string;
  image: SomImageSize;
}

function colorFor(n: number): readonly [number, number, number] {
  return SOM_PALETTE[(Math.max(1, n) - 1) % SOM_PALETTE.length];
}

function fillRect(
  bitmap: SomBitmap,
  x: number,
  y: number,
  width: number,
  height: number,
  rgb: readonly [number, number, number]
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(bitmap.width, Math.floor(x + width));
  const y1 = Math.min(bitmap.height, Math.floor(y + height));
  for (let py = y0; py < y1; py += 1) {
    for (let px = x0; px < x1; px += 1) {
      const offset = (py * bitmap.width + px) * 4;
      bitmap.data[offset] = rgb[0];
      bitmap.data[offset + 1] = rgb[1];
      bitmap.data[offset + 2] = rgb[2];
      bitmap.data[offset + 3] = 255;
    }
  }
}

export function measureMarkLabel(n: number, glyphScale = 2): { width: number; height: number } {
  const digits = String(n).length;
  const padding = glyphScale * 2;
  return {
    width:
      digits * (GLYPH_WIDTH + GLYPH_SPACING) * glyphScale -
      GLYPH_SPACING * glyphScale +
      padding * 2,
    height: GLYPH_HEIGHT * glyphScale + padding * 2,
  };
}

function drawDigits(
  bitmap: SomBitmap,
  text: string,
  x: number,
  y: number,
  glyphScale: number,
  rgb: readonly [number, number, number]
): void {
  let cursor = x;
  for (const char of text) {
    const glyph = DIGIT_GLYPHS[char];
    if (glyph) {
      glyph.forEach((row, gy) => {
        for (let gx = 0; gx < GLYPH_WIDTH; gx += 1) {
          if (row[gx] !== '1') continue;
          fillRect(
            bitmap,
            cursor + gx * glyphScale,
            y + gy * glyphScale,
            glyphScale,
            glyphScale,
            rgb
          );
        }
      });
    }
    cursor += (GLYPH_WIDTH + GLYPH_SPACING) * glyphScale;
  }
}

/** Top-left of the number badge: just above the box, or inside it at the top edge. */
function badgeOrigin(
  mark: SomMark,
  badge: { width: number; height: number },
  bitmap: SomImageSize
) {
  const x = Math.min(Math.max(0, Math.round(mark.box.x)), Math.max(0, bitmap.width - badge.width));
  const above = Math.round(mark.box.y) - badge.height;
  const y =
    above >= 0
      ? above
      : Math.max(0, Math.min(Math.round(mark.box.y), bitmap.height - badge.height));
  return { x, y };
}

/** Draws numbered boxes onto an RGBA bitmap in place. */
export function drawSomMarks(
  bitmap: SomBitmap,
  marks: readonly SomMark[],
  options: DrawSomOptions = {}
): void {
  const stroke = Math.max(1, Math.floor(options.stroke ?? 2));
  const glyphScale = Math.max(1, Math.floor(options.glyphScale ?? 2));
  for (const mark of marks) {
    const rgb = colorFor(mark.n);
    const { x, y, width, height } = mark.box;
    fillRect(bitmap, x, y, width, stroke, rgb);
    fillRect(bitmap, x, y + height - stroke, width, stroke, rgb);
    fillRect(bitmap, x, y, stroke, height, rgb);
    fillRect(bitmap, x + width - stroke, y, stroke, height, rgb);
  }
  // Badges after all boxes so a later box never paints over an earlier number.
  for (const mark of marks) {
    const badge = measureMarkLabel(mark.n, glyphScale);
    const origin = badgeOrigin(mark, badge, bitmap);
    fillRect(bitmap, origin.x, origin.y, badge.width, badge.height, colorFor(mark.n));
    const padding = glyphScale * 2;
    drawDigits(
      bitmap,
      String(mark.n),
      origin.x + padding,
      origin.y + padding,
      glyphScale,
      [255, 255, 255]
    );
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function rgbHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

/** SVG with the same boxes and numbers as drawSomMarks (no image pixels). */
export function buildSomSvg(
  image: SomImageSize,
  marks: readonly SomMark[],
  options: DrawSomOptions = {}
): string {
  const stroke = Math.max(1, Math.floor(options.stroke ?? 2));
  const glyphScale = Math.max(1, Math.floor(options.glyphScale ?? 2));
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}">`,
  ];
  for (const mark of marks) {
    const color = rgbHex(colorFor(mark.n));
    const badge = measureMarkLabel(mark.n, glyphScale);
    const origin = badgeOrigin(mark, badge, image);
    const title = mark.label ? `<title>${escapeXml(mark.label)}</title>` : '';
    const ref = mark.ref ? ` data-ref="${escapeXml(mark.ref)}"` : '';
    lines.push(
      `  <g data-mark="${mark.n}"${ref}>${title}`,
      `    <rect x="${mark.box.x + stroke / 2}" y="${mark.box.y + stroke / 2}" width="${Math.max(0, mark.box.width - stroke)}" height="${Math.max(0, mark.box.height - stroke)}" fill="none" stroke="${color}" stroke-width="${stroke}"/>`,
      `    <rect x="${origin.x}" y="${origin.y}" width="${badge.width}" height="${badge.height}" fill="${color}"/>`,
      `    <text x="${origin.x + badge.width / 2}" y="${origin.y + badge.height / 2}" fill="#ffffff" font-family="monospace" font-size="${GLYPH_HEIGHT * glyphScale}" text-anchor="middle" dominant-baseline="central">${mark.n}</text>`,
      '  </g>'
    );
  }
  lines.push('</svg>');
  return `${lines.join('\n')}\n`;
}

function readImageBuffer(filePath: string): Buffer {
  const payload = safeReadFile(filePath, { encoding: null });
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}

/** Size and dHash of a screenshot, decoded once. */
export async function inspectSomImage(
  filePath: string
): Promise<{ image: SomImageSize; dhash: string }> {
  const decoded = await Jimp.read(readImageBuffer(filePath));
  return {
    image: { width: decoded.bitmap.width, height: decoded.bitmap.height },
    dhash: dhashRegion(decoded.bitmap),
  };
}

/**
 * Redacts the screenshot, then draws the marks on the redacted copy. The raw
 * pixels never reach output_path: the redaction work files sit next to it and
 * are removed before returning.
 */
export async function renderSomOverlay(
  input: RenderSomOverlayInput,
  deps: RenderSomOverlayDeps = {}
): Promise<SomOverlayResult> {
  const redact = deps.redact ?? redactScreenCaptureFile;
  const source = readImageBuffer(input.image_path);
  const sourceImage = await Jimp.read(source);
  const image = { width: sourceImage.bitmap.width, height: sourceImage.bitmap.height };

  const outputDir = path.dirname(input.output_path);
  safeMkdir(outputDir, { recursive: true });
  const stem = path.basename(input.output_path, path.extname(input.output_path));
  const rawPath = path.join(outputDir, `.${stem}.raw.png`);
  const redactedPath = path.join(outputDir, `.${stem}.redacted.png`);
  try {
    safeWriteFile(rawPath, source);
    await redact(rawPath, redactedPath);
    const redacted = await Jimp.read(readImageBuffer(redactedPath));
    if (redacted.bitmap.width !== image.width || redacted.bitmap.height !== image.height) {
      throw new Error('[SOM_OVERLAY_REDACTION] redacted image dimensions differ from the input');
    }
    drawSomMarks(redacted.bitmap, input.marks);
    safeWriteFile(input.output_path, await redacted.getBuffer('image/png'));
  } finally {
    safeRmSync(rawPath, { force: true });
    safeRmSync(redactedPath, { force: true });
  }

  const svgPath = input.svg_output_path ?? path.join(outputDir, `${stem}.svg`);
  safeWriteFile(svgPath, buildSomSvg(image, input.marks));
  return { annotated_path: input.output_path, svg_path: svgPath, image };
}
