import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import { withExecutionContextAsync } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeReaddir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { clearMarks, marksStatePath, resolveMarkTarget } from '@agent/core/mark-target-resolver';
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
    const current_dhash = result.image_dhash;
    await expect(
      resolveMarkTarget('mark:1', { session_id: id, now: () => T0 + 1, current_dhash })
    ).resolves.toMatchObject({ ref: '@e2', x: 120, y: 30 });
    await expect(
      resolveMarkTarget('mark:2', {
        session_id: id,
        now: () => T0 + 1,
        marks_id: result.marks_id,
        current_dhash,
      })
    ).resolves.toEqual({ n: 2, marks_id: result.marks_id, x: 20, y: 55, label: 'Help' });
  });

  it('passes the live-screen mapping to the accessibility detector', async () => {
    const image = await writeScreen(40, 20);
    const requests: unknown[] = [];
    const detect = async (request: unknown) => {
      requests.push(request);
      return { detectors_run: ['os_accessibility'], candidates: [] };
    };
    await handleMarkElements(
      {
        path: image,
        session_id: session('live'),
        detectors: ['os_accessibility', 'pixel_regions'],
        live_screen: true,
        application: 'Finder',
        display_origin: { x: -1440, y: 0 },
        scale: 2,
      },
      { detect, redact: passthroughRedact, now: () => T0 }
    );
    await handleMarkElements(
      { path: image, session_id: session('stored') },
      { detect, redact: passthroughRedact, now: () => T0 }
    );
    expect(requests[0]).toMatchObject({
      live_screen: true,
      application: 'Finder',
      screen_origin: { x: -1440, y: 0 },
      screen_scale: 2,
    });
    // A screenshot not declared live never enables the accessibility detector,
    // and the default scale is left for the detector to derive.
    expect(requests[1]).not.toHaveProperty('live_screen');
    expect(requests[1]).not.toHaveProperty('screen_scale');
    expect(requests[1]).not.toHaveProperty('screen_origin');
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

const noDetections = async () => ({ detectors_run: ['ocr_text'], candidates: [] });

describe('handleMarkElements scope', () => {
  it('keeps the raw copy in the session dir and never next to a caller output_path', async () => {
    const image = await writeScreen(40, 20);
    const id = session('raw-copy');
    const redactDirs: string[] = [];
    const output = path.join(dir, 'caller-out', 'overlay.png');
    const result = await handleMarkElements(
      { path: image, session_id: id, output_path: path.relative(pathResolver.rootDir(), output) },
      {
        detect: async () => ({
          detectors_run: ['ocr_text'],
          candidates: [
            {
              box: { x: 1, y: 1, width: 20, height: 8 },
              source: 'ocr',
              kind: 'text',
              label: 'dave.k@example.com',
              score: 0.9,
            },
          ],
        }),
        redact: async (inputPath, outputPath) => {
          redactDirs.push(path.dirname(inputPath));
          await passthroughRedact(inputPath, outputPath);
        },
        now: () => T0,
      }
    );
    expect(result.tier).toBe('public');
    expect(redactDirs).toEqual([path.join(pathResolver.volatile('session', id), 'vision-marks')]);
    expect(safeReaddir(path.dirname(output)).sort()).toEqual(['overlay.png', 'overlay.svg']);
    expect(result.marks).toHaveLength(1);
    expect(result.marks[0]).not.toHaveProperty('label');
  });

  it.each([
    ['output_path equal to the input', (image: string) => ({ output_path: image })],
    ['traversal-shaped session_id', () => ({ session_id: '../escape' })],
  ])('refuses %s', async (_name, extra) => {
    const image = await writeScreen(20, 20);
    const id = session('refuse');
    await expect(
      handleMarkElements(
        { path: image, session_id: id, ...extra(image) },
        { detect: noDetections, redact: passthroughRedact }
      )
    ).rejects.toThrow(/VISION_MARK_INVALID/);
    expect(safeExistsSync(path.join(dir, 'screen.png'))).toBe(true);
  });

  it('refuses a non-public screenshot without a mission before writing anything', async () => {
    const image = await writeScreen(20, 20);
    const id = session('tier');
    const detect = async () => {
      throw new Error('must not run');
    };
    await expect(
      handleMarkElements(
        { path: image, session_id: id, tier: 'confidential' },
        { detect, redact: passthroughRedact }
      )
    ).rejects.toThrow('[VISION_TIER_SCOPE] confidential');
    await expect(
      handleMarkElements(
        { path: image, session_id: id, tier: 'confidential', mission_id: 'MSN-NOT-THERE' },
        { detect, redact: passthroughRedact }
      )
    ).rejects.toThrow("[VISION_TIER_SCOPE] mission 'MSN-NOT-THERE' does not exist");
    expect(safeExistsSync(marksStatePath(id))).toBe(false);
  });

  it('keeps every artifact of a mission-scoped screenshot inside the mission', async () => {
    await withExecutionContextAsync('mission_controller', async () => {
      const missionId = `MSN-MARK-ELEMENTS-${process.pid}`;
      const missionPath = pathResolver.missionDir(missionId, 'confidential');
      safeWriteFile(path.join(missionPath, 'mission-state.json'), '{}');
      const id = session('mission');
      try {
        const image = await writeScreen(40, 20);
        await expect(
          handleMarkElements(
            {
              path: image,
              session_id: id,
              mission_id: missionId,
              output_path: path.relative(pathResolver.rootDir(), path.join(dir, 'leak.png')),
            },
            { detect: noDetections, redact: passthroughRedact }
          )
        ).rejects.toThrow('[VISION_TIER_SCOPE] output_path must stay inside mission');
        expect(safeExistsSync(path.join(dir, 'leak.png'))).toBe(false);

        const redactDirs: string[] = [];
        const result = await handleMarkElements(
          { path: image, session_id: id, mission_id: missionId, dom_snapshot_id: 'tab@1' },
          {
            detect: noDetections,
            redact: async (inputPath, outputPath) => {
              redactDirs.push(path.dirname(inputPath));
              await passthroughRedact(inputPath, outputPath);
            },
            now: () => T0,
          }
        );
        const scoped = path.join(missionPath, 'tmp', 'vision-marks', id);
        expect(result.tier).toBe('confidential');
        expect(redactDirs).toEqual([scoped]);
        for (const artifact of [result.annotated_path, result.svg_path]) {
          expect(path.dirname(artifact)).toBe(scoped);
        }
        expect(String(safeReadFile(marksStatePath(id), { encoding: 'utf8' }))).toContain(
          '"kind": "vision-marks-pointer"'
        );
      } finally {
        clearMarks(id);
        safeRmSync(missionPath, { recursive: true, force: true });
      }
    });
  });
});
