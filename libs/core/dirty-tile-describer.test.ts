import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Jimp } from 'jimp';
import { resolveStorageFloor } from './storage-layout.js';
import { withExecutionContextAsync } from './authority.js';
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
} from './media/image-description-bridge.js';
import type { ReasoningBackend } from './reasoning/reasoning-backend-contracts.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
  safeSymlinkSync,
} from './secure-io.js';

const appleMocks = vi.hoisted(() => ({ gate: vi.fn(), prompt: vi.fn() }));
vi.mock('./apple-intelligence-bridge.js', () => ({
  gateAppleLane: appleMocks.gate,
  appleFmPromptWithImage: appleMocks.prompt,
}));
beforeEach(() => {
  appleMocks.gate.mockReset().mockResolvedValue({ available: false });
  appleMocks.prompt.mockReset();
});
const defaultVisionMocks = vi.hoisted(() => ({ factory: vi.fn(), describe: vi.fn() }));
vi.mock('./media/image-description-bridge.js', async (original) => {
  const actual = await original<typeof import('./media/image-description-bridge.js')>();
  return {
    ...actual,
    createReasoningVisionDescribeFn: (
      options: Parameters<typeof actual.createReasoningVisionDescribeFn>[0]
    ) => {
      if (options?.resolveBackend) return actual.createReasoningVisionDescribeFn(options);
      defaultVisionMocks.factory(options);
      return defaultVisionMocks.describe;
    },
  };
});
beforeEach(() => {
  defaultVisionMocks.factory.mockClear();
  defaultVisionMocks.describe.mockReset();
});
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
  const scopeRoot = resolveStorageFloor(
    'scratch',
    { kind: 'tier', tier: 'confidential' },
    'dirty-tile-scope-tests',
    String(process.pid)
  );
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
    const confidential = await withExecutionContextAsync(
      'ecosystem_architect',
      () =>
        describeScreenDelta(
          { path: screen, session_id: id, tier: 'confidential', grid: 2 },
          { describe: describeFn, redact: blackoutRedact, ...missionDeps }
        ),
      'ecosystem_architect'
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

describe('default configured screen description', () => {
  it('uses configured vision for redacted crops without probing Apple and reuses unchanged descriptions', async () => {
    appleMocks.gate.mockResolvedValue({ available: true });
    const seen: number[] = [];
    defaultVisionMocks.describe.mockImplementation(async (request: { path: string }) => {
      const image = await Jimp.read(safeReadFile(request.path, { encoding: null }) as Buffer);
      seen.push(image.bitmap.data[0]);
      return 'Configured vision redacted tile.';
    });
    const id = sessionId('native-default');
    const screen = await writeScreen('native-default');
    const first = await describeScreenDelta(
      { path: screen, session_id: id, grid: 1 },
      { redact: blackoutRedact }
    );
    expect(first.stats.tiles_described).toBe(1);
    expect(seen).toEqual([0]);
    expect(defaultVisionMocks.describe.mock.calls[0][0].prompt).toContain('tile (row 1 of 1');
    expect(appleMocks.gate).not.toHaveBeenCalled();
    expect(appleMocks.prompt).not.toHaveBeenCalled();
    const second = await describeScreenDelta(
      { path: screen, session_id: id, grid: 1 },
      { redact: blackoutRedact }
    );
    expect(second.stats.tiles_described).toBe(0);
    expect(defaultVisionMocks.describe).toHaveBeenCalledTimes(1);
  });
});

describe('screen source sensitivity', () => {
  it.each([undefined, 'public'] as const)(
    'does not downgrade a confidential path when tier is %s',
    async (tier) => {
      const redact = vi.fn();
      const describe = vi.fn();
      await expect(
        describeScreenDelta(
          {
            path: 'active/missions/confidential/tenant-a/MSN-X/evidence/frame.png',
            session_id: 'source-tier-test',
            ...(tier ? { tier } : {}),
          },
          { redact, describe }
        )
      ).rejects.toThrow('[VISION_TIER_SCOPE]');
      expect(redact).not.toHaveBeenCalled();
      expect(describe).not.toHaveBeenCalled();
      expect(appleMocks.gate).not.toHaveBeenCalled();
      expect(appleMocks.prompt).not.toHaveBeenCalled();
    }
  );
});

describe('screen output sensitivity', () => {
  it('refuses public directories for confidential data before source read or redaction', async () => {
    const redact = vi.fn();
    const describe = vi.fn();
    await expect(
      describeScreenDelta(
        {
          path: 'active/missions/confidential/tenant-a/MSN-X/evidence/frame.png',
          session_id: 'bad-output-tier',
        },
        {
          work_dir: pathResolver.rootResolve('active/shared/tmp/public/shared/vision-work'),
          state_dir: pathResolver.rootResolve('active/shared/tmp/public/shared/vision-state'),
          redact,
          describe,
        }
      )
    ).rejects.toThrow('[VISION_TIER_SCOPE]');
    expect(redact).not.toHaveBeenCalled();
    expect(describe).not.toHaveBeenCalled();
    expect(appleMocks.gate).not.toHaveBeenCalled();
  });
  it('refuses a tenant mismatch on a governed storage floor before reading a source', async () => {
    await expect(
      describeScreenDelta(
        {
          path: 'active/missions/confidential/tenant-a/MSN-X/evidence/frame.png',
          session_id: 'bad-output-tenant',
          tenant_slug: 'tenant-a',
        },
        {
          work_dir: resolveStorageFloor(
            'scratch',
            { kind: 'tier', tier: 'confidential', tenant: 'tenant-b' },
            'vision-work'
          ),
          state_dir: resolveStorageFloor(
            'scratch',
            { kind: 'tier', tier: 'confidential', tenant: 'tenant-b' },
            'vision-state'
          ),
        }
      )
    ).rejects.toThrow('[VISION_TIER_SCOPE]');
    expect(appleMocks.gate).not.toHaveBeenCalled();
  });
});

describe('source-owned tenant scope', () => {
  const roots = ['alpha', 'beta'].map((tenant) =>
    resolveStorageFloor(
      'scratch',
      { kind: 'tier', tier: 'confidential', tenant },
      'dirty-tile-owner-tests',
      String(process.pid)
    )
  );
  const publicRoot = resolveStorageFloor(
    'scratch',
    { kind: 'tier', tier: 'public' },
    'dirty-tile-owner-tests',
    String(process.pid)
  );
  const dirs = (root: string) => ({
    work_dir: path.join(root, 'work'),
    state_dir: path.join(root, 'state'),
  });
  afterEach(() => {
    for (const root of [...roots, publicRoot]) safeRmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function inUnscopedArchitect<T>(run: () => Promise<T>): Promise<T> {
    vi.stubEnv('KYBERION_TENANT', undefined);
    return withExecutionContextAsync('ecosystem_architect', run, 'ecosystem_architect');
  }
  async function ownedScreen(): Promise<string> {
    const sample = await writeScreen('owned-source');
    const target = path.join(roots[0], 'source.png');
    safeWriteFile(target, safeReadFile(sample, { encoding: null }));
    return target;
  }

  it('rejects alpha source to beta directories without any declared or active tenant before redaction or inference', async () => {
    await inUnscopedArchitect(async () => {
      const source = await ownedScreen();
      const redact = vi.fn();
      const describe = vi.fn();
      await expect(
        describeScreenDelta(
          { path: source, session_id: 'owner-implicit-conflict' },
          { ...dirs(roots[1]), redact, describe }
        )
      ).rejects.toThrow('[VISION_TIER_SCOPE]');
      expect(redact).not.toHaveBeenCalled();
      expect(describe).not.toHaveBeenCalled();
      expect(defaultVisionMocks.factory).not.toHaveBeenCalled();
      expect(appleMocks.gate).not.toHaveBeenCalled();
      expect(safeExistsSync(dirs(roots[1]).work_dir)).toBe(false);
      expect(safeExistsSync(dirs(roots[1]).state_dir)).toBe(false);
    });
  });

  it('accepts matching explicit source and output ownership', async () => {
    await inUnscopedArchitect(async () => {
      const source = await ownedScreen();
      const { describe, seen } = recordingDescriber();
      const result = await describeScreenDelta(
        { path: source, session_id: 'owner-explicit-match', tenant_slug: 'alpha', grid: 1 },
        { ...dirs(roots[0]), redact: blackoutRedact, describe }
      );
      expect(result.stats.tiles_described).toBe(1);
      expect(result.state_path).toContain(roots[0]);
      expect(seen).toHaveLength(1);
      expect(seen[0].firstPixel).toBe(0);
    });
  });

  it('rejects differing lexical and canonical tenant owners even with an explicit target tenant', async () => {
    await inUnscopedArchitect(async () => {
      const source = await ownedScreen();
      const betaSource = path.join(roots[1], 'source.png');
      safeWriteFile(betaSource, safeReadFile(source, { encoding: null }));
      const alias = path.join(roots[0], 'cross-owner-alias.png');
      safeSymlinkSync(betaSource, alias, 'file');
      const redact = vi.fn();
      const describe = vi.fn();
      await expect(
        describeScreenDelta(
          { path: alias, session_id: 'owner-alias-mismatch', tenant_slug: 'beta' },
          { ...dirs(roots[1]), redact, describe }
        )
      ).rejects.toThrow('lexical and canonical source tenants differ');
      expect(redact).not.toHaveBeenCalled();
      expect(describe).not.toHaveBeenCalled();
      expect(defaultVisionMocks.factory).not.toHaveBeenCalled();
      expect(appleMocks.gate).not.toHaveBeenCalled();
    });
  });

  it('uses canonical ownership behind a public symlink before choosing output scope', async () => {
    await inUnscopedArchitect(async () => {
      const source = await ownedScreen();
      const alias = path.join(publicRoot, 'source.png');
      safeSymlinkSync(source, alias, 'file');
      const redact = vi.fn();
      const describe = vi.fn();
      await expect(
        describeScreenDelta(
          { path: alias, session_id: 'owner-symlink-conflict' },
          { ...dirs(roots[1]), redact, describe }
        )
      ).rejects.toThrow('[VISION_TIER_SCOPE]');
      expect(redact).not.toHaveBeenCalled();
      expect(describe).not.toHaveBeenCalled();
      expect(defaultVisionMocks.factory).not.toHaveBeenCalled();
      expect(appleMocks.gate).not.toHaveBeenCalled();
    });
  });
});
