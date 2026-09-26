import { afterEach, describe, expect, it } from 'vitest';
import { Jimp } from 'jimp';
import {
  MARKS_TTL_MS,
  clearMarks,
  isMarkTarget,
  loadMarks,
  marksStatePath,
  parseMarkTarget,
  resolveMarkTarget,
  saveMarks,
} from './mark-target-resolver.js';
import { dhashFile } from './image-dhash.js';
import { pathResolver } from './path-resolver.js';
import { safeRmSync, safeWriteFile } from './secure-io.js';
import type { SomMark } from './set-of-marks.js';

const sessions: string[] = [];
const files: string[] = [];
const T0 = 1_700_000_000_000;

function sessionId(label: string): string {
  const id = `mark-target-test-${label}-${process.pid}`;
  sessions.push(id);
  clearMarks(id);
  return id;
}

const MARKS: SomMark[] = [
  {
    n: 1,
    box: { x: 100, y: 40, width: 80, height: 20 },
    center: { x: 140, y: 50 },
    kind: 'control',
    label: 'Search',
    sources: ['dom'],
    ref: '@e4',
  },
  {
    n: 2,
    box: { x: 300, y: 200, width: 41, height: 21 },
    center: { x: 321, y: 211 },
    kind: 'text',
    label: 'Settings',
    sources: ['ocr'],
  },
];

function save(id: string, extra: { scale?: number; image_dhash?: string } = {}) {
  return saveMarks({
    session_id: id,
    marks: MARKS,
    image: { width: 800, height: 600 },
    image_dhash: extra.image_dhash ?? '0f0f0f0f0f0f0f0f',
    scale: extra.scale,
    now: () => T0,
    marks_id: 'marks-1',
  });
}

async function writeImage(name: string, value: (x: number, y: number) => number): Promise<string> {
  const size = 32;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      data.fill(value(x, y), offset, offset + 3);
      data[offset + 3] = 255;
    }
  }
  const file = pathResolver.sharedTmp(`mark-target-tests/${process.pid}-${name}.png`);
  safeWriteFile(file, await new Jimp({ data, width: size, height: size }).getBuffer('image/png'));
  files.push(file);
  return file;
}

afterEach(() => {
  for (const id of sessions.splice(0)) {
    safeRmSync(pathResolver.volatile('session', id), { recursive: true, force: true });
  }
  for (const file of files.splice(0)) safeRmSync(file, { force: true });
});

describe('parseMarkTarget', () => {
  it.each([
    ['mark:1', 1],
    [' mark:12 ', 12],
    ['mark:0', undefined],
    ['mark:', undefined],
    ['mark:1a', undefined],
    ['mark:12345', undefined],
    ['@e1', undefined],
    [42, undefined],
  ])('%j -> %j', (input, expected) => {
    expect(parseMarkTarget(input)).toBe(expected);
    expect(isMarkTarget(input)).toBe(expected !== undefined);
  });
});

describe('marks store', () => {
  it('persists marks in the session volatile dir with a 60s TTL', () => {
    const id = sessionId('store');
    const record = save(id);
    expect(record.expires_at - record.created_at).toBe(MARKS_TTL_MS);
    expect(marksStatePath(id)).toContain(`runtime/session/${id}/vision-marks.json`);
    expect(loadMarks(id)).toEqual(record);
  });
});

describe('resolveMarkTarget', () => {
  it('returns the ref and the logical-point center of a DOM mark', async () => {
    const id = sessionId('ref');
    save(id);
    await expect(
      resolveMarkTarget('mark:1', { session_id: id, now: () => T0 + 1 })
    ).resolves.toEqual({ n: 1, marks_id: 'marks-1', x: 140, y: 50, ref: '@e4', label: 'Search' });
  });

  it.each([
    ['stored scale', 2, undefined, { x: 161, y: 106 }],
    ['caller scale overrides', 2, 1, { x: 321, y: 211 }],
    ['default scale 1', undefined, undefined, { x: 321, y: 211 }],
  ])('converts image pixels to points: %s', async (_name, stored, override, expected) => {
    const id = sessionId(`scale-${String(stored)}-${String(override)}`);
    save(id, { scale: stored });
    const resolved = await resolveMarkTarget('mark:2', {
      session_id: id,
      scale: override,
      now: () => T0,
    });
    expect({ x: resolved.x, y: resolved.y }).toEqual(expected);
    expect(resolved.ref).toBeUndefined();
  });

  it.each([
    ['at the TTL boundary', { now: () => T0 + MARKS_TTL_MS }],
    ['for a superseded marks_id', { now: () => T0, marks_id: 'marks-0' }],
    ['when the screen dHash moved', { now: () => T0, current_dhash: 'f0f0f0f0f0f0f0f0' }],
  ])('refuses %s with MARK_STALE', async (_name, extra) => {
    const id = sessionId(`stale-${_name.length}`);
    save(id);
    await expect(resolveMarkTarget('mark:1', { session_id: id, ...extra })).rejects.toThrow(
      /^\[MARK_STALE\]/
    );
  });

  it('accepts a current screen within the dHash tolerance', async () => {
    const id = sessionId('near');
    save(id);
    // 4 differing bits
    await expect(
      resolveMarkTarget('mark:1', {
        session_id: id,
        now: () => T0,
        current_dhash: '0f0f0f0f0f0f0f00',
      })
    ).resolves.toMatchObject({ n: 1 });
  });

  it('refuses a missing session or mark with MARK_STALE and a malformed target with MARK_INVALID', async () => {
    const id = sessionId('missing');
    await expect(resolveMarkTarget('mark:1', { session_id: id })).rejects.toThrow(
      /^\[MARK_STALE\] no marks/
    );
    save(id);
    await expect(resolveMarkTarget('mark:9', { session_id: id, now: () => T0 })).rejects.toThrow(
      /^\[MARK_STALE\] mark 9 is not in marks/
    );
    await expect(resolveMarkTarget('@e1', { session_id: id })).rejects.toThrow(/^\[MARK_INVALID\]/);
  });

  it('hashes current_image_path to detect a changed screen', async () => {
    const marked = await writeImage('marked', (x) => (x < 16 ? 20 : 230));
    const same = await writeImage('same', (x) => (x < 16 ? 20 : 230));
    const changed = await writeImage('changed', (x) => (x < 16 ? 230 : 20));
    const id = sessionId('image');
    save(id, { image_dhash: await dhashFile(marked) });
    await expect(
      resolveMarkTarget('mark:1', { session_id: id, now: () => T0, current_image_path: same })
    ).resolves.toMatchObject({ n: 1 });
    await expect(
      resolveMarkTarget('mark:1', { session_id: id, now: () => T0, current_image_path: changed })
    ).rejects.toThrow(/^\[MARK_STALE\] the screen changed/);
  });
});
