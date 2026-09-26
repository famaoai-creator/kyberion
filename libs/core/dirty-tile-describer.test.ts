import { afterEach, describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import {
  APPROX_TOKENS_PER_TILE,
  describeScreenDelta,
  resetScreenDeltaState,
  resolveTileGrid,
  screenDeltaStatePath,
  type RedactFn,
} from './dirty-tile-describer.js';
import * as path from 'node:path';
import {
  ImageDescriptionUnavailableError,
  createReasoningVisionDescribeFn,
  type DescribeFn,
} from './image-description-bridge.js';
import type { ReasoningBackend } from './reasoning-backend-contracts.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

const SIZE = 160; // 4x4 grid => 40px tiles
const sessions: string[] = [];
const files: string[] = [];

function sessionId(label: string): string {
  const id = `dirty-tile-test-${label}-${process.pid}`;
  sessions.push(id);
  resetScreenDeltaState(id);
  return id;
}

/** Deterministic textured screen; `invertTile` flips one 40px tile. */
async function writeScreen(
  name: string,
  options: { invertTile?: { row: number; col: number }; size?: number } = {}
): Promise<string> {
  const size = options.size ?? SIZE;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      let value = ((x * 3 + y * 5) % 97) + (Math.floor(x / 5) % 2 === 0 ? 100 : 0);
      const tile = options.invertTile;
      if (tile && Math.floor(x / 40) === tile.col && Math.floor(y / 40) === tile.row) {
        value = 255 - ((y * 7 + (40 - (x % 40)) * 11) % 255);
      }
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const file = pathResolver.sharedTmp(`dirty-tile-tests/${process.pid}-${name}.png`);
  safeWriteFile(file, await new Jimp({ data, width: size, height: size }).getBuffer('image/png'));
  files.push(file);
  return file;
}

/** Test redaction: blacks out the image and consumes the raw input, like the real one. */
const blackoutRedact: RedactFn = async (inputPath, outputPath) => {
  const image = await Jimp.read(safeReadFile(inputPath, { encoding: null }) as Buffer);
  image.bitmap.data.fill(0);
  for (let i = 3; i < image.bitmap.data.length; i += 4) image.bitmap.data[i] = 255;
  safeWriteFile(outputPath, await image.getBuffer('image/png'));
  safeRmSync(inputPath, { force: true });
};

function recordingDescriber() {
  const seen: Array<{ path: string; prompt?: string; firstPixel: number }> = [];
  const describe: DescribeFn = async (request) => {
    const crop = await Jimp.read(safeReadFile(request.path, { encoding: null }) as Buffer);
    seen.push({ path: request.path, prompt: request.prompt, firstPixel: crop.bitmap.data[0] });
    return `tile ${seen.length}`;
  };
  return { describe, seen };
}

afterEach(() => {
  for (const id of sessions.splice(0)) {
    resetScreenDeltaState(id);
    safeRmSync(pathResolver.volatile('session', id), { recursive: true, force: true });
  }
  for (const file of files.splice(0)) safeRmSync(file, { force: true });
});

describe('describeScreenDelta', () => {
  it('describes every tile once, then reuses all of them for an identical screen', async () => {
    const id = sessionId('identical');
    const screen = await writeScreen('identical');
    const { describe: describeFn, seen } = recordingDescriber();
    const redact = vi.fn(blackoutRedact);

    const first = await describeScreenDelta(
      { path: screen, session_id: id },
      { describe: describeFn, redact }
    );
    expect(first.stats).toMatchObject({ tiles_total: 16, tiles_described: 16, stale_tiles: 0 });
    expect(seen).toHaveLength(16);
    expect(safeExistsSync(screen)).toBe(true);

    const second = await describeScreenDelta(
      { path: screen, session_id: id },
      { describe: describeFn, redact }
    );
    expect(seen).toHaveLength(16);
    expect(redact).toHaveBeenCalledTimes(1);
    expect(second.stats).toEqual({
      tiles_total: 16,
      tiles_described: 0,
      describe_calls_saved: 16,
      approx_tokens_saved: 16 * APPROX_TOKENS_PER_TILE,
      stale_tiles: 0,
    });
    expect(second.tiles.every((tile) => tile.status === 'reused' && tile.description)).toBe(true);
  });

  it('re-describes only the tile that changed', async () => {
    const id = sessionId('one-tile');
    const { describe: describeFn, seen } = recordingDescriber();
    await describeScreenDelta(
      { path: await writeScreen('base'), session_id: id },
      { describe: describeFn, redact: blackoutRedact }
    );

    const result = await describeScreenDelta(
      { path: await writeScreen('changed', { invertTile: { row: 1, col: 2 } }), session_id: id },
      { describe: describeFn, redact: blackoutRedact }
    );
    expect(result.stats.tiles_described).toBe(1);
    expect(result.stats.describe_calls_saved).toBe(15);
    expect(
      result.tiles.filter((tile) => tile.status === 'described').map((tile) => tile.id)
    ).toEqual(['r1c2']);
    expect(seen.at(-1)?.prompt).toMatch(/row 2 of 4, column 3 of 4/);
  });

  it('describes only redacted crops and removes them afterwards', async () => {
    const id = sessionId('redacted');
    const { describe: describeFn, seen } = recordingDescriber();
    await describeScreenDelta(
      { path: await writeScreen('redacted'), session_id: id, grid: 2 },
      { describe: describeFn, redact: blackoutRedact }
    );
    expect(seen).toHaveLength(4);
    expect(seen.every((entry) => entry.firstPixel === 0)).toBe(true);
    expect(seen.every((entry) => !safeExistsSync(entry.path))).toBe(true);
  });

  it('carries tiles over the per-call budget to the next call, oldest first', async () => {
    const id = sessionId('budget');
    const screen = await writeScreen('budget');
    const { describe: describeFn, seen } = recordingDescriber();
    let clock = 1_000;
    const deps = { describe: describeFn, redact: blackoutRedact, now: () => clock };

    const first = await describeScreenDelta(
      { path: screen, session_id: id, max_describe_per_call: 5 },
      deps
    );
    expect(first.stats).toMatchObject({ tiles_described: 5, stale_tiles: 11 });
    const staleAfterFirst = first.tiles.filter((t) => t.status === 'stale').map((t) => t.id);

    // r0c0 was described in the first call and now changes: it is dirty but
    // must queue behind the tiles already carried over as stale.
    clock = 2_000;
    const changed = await writeScreen('budget-changed', { invertTile: { row: 0, col: 0 } });
    const second = await describeScreenDelta(
      { path: changed, session_id: id, max_describe_per_call: 5 },
      deps
    );
    expect(second.stats).toMatchObject({
      tiles_described: 5,
      describe_calls_saved: 4,
      stale_tiles: 7,
    });
    expect(second.tiles.filter((t) => t.status === 'described').map((t) => t.id)).toEqual(
      staleAfterFirst.slice(0, 5)
    );
    expect(second.tiles.find((t) => t.id === 'r0c0')).toMatchObject({
      status: 'stale',
      description: 'tile 1',
    });

    const third = await describeScreenDelta(
      { path: changed, session_id: id, max_describe_per_call: 16 },
      deps
    );
    expect(third.stats).toMatchObject({
      tiles_described: 7,
      describe_calls_saved: 9,
      stale_tiles: 0,
    });
    expect(seen).toHaveLength(17);
  });

  it('starts over when the screen size changes', async () => {
    const id = sessionId('resize');
    const { describe: describeFn } = recordingDescriber();
    const deps = { describe: describeFn, redact: blackoutRedact };
    await describeScreenDelta({ path: await writeScreen('small'), session_id: id }, deps);
    const result = await describeScreenDelta(
      { path: await writeScreen('large', { size: 200 }), session_id: id },
      deps
    );
    expect(result.stats.tiles_described).toBe(16);
  });

  it('fails explicitly on a text-only backend and cleans up its crops', async () => {
    const id = sessionId('text-only');
    const textOnly = {
      name: 'text-cli',
      prompt: async () => 'text',
      delegateTask: async () => 'delegated',
    } as unknown as ReasoningBackend;
    const error = await describeScreenDelta(
      { path: await writeScreen('text-only'), session_id: id },
      {
        describe: createReasoningVisionDescribeFn({ resolveBackend: () => textOnly }),
        redact: blackoutRedact,
      }
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ImageDescriptionUnavailableError);
    expect((error as ImageDescriptionUnavailableError).code).toBe('VISION_BACKEND_TEXT_ONLY');
  });

  it('requires a session id', async () => {
    await expect(describeScreenDelta({ path: 'unused.png', session_id: ' ' })).rejects.toThrow(
      /session_id is required/
    );
  });
});

describe('tier-scoped tile memory', () => {
  const scopeRoot = pathResolver.sharedTmp(`dirty-tile-scope-tests/${process.pid}`);
  const missionDeps = {
    work_dir: path.join(scopeRoot, 'mission', 'tmp', 'vision-tiles'),
    state_dir: path.join(scopeRoot, 'mission', 'tmp', 'vision-state'),
  };

  afterEach(() => safeRmSync(scopeRoot, { recursive: true, force: true }));

  it('refuses a non-public screen without mission-local work and state dirs', async () => {
    const id = sessionId('tier-refuse');
    const { describe: describeFn, seen } = recordingDescriber();
    for (const deps of [{}, { work_dir: missionDeps.work_dir }]) {
      await expect(
        describeScreenDelta(
          { path: await writeScreen('tier-refuse'), session_id: id, tier: 'confidential' },
          { describe: describeFn, redact: blackoutRedact, ...deps }
        )
      ).rejects.toThrow('[VISION_TIER_SCOPE]');
    }
    expect(seen).toHaveLength(0);
  });

  it('never lets a public call reuse or read confidential descriptions', async () => {
    const id = sessionId('tier-split');
    const screen = await writeScreen('tier-split');
    const { describe: describeFn, seen } = recordingDescriber();
    const confidential = await describeScreenDelta(
      { path: screen, session_id: id, tier: 'confidential', grid: 2 },
      { describe: describeFn, redact: blackoutRedact, ...missionDeps }
    );
    expect(confidential.state_path).toBe(
      path.join(missionDeps.state_dir, id, 'vision-tiles.confidential.json')
    );
    expect(safeExistsSync(screenDeltaStatePath(id))).toBe(false);

    const publicCall = await describeScreenDelta(
      { path: screen, session_id: id, grid: 2 },
      { describe: describeFn, redact: blackoutRedact }
    );
    expect(publicCall.stats.tiles_described).toBe(4);
    expect(seen).toHaveLength(8);
    expect(publicCall.state_path).toBe(screenDeltaStatePath(id, 'public'));
  });

  it.each(['a/b', '../x'])('rejects session id %j', async (id) => {
    await expect(describeScreenDelta({ path: 'unused.png', session_id: id })).rejects.toThrow(
      /SCREEN_DELTA_INVALID.*invalid session id/
    );
  });
});

describe('resolveTileGrid', () => {
  it('derives the grid from tile_px', () => {
    expect(resolveTileGrid({ width: 1920, height: 1080 }, { tile_px: 256 })).toEqual({
      cols: 8,
      rows: 5,
    });
  });

  it('defaults to 4x4 and accepts explicit cols/rows', () => {
    expect(resolveTileGrid({ width: 800, height: 600 }, {})).toEqual({ cols: 4, rows: 4 });
    expect(resolveTileGrid({ width: 800, height: 600 }, { grid: { cols: 6, rows: 3 } })).toEqual({
      cols: 6,
      rows: 3,
    });
  });

  it('refuses grids that would explode the tile count', () => {
    expect(() => resolveTileGrid({ width: 4000, height: 4000 }, { tile_px: 10 })).toThrow(
      /SCREEN_DELTA_INVALID/
    );
    expect(() => resolveTileGrid({ width: 800, height: 600 }, { grid: 0 })).toThrow(
      /SCREEN_DELTA_INVALID/
    );
  });
});
