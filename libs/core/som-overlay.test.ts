import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import {
  SOM_PALETTE,
  buildSomSvg,
  drawSomMarks,
  measureMarkLabel,
  renderSomOverlay,
  type SomRedactFn,
} from './som-overlay.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import type { SomMark } from './set-of-marks.js';

const dir = pathResolver.sharedTmp(`som-overlay-tests/${process.pid}`);

function mark(
  n: number,
  x: number,
  y: number,
  width: number,
  height: number,
  label?: string
): SomMark {
  return {
    n,
    box: { x, y, width, height },
    center: { x: Math.round(x + width / 2), y: Math.round(y + height / 2) },
    kind: 'control',
    ...(label ? { label } : {}),
    sources: ['dom'],
  };
}

function pixel(bitmap: { width: number; data: Uint8Array | Buffer }, x: number, y: number) {
  const offset = (y * bitmap.width + x) * 4;
  return [bitmap.data[offset], bitmap.data[offset + 1], bitmap.data[offset + 2]];
}

async function writeGreyImage(name: string, width: number, height: number): Promise<string> {
  const data = Buffer.alloc(width * height * 4, 128);
  const file = path.join(dir, name);
  safeWriteFile(file, await new Jimp({ data, width, height }).getBuffer('image/png'));
  return file;
}

/** Blacks the image out and consumes the raw input, like the real redaction. */
const blackoutRedact: SomRedactFn = async (inputPath, outputPath) => {
  const image = await Jimp.read(safeReadFile(inputPath, { encoding: null }) as Buffer);
  image.bitmap.data.fill(0);
  for (let i = 3; i < image.bitmap.data.length; i += 4) image.bitmap.data[i] = 255;
  safeWriteFile(outputPath, await image.getBuffer('image/png'));
  safeRmSync(inputPath, { force: true });
};

afterEach(() => {
  safeRmSync(dir, { recursive: true, force: true });
});

describe('drawSomMarks', () => {
  it('draws the box outline in the mark colour and white digits in the badge', () => {
    const width = 120;
    const height = 80;
    const bitmap = { width, height, data: Buffer.alloc(width * height * 4) };
    drawSomMarks(bitmap, [mark(1, 20, 40, 60, 30)]);
    expect(pixel(bitmap, 50, 40)).toEqual([...SOM_PALETTE[0]]); // top edge
    expect(pixel(bitmap, 79, 55)).toEqual([...SOM_PALETTE[0]]); // right edge
    expect(pixel(bitmap, 50, 55)).toEqual([0, 0, 0]); // interior untouched

    const badge = measureMarkLabel(1);
    expect(badge).toEqual({ width: 18, height: 22 });
    // Badge sits above the box; digit "1" (row 0 = 00100) has a white stroke at glyph column 2.
    const originY = 40 - badge.height;
    expect(pixel(bitmap, 20, originY)).toEqual([...SOM_PALETTE[0]]);
    expect(pixel(bitmap, 20 + 4 + 2 * 2, originY + 4)).toEqual([255, 255, 255]);
  });

  it('keeps badges inside the image for marks at the top edge', () => {
    const width = 40;
    const height = 40;
    const bitmap = { width, height, data: Buffer.alloc(width * height * 4) };
    drawSomMarks(bitmap, [mark(12, 30, 0, 10, 10)]);
    // "12" badge is 30px wide: shifted left to fit, drawn inside the box row.
    expect(pixel(bitmap, 10, 0)).toEqual([...SOM_PALETTE[3]]);
  });
});

describe('buildSomSvg', () => {
  it('emits one group per mark with escaped labels and refs', () => {
    const svg = buildSomSvg({ width: 200, height: 100 }, [
      { ...mark(1, 10, 30, 50, 20, 'Save & <close>'), ref: '@e1' },
      mark(2, 100, 30, 50, 20),
    ]);
    expect(svg).toContain('width="200" height="100" viewBox="0 0 200 100"');
    expect(svg.match(/<g data-mark=/g)).toHaveLength(2);
    expect(svg).toContain(
      '<g data-mark="1" data-ref="@e1"><title>Save &amp; &lt;close&gt;</title>'
    );
    expect(svg).toContain('stroke="#e6194b"');
    expect(svg).not.toContain('<close>');
  });
});

describe('renderSomOverlay', () => {
  it('redacts before drawing and writes a same-size PNG plus SVG', async () => {
    const source = await writeGreyImage('screen.png', 160, 90);
    const output = path.join(dir, 'out', 'screen.marked.png');
    const result = await renderSomOverlay(
      { image_path: source, marks: [mark(1, 40, 40, 60, 30, 'OK')], output_path: output },
      { redact: blackoutRedact }
    );

    expect(result).toEqual({
      annotated_path: output,
      svg_path: path.join(dir, 'out', 'screen.marked.svg'),
      image: { width: 160, height: 90 },
    });
    const annotated = await Jimp.read(safeReadFile(output, { encoding: null }) as Buffer);
    expect([annotated.bitmap.width, annotated.bitmap.height]).toEqual([160, 90]);
    expect(pixel(annotated.bitmap, 150, 85)).toEqual([0, 0, 0]); // redacted, not the grey source
    expect(pixel(annotated.bitmap, 70, 40)).toEqual([...SOM_PALETTE[0]]);
    expect(String(safeReadFile(result.svg_path, { encoding: 'utf8' }))).toContain(
      '<title>OK</title>'
    );
    // Source untouched, redaction work files gone.
    expect(safeExistsSync(source)).toBe(true);
    expect(safeReaddir(path.join(dir, 'out')).sort()).toEqual([
      'screen.marked.png',
      'screen.marked.svg',
    ]);
  });

  it('writes nothing when redaction fails', async () => {
    const source = await writeGreyImage('fail.png', 32, 32);
    const output = path.join(dir, 'fail-out', 'fail.marked.png');
    await expect(
      renderSomOverlay(
        { image_path: source, marks: [mark(1, 0, 0, 10, 10)], output_path: output },
        {
          redact: async () => {
            throw new Error('ocr down');
          },
        }
      )
    ).rejects.toThrow('ocr down');
    expect(safeReaddir(path.join(dir, 'fail-out'))).toEqual([]);
  });
});
