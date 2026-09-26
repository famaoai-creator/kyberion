import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Jimp } from 'jimp';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { dhashRegion, hamming } from './image-dhash.js';
import {
  createReasoningVisionDescribeFn,
  type DescribeFn,
  type PayloadTier,
} from './image-description-bridge.js';
import { pathResolver } from './path-resolver.js';
import { redactScreenCaptureFile } from './screen-frame-redaction.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from './secure-io.js';

/**
 * Dirty-tile screen description.
 *
 * A screenshot is split into a grid; each tile is dHashed and only tiles whose
 * hash moved more than REUSE_MAX_HAMMING bits from the hash they were last
 * described at are sent to the vision model. Unchanged tiles reuse their
 * previous description. A per-call budget caps VLM calls; tiles over budget
 * are marked stale and described first on the next call. Every image goes
 * through screen redaction before any crop reaches the describer.
 */

export const DEFAULT_TILE_GRID = 4;
export const MAX_TILE_GRID = 16;
export const MAX_TILES = 256;
export const DEFAULT_MAX_DESCRIBE_PER_CALL = 16;
export const REUSE_MAX_HAMMING = 5;
/** Rough prompt+image token cost of describing one tile, for savings stats. */
export const APPROX_TOKENS_PER_TILE = 256;
const STATE_FILE = 'vision-tiles.json';
const STATE_VERSION = 1;

export interface TileGrid {
  cols: number;
  rows: number;
}

export interface DescribeScreenDeltaInput {
  /** Screenshot to describe. It is read, never modified or removed. */
  path: string;
  session_id: string;
  /** Square grid size, or explicit cols/rows. Ignored when tile_px is set. */
  grid?: number | TileGrid;
  /** Target tile edge in pixels; the grid is derived from the image size. */
  tile_px?: number;
  max_describe_per_call?: number;
  tier?: PayloadTier;
  tenant_slug?: string;
}

export type RedactFn = (inputPath: string, outputPath: string) => Promise<void>;

export interface DirtyTileDescriberDeps {
  /** Defaults to the reasoning backend's vision channel. */
  describe?: DescribeFn;
  /** Must write a redacted copy to outputPath; may consume inputPath. */
  redact?: RedactFn;
  now?: () => number;
  /**
   * Parent for a per-call crop dir (removed afterwards). Defaults to active/shared/tmp/vision-tiles.
   * Non-public tiers must pass a mission-local dir so the vision channel accepts the crops.
   */
  work_dir?: string;
}

export type ScreenTileStatus = 'described' | 'reused' | 'stale';

export interface ScreenTile {
  id: string;
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  dhash: string;
  status: ScreenTileStatus;
  /** For stale tiles this is the last known (possibly outdated) description, if any. */
  description?: string;
}

export interface ScreenDeltaStats {
  tiles_total: number;
  tiles_described: number;
  describe_calls_saved: number;
  approx_tokens_saved: number;
  stale_tiles: number;
}

export interface ScreenDeltaResult {
  session_id: string;
  image: { width: number; height: number };
  grid: TileGrid;
  tiles: ScreenTile[];
  stats: ScreenDeltaStats;
  state_path: string;
}

interface TileState {
  described_dhash?: string;
  description?: string;
  stale_since?: number;
}

interface TilesState {
  version: number;
  image: { width: number; height: number };
  grid: TileGrid;
  updated_at: number;
  tiles: Record<string, TileState>;
}

