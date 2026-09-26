import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { clearMarks, resolveMarkTarget } from '@agent/core/mark-target-resolver';
import type { SomRedactFn } from '@agent/core/som-overlay';
import { handleMarkElements } from './mark-elements.js';

const dir = pathResolver.sharedTmp(`vision-mark-elements-tests/${process.pid}`);
const sessions: string[] = [];
const T0 = 1_700_000_000_000;

const passthroughRedact: SomRedactFn = async (inputPath, outputPath) => {
  safeWriteFile(outputPath, safeReadFile(inputPath, { encoding: null }) as Buffer);
  safeRmSync(inputPath, { force: true });
};

async function writeScreen(width: number, height: number): Promise<string> {
  const file = path.join(dir, 'screen.png');
  const data = Buffer.alloc(width * height * 4, 200);
  safeWriteFile(file, await new Jimp({ data, width, height }).getBuffer('image/png'));
  return path.relative(pathResolver.rootDir(), file);
}

function session(label: string): string {
  const id = `vision-mark-elements-${label}-${process.pid}`;
  sessions.push(id);
  clearMarks(id);
  return id;
}

afterEach(() => {
  safeRmSync(dir, { recursive: true, force: true });
  for (const id of sessions.splice(0)) {
    safeRmSync(pathResolver.volatile('session', id), { recursive: true, force: true });
  }
});

describe('handleMarkElements', () => {
  it('fuses detections, stores marks and draws the overlay in the session dir', async () => {
    const image = await writeScreen(400, 200);
    const id = session('fuse');
    const seen: unknown[] = [];
    const result = await handleMarkElements(
      {
        path: image,
        session_id: id,
        dom_elements: [{ ref: '@e2', name: 'Go', bbox: { x: 100, y: 20, width: 40, height: 20 } }],
        dom_scale: 2,
        detectors: ['browser_dom', 'ocr_text'],
      },
      {
        detect: async (request, options) => {
          seen.push({ size: request.image_size, scale: request.dom_scale, options });
          return {
            detectors_run: ['browser_dom', 'ocr_text'],
            candidates: [
              {
                box: { x: 10, y: 100, width: 60, height: 20 },
                source: 'ocr',
                kind: 'text',
                label: 'Help',
                score: 0.9,
              },
              {
                box: { x: 200, y: 40, width: 80, height: 40 },
                source: 'dom',
                kind: 'control',
                label: 'Go',
                score: 1,
                ref: '@e2',
              },
            ],
          };
        },
        redact: passthroughRedact,
        now: () => T0,
      }
    );

    expect(seen).toEqual([
      {
        size: { width: 400, height: 200 },
        scale: 2,
        options: { detectors: ['browser_dom', 'ocr_text'] },
      },
    ]);
    expect(result.marks.map((mark) => [mark.n, mark.label, mark.ref])).toEqual([
      [1, 'Go', '@e2'],
      [2, 'Help', undefined],
    ]);
    expect(result.scale).toBe(2);
    expect(result.expires_at).toBe(T0 + 60_000);
    expect(result.image_dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.annotated_path).toBe(
      path.join(pathResolver.volatile('session', id), 'vision-marks', `${result.marks_id}.png`)
    );
    expect(safeExistsSync(result.annotated_path)).toBe(true);
    expect(safeExistsSync(result.svg_path)).toBe(true);

    // The stored marks drive later clicks: DOM marks by ref, others by logical point.
    await expect(
      resolveMarkTarget('mark:1', { session_id: id, now: () => T0 + 1 })
    ).resolves.toMatchObject({ ref: '@e2', x: 120, y: 30 });
    await expect(
      resolveMarkTarget('mark:2', { session_id: id, now: () => T0 + 1, marks_id: result.marks_id })
    ).resolves.toEqual({ n: 2, marks_id: result.marks_id, x: 20, y: 55, label: 'Help' });
  });

  it('validates required params', async () => {
    await expect(handleMarkElements({ path: '', session_id: 's' })).rejects.toThrow(
      /requires params.path/
    );
    await expect(handleMarkElements({ path: 'x.png', session_id: 's', scale: 0 })).rejects.toThrow(
      /VISION_RESOURCE_FILE|scale/
    );
  });
});