function positiveInt(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`[SCREEN_DELTA_INVALID] ${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

export function resolveTileGrid(
  image: { width: number; height: number },
  input: Pick<DescribeScreenDeltaInput, 'grid' | 'tile_px'>
): TileGrid {
  if (input.tile_px !== undefined) {
    const edge = positiveInt(input.tile_px, 'tile_px', Math.max(image.width, image.height));
    const grid = {
      cols: Math.ceil(image.width / edge),
      rows: Math.ceil(image.height / edge),
    };
    if (grid.cols * grid.rows > MAX_TILES) {
      throw new Error(`[SCREEN_DELTA_INVALID] tile_px ${edge} yields more than ${MAX_TILES} tiles`);
    }
    return grid;
  }
  const grid = input.grid ?? DEFAULT_TILE_GRID;
  const cols = typeof grid === 'number' ? grid : grid.cols;
  const rows = typeof grid === 'number' ? grid : grid.rows;
  return {
    cols: positiveInt(Math.min(cols, image.width), 'grid cols', MAX_TILE_GRID),
    rows: positiveInt(Math.min(rows, image.height), 'grid rows', MAX_TILE_GRID),
  };
}

function tileRects(image: { width: number; height: number }, grid: TileGrid) {
  const rects: Array<Omit<ScreenTile, 'dhash' | 'status' | 'description'>> = [];
  for (let row = 0; row < grid.rows; row += 1) {
    const y = Math.floor((row * image.height) / grid.rows);
    const height = Math.floor(((row + 1) * image.height) / grid.rows) - y;
    for (let col = 0; col < grid.cols; col += 1) {
      const x = Math.floor((col * image.width) / grid.cols);
      const width = Math.floor(((col + 1) * image.width) / grid.cols) - x;
      rects.push({ id: `r${row}c${col}`, row, col, x, y, width, height });
    }
  }
  return rects;
}

export function screenDeltaStatePath(sessionId: string): string {
  return path.join(pathResolver.volatile('session', sessionId), STATE_FILE);
}

function isTilesState(value: unknown): value is TilesState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TilesState>;
  return (
    candidate.version === STATE_VERSION &&
    typeof candidate.image?.width === 'number' &&
    typeof candidate.image?.height === 'number' &&
    typeof candidate.grid?.cols === 'number' &&
    typeof candidate.grid?.rows === 'number' &&
    !!candidate.tiles &&
    typeof candidate.tiles === 'object'
  );
}

function loadState(statePath: string): TilesState | undefined {
  if (!safeExistsSync(statePath)) return undefined;
  try {
    const parsed = parseSafeJsonInput(
      String(safeReadFile(statePath, { encoding: 'utf8' })),
      'vision tiles state'
    );
    return isTilesState(parsed) ? parsed : undefined;
  } catch {
    // A corrupt state only costs one full re-describe.
    return undefined;
  }
}

function tilePrompt(tile: { row: number; col: number }, grid: TileGrid): string {
  return (
    `This image is tile (row ${tile.row + 1} of ${grid.rows}, column ${tile.col + 1} of ${grid.cols}) ` +
    'of a screenshot. Describe the visible UI elements and text in one or two sentences. ' +
    'Reply with the description only.'
  );
}

function readImageBuffer(filePath: string): Buffer {
  const payload = safeReadFile(filePath, { encoding: null });
  return Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
}

export async function describeScreenDelta(
  input: DescribeScreenDeltaInput,
  deps: DirtyTileDescriberDeps = {}
): Promise<ScreenDeltaResult> {
  const sessionId = String(input.session_id || '').trim();
  if (!sessionId) throw new Error('[SCREEN_DELTA_INVALID] session_id is required');
  const budget = positiveInt(
    input.max_describe_per_call ?? DEFAULT_MAX_DESCRIBE_PER_CALL,
    'max_describe_per_call',
    MAX_TILES
  );
  const now = deps.now ?? Date.now;
  const describe =
    deps.describe ??
    createReasoningVisionDescribeFn({ tier: input.tier, tenant_slug: input.tenant_slug });
  const redact = deps.redact ?? redactScreenCaptureFile;

  const sourceBuffer = readImageBuffer(input.path);
  const source = await Jimp.read(sourceBuffer);
  const image = { width: source.bitmap.width, height: source.bitmap.height };
  const grid = resolveTileGrid(image, input);
  const statePath = screenDeltaStatePath(sessionId);

  const previous = loadState(statePath);
  const sameLayout =
    previous &&
    previous.image.width === image.width &&
    previous.image.height === image.height &&
    previous.grid.cols === grid.cols &&
    previous.grid.rows === grid.rows;
  const priorTiles: Record<string, TileState> = sameLayout ? previous.tiles : {};

  const tiles: ScreenTile[] = tileRects(image, grid).map((rect) => ({
    ...rect,
    dhash: dhashRegion(source.bitmap, rect),
    status: 'reused',
  }));

  const nextTiles: Record<string, TileState> = {};
  const dirty: ScreenTile[] = [];
  for (const tile of tiles) {
    const prior = priorTiles[tile.id] ?? {};
    nextTiles[tile.id] = { ...prior };
    const reusable =
      prior.description !== undefined &&
      prior.described_dhash !== undefined &&
      hamming(tile.dhash, prior.described_dhash) <= REUSE_MAX_HAMMING;
    if (reusable) {
      tile.description = prior.description;
      delete nextTiles[tile.id].stale_since;
    } else {
      dirty.push(tile);
    }
  }

  // Tiles carried over as stale go first, oldest first; the rest in reading order.
  const order = (tile: ScreenTile) => nextTiles[tile.id].stale_since ?? Number.POSITIVE_INFINITY;
  dirty.sort((a, b) => order(a) - order(b));
  const toDescribe = dirty.slice(0, budget);
  const deferred = dirty.slice(budget);

  const timestamp = now();
  for (const tile of deferred) {
    tile.status = 'stale';
    const state = nextTiles[tile.id];
    if (state.description !== undefined) tile.description = state.description;
    state.stale_since = state.stale_since ?? timestamp;
  }

  const persist = () => {
    const state: TilesState = {
      version: STATE_VERSION,
      image,
      grid,
      updated_at: timestamp,
      tiles: nextTiles,
    };
    safeMkdir(path.dirname(statePath), { recursive: true });
    safeWriteFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  };

  if (toDescribe.length > 0) {
    const workDir = path.join(
      deps.work_dir ?? pathResolver.sharedTmp('vision-tiles'),
      randomUUID()
    );
    safeMkdir(workDir, { recursive: true });
    try {
      const rawPath = path.join(workDir, 'capture.png');
      const redactedPath = path.join(workDir, 'capture.redacted.png');
      safeWriteFile(rawPath, sourceBuffer);
      await redact(rawPath, redactedPath);
      const redacted = await Jimp.read(readImageBuffer(redactedPath));
      if (redacted.bitmap.width !== image.width || redacted.bitmap.height !== image.height) {
        throw new Error('[SCREEN_DELTA_REDACTION] redacted image dimensions differ from the input');
      }

      for (let index = 0; index < toDescribe.length; index += 1) {
        const tile = toDescribe[index];
        const cropPath = path.join(workDir, `tile-${tile.id}.png`);
        const crop = redacted.clone().crop({ x: tile.x, y: tile.y, w: tile.width, h: tile.height });
        safeWriteFile(cropPath, await crop.getBuffer('image/png'));
        try {
          const description = await describe({ path: cropPath, prompt: tilePrompt(tile, grid) });
          tile.status = 'described';
          tile.description = description;
          nextTiles[tile.id] = { described_dhash: tile.dhash, description };
        } catch (error) {
          // Keep what was already paid for; the rest is retried first next call.
          for (const pending of toDescribe.slice(index)) {
            const state = nextTiles[pending.id];
            state.stale_since = state.stale_since ?? timestamp;
          }
          persist();
          throw error;
        } finally {
          safeRmSync(cropPath, { force: true });
        }
      }
    } finally {
      safeRmSync(workDir, { recursive: true, force: true });
    }
  }

  persist();

  const described = tiles.filter((tile) => tile.status === 'described').length;
  const reused = tiles.filter((tile) => tile.status === 'reused').length;
  return {
    session_id: sessionId,
    image,
    grid,
    tiles,
    stats: {
      tiles_total: tiles.length,
      tiles_described: described,
      describe_calls_saved: reused,
      approx_tokens_saved: reused * APPROX_TOKENS_PER_TILE,
      stale_tiles: tiles.filter((tile) => tile.status === 'stale').length,
    },
    state_path: statePath,
  };
}

/** Drops a session's tile memory (e.g. when the observed window changes). */
export function resetScreenDeltaState(sessionId: string): void {
  safeRmSync(screenDeltaStatePath(sessionId), { force: true });
}
