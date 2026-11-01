import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Lets a test act as a concurrent appender at the publish instant: the hook
 * runs right before the exclusive link, so a writer "recreates" the live file
 * in the gap the park/stage protocol must survive.
 */
const linkHook = vi.hoisted(() => ({
  beforeLink: undefined as undefined | ((to: string) => void),
}));

vi.mock('./secure-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./secure-io.js')>();
  return {
    ...actual,
    safeLinkExclusiveSync: (from: string, to: string) => {
      linkHook.beforeLink?.(to);
      return actual.safeLinkExclusiveSync(from, to);
    },
  };
});

import { sharedTmp } from './path-resolver.js';
import {
  safeAppendFileSync,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from './secure-io.js';
import {
  analyzeStoreKeys,
  compactStoreByKey,
  COMPACT_MAX_PARK_ATTEMPTS,
  maintainStoreAfterAppend,
  resetAppendOnlyStoreMaintenanceState,
  resolveAppendOnlyStorePolicy,
  retainWindow,
  rotatedSegmentPath,
  rotateStore,
  setAppendOnlyStoreTestHooks,
} from './append-only-store.js';
import { repoRelativePosix } from './storage-retention-expiry.js';
import type { LoadedRetentionCatalog } from './storage-retention-catalog.js';

const jsonl = (...records: unknown[]): string =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('');

const read = (p: string): string => safeReadFile(p, { encoding: 'utf8' }) as string;
const readRecords = (p: string): Array<Record<string, unknown>> =>
  read(p)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

describe('append-only-store', () => {
  let dir: string;
  let live: string;
  let archiveDir: string;

  beforeEach(() => {
    dir = sharedTmp(`append-only-store-${randomUUID().slice(0, 8)}`);
    safeMkdir(dir, { recursive: true });
    live = path.join(dir, 'items.jsonl');
    archiveDir = path.join(dir, 'archive');
    linkHook.beforeLink = undefined;
    resetAppendOnlyStoreMaintenanceState();
  });

  afterEach(() => {
    linkHook.beforeLink = undefined;
    setAppendOnlyStoreTestHooks({});
    safeRmSync(dir, { recursive: true, force: true });
  });

  const leftovers = () =>
    safeReaddir(dir).filter((n) => n.includes('.compacting-') || n.endsWith('.tmp'));

  describe('rotateStore', () => {
    it('renames the live file to a <stem>-YYYYMMDD-HHmmss segment', () => {
      safeWriteFile(live, jsonl({ a: 1 }));
      const now = new Date('2026-11-01T12:34:56.000Z');
      const segment = rotateStore(live, { now });
      expect(segment).toBe(path.join(dir, 'items-20261101-123456.jsonl'));
      expect(safeExistsSync(live)).toBe(false);
      expect(readRecords(segment!)).toEqual([{ a: 1 }]);
    });

    it('disambiguates a same-second collision and skips missing / empty files', () => {
      const now = new Date('2026-11-01T12:34:56.000Z');
      safeWriteFile(live, jsonl({ a: 1 }));
      rotateStore(live, { now });
      expect(rotatedSegmentPath(live, now)).toBe(path.join(dir, 'items-20261101-123456-1.jsonl'));
      expect(rotateStore(live, { now })).toBeNull();
      safeWriteFile(live, '');
      expect(rotateStore(live, { now })).toBeNull();
    });
  });

  describe('compactStoreByKey', () => {
    it('keeps the last record per key in order of last appearance; keyless and malformed lines verbatim', () => {
      const content =
        jsonl({ id: 'a', v: 1 }, { note: 'keyless' }, { id: 'b', v: 1 }, { id: 7, v: 1 }) +
        'not json\r\n' +
        jsonl({ id: 'a', v: 2 }, { id: 7, v: 2 });
      safeWriteFile(live, content);

      for (const chunkBytes of [3, 64]) {
        safeWriteFile(live, content);
        const result = compactStoreByKey(live, { key: 'id', archiveDir, chunkBytes });
        expect(result).toMatchObject({ before: 7, after: 5, published: true, merged: 0 });
        expect(read(live).split('\n').filter(Boolean)).toEqual([
          '{"note":"keyless"}',
          '{"id":"b","v":1}',
          'not json',
          '{"id":"a","v":2}',
          '{"id":7,"v":2}',
        ]);
        // The raw union is archived byte-verbatim.
        expect(read(result!.archivePath!)).toBe(content);
        expect(leftovers()).toEqual([]);
      }
      // Two compactions in one second do not collide on the archive name.
      expect(safeReaddir(archiveDir)).toHaveLength(2);
    });

    it('merges a live file a writer recreates during the publish (no record lost)', () => {
      safeWriteFile(live, jsonl({ id: 'a', v: 1 }, { id: 'a', v: 2 }));
      let raced = 0;
      linkHook.beforeLink = (to) => {
        if (to === live && raced++ === 0) safeAppendFileSync(live, jsonl({ id: 'b', v: 1 }));
      };
      const result = compactStoreByKey(live, { key: 'id', archiveDir });
      expect(result).toMatchObject({ before: 3, after: 2, published: true, merged: 1 });
      expect(readRecords(live)).toEqual([
        { id: 'a', v: 2 },
        { id: 'b', v: 1 },
      ]);
      expect(leftovers()).toEqual([]);
    });

    it('restores the raw union when writers out-pace the merge loop', () => {
      safeWriteFile(live, jsonl({ id: 'a', v: 1 }, { id: 'a', v: 2 }));
      let n = 0;
      linkHook.beforeLink = (to) => {
        if (to === live) safeAppendFileSync(live, jsonl({ id: 'w', v: n++ }));
      };
      const result = compactStoreByKey(live, { key: 'id', archiveDir });
      expect(result?.published).toBe(false);
      const kept = readRecords(live);
      expect(kept).toHaveLength(2 + COMPACT_MAX_PARK_ATTEMPTS + 1);
      expect(result?.after).toBe(kept.length);
      expect(leftovers()).toEqual([]);
    });

    it('returns null for a missing store and analyzeStoreKeys streams the fold check', () => {
      expect(compactStoreByKey(live, { key: 'id', archiveDir })).toBeNull();
      safeWriteFile(live, jsonl({ id: 'a' }, { id: 'b' }, { id: 'a' }, { x: 1 }) + 'junk\n');
      expect(analyzeStoreKeys(live, 'id', { chunkBytes: 4 })).toEqual({
        records: 5,
        distinctKeys: 2,
      });
    });
  });

  describe('parked rewrite edge cases', () => {
    const errno = (code: string): Error =>
      Object.assign(new Error(`link failed (${code})`), { code });

    it('pass 2 filters only the bytes pass 1 indexed; an append landing between the passes is kept', () => {
      safeWriteFile(live, jsonl({ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'a', v: 2 }));
      setAppendOnlyStoreTestHooks({
        beforeWriteSurvivors: (staging) =>
          safeAppendFileSync(staging[0]!, jsonl({ id: 'a', v: 3 })),
      });
      const result = compactStoreByKey(live, { key: 'id', archiveDir: null, chunkBytes: 5 });
      expect(readRecords(live)).toEqual([
        { id: 'b', v: 1 },
        { id: 'a', v: 2 },
        { id: 'a', v: 3 },
      ]);
      expect(result).toMatchObject({ published: true, lateLines: 1, after: 3 });
      expect(leftovers()).toEqual([]);
    });

    it('an unterminated tail at park time is carried verbatim, completed by the late bytes', () => {
      safeWriteFile(live, jsonl({ id: 'a', v: 1 }, { id: 'b', v: 1 }) + '{"id":"a","v":2');
      setAppendOnlyStoreTestHooks({
        beforeWriteSurvivors: (staging) => safeAppendFileSync(staging[0]!, '}\n'),
      });
      compactStoreByKey(live, { key: 'id', archiveDir: null });
      expect(readRecords(live)).toEqual([
        { id: 'a', v: 1 },
        { id: 'b', v: 1 },
        { id: 'a', v: 2 },
      ]);
    });

    it('archiveDir null compacts without writing any archive', () => {
      safeWriteFile(live, jsonl({ id: 'a', v: 1 }, { id: 'a', v: 2 }));
      const result = compactStoreByKey(live, { key: 'id', archiveDir: null });
      expect(result).toMatchObject({ published: true, archivePath: null, after: 1 });
      expect(safeReaddir(dir).sort()).toEqual(['items.jsonl']);
    });

    it('keeps an oversized line verbatim in place when compacting (with or without an archive)', () => {
      const huge = JSON.stringify({ id: 'h', big: 'x'.repeat(300) });
      const content = jsonl({ id: 'a', v: 1 }) + `${huge}\n` + jsonl({ id: 'a', v: 2 });
      for (const dirOption of [null, archiveDir]) {
        safeWriteFile(live, content);
        const result = compactStoreByKey(live, {
          key: 'id',
          archiveDir: dirOption,
          chunkBytes: 16,
          maxLineBytes: 100,
        });
        expect(read(live)).toBe(`${huge}\n${JSON.stringify({ id: 'a', v: 2 })}\n`);
        expect(result).toMatchObject({ oversizedLines: 1, before: 3, after: 2 });
      }
    });

    it('keeps an oversized line verbatim in the time window (no archive)', () => {
      const huge = JSON.stringify({ t: 1, big: 'y'.repeat(300) });
      safeWriteFile(live, jsonl({ t: 1 }) + `${huge}\n` + jsonl({ t: 10 }));
      const result = retainWindow<{ t: number }>(live, {
        timeOf: (r) => r.t,
        sinceMs: 5,
        chunkBytes: 32,
        maxLineBytes: 100,
      });
      expect(read(live)).toBe(`${huge}\n{"t":10}\n`);
      expect(result).toMatchObject({ oversizedLines: 1, archivePath: null });
    });

    it('falls back to a buffered exclusive publish when hard links are unsupported', () => {
      for (const code of ['EPERM', 'ENOTSUP', 'EXDEV']) {
        safeWriteFile(live, jsonl({ id: 'a', v: 1 }, { id: 'a', v: 2 }));
        linkHook.beforeLink = (to) => {
          if (to === live) throw errno(code);
        };
        const result = compactStoreByKey(live, { key: 'id', archiveDir: null });
        expect(result?.published).toBe(true);
        expect(readRecords(live)).toEqual([{ id: 'a', v: 2 }]);
        expect(leftovers()).toEqual([]);
      }
    });

    it('a failed compaction whose raw union was restored keeps no redundant staging copy', () => {
      const content = jsonl({ id: 'a', v: 1 }, { id: 'a', v: 2 });
      safeWriteFile(live, content);
      linkHook.beforeLink = (to) => {
        if (to === live) throw errno('EIO');
      };
      expect(() => compactStoreByKey(live, { key: 'id', archiveDir })).toThrow(/EIO/);
      expect(read(live)).toBe(content);
      expect(leftovers()).toEqual([]);
      expect(safeExistsSync(archiveDir)).toBe(false);
    });
  });

  describe('retainWindow', () => {
    it('drops records older than sinceMs unless keep() retains them; malformed lines stay', () => {
      safeWriteFile(
        live,
        jsonl({ t: 1, s: 'old' }, { t: 2, s: 'claimed' }, { s: 'untimed' }) +
          'garbage\n' +
          jsonl({ t: 10, s: 'new' })
      );
      const result = retainWindow<{ t?: number; s: string }>(live, {
        timeOf: (r) => r.t,
        sinceMs: 5,
        keep: (r) => r.s === 'claimed',
        chunkBytes: 5,
      });
      expect(result).toMatchObject({ before: 5, after: 4, published: true, archivePath: null });
      expect(read(live).split('\n').filter(Boolean)).toEqual([
        '{"t":2,"s":"claimed"}',
        '{"s":"untimed"}',
        'garbage',
        '{"t":10,"s":"new"}',
      ]);
      expect(leftovers()).toEqual([]);
    });
  });

  describe('maintainStoreAfterAppend', () => {
    it('does nothing below the threshold', () => {
      safeWriteFile(live, jsonl({ a: 1 }));
      expect(maintainStoreAfterAppend(live, { action: 'rotate', minBytes: 1024 })).toBe(
        'below-threshold'
      );
      expect(safeExistsSync(live)).toBe(true);
    });

    it('rotates once the threshold is crossed', () => {
      safeWriteFile(live, jsonl({ pad: 'x'.repeat(100) }));
      expect(maintainStoreAfterAppend(live, { action: 'rotate', minBytes: 50 })).toBe('rotated');
      expect(safeExistsSync(live)).toBe(false);
      expect(safeReaddir(dir).some((n) => /^items-\d{8}-\d{6}\.jsonl$/.test(n))).toBe(true);
    });

    it('compacts under the store lock and re-runs only after the store doubles', () => {
      const policy = { action: 'compact' as const, key: 'id', minBytes: 40, archiveDir };
      safeWriteFile(live, jsonl({ id: 'a', v: 1 }, { id: 'a', v: 2 }, { id: 'b', v: 1 }));
      expect(maintainStoreAfterAppend(live, policy)).toBe('compacted');
      expect(readRecords(live)).toEqual([
        { id: 'a', v: 2 },
        { id: 'b', v: 1 },
      ]);
      // Still above the threshold, but not doubled: no O(N) pass per append.
      safeAppendFileSync(live, jsonl({ id: 'a', v: 3 }));
      expect(maintainStoreAfterAppend(live, policy)).toBe('below-threshold');
      // Distinct keys only: nothing to fold even once it has doubled.
      resetAppendOnlyStoreMaintenanceState();
      safeWriteFile(live, jsonl({ id: 'a', pad: 'x'.repeat(40) }, { id: 'b' }));
      expect(maintainStoreAfterAppend(live, policy)).toBe('nothing-to-do');
    });

    it('applies an explicit window policy', () => {
      const now = new Date('2026-11-01T00:00:00.000Z');
      safeWriteFile(
        live,
        jsonl({ at: now.getTime() - 10_000, s: 'old' }, { at: now.getTime() - 10, s: 'new' })
      );
      const outcome = maintainStoreAfterAppend(
        live,
        {
          action: 'window',
          minBytes: 10,
          windowMs: 1000,
          timeOf: (r) => (r as { at: number }).at,
        },
        { now }
      );
      expect(outcome).toBe('windowed');
      expect(readRecords(live).map((r) => r.s)).toEqual(['new']);
    });

    it('resolves rotate / compact policies from exact-path catalog entries', () => {
      const catalog: LoadedRetentionCatalog = {
        source: 'catalog',
        warnings: [],
        entries: [
          {
            path: repoRelativePosix(live),
            artifact_class: 'log',
            action: 'rotate',
            rotate_min_bytes: 20,
          } as LoadedRetentionCatalog['entries'][number],
        ],
      };
      expect(resolveAppendOnlyStorePolicy(live, catalog)).toEqual({
        action: 'rotate',
        minBytes: 20,
      });
      expect(resolveAppendOnlyStorePolicy(path.join(dir, 'other.jsonl'), catalog)).toBeNull();
      safeWriteFile(live, jsonl({ pad: 'x'.repeat(40) }));
      expect(maintainStoreAfterAppend(live, 'catalog', { catalog })).toBe('rotated');
      expect(maintainStoreAfterAppend(path.join(dir, 'other.jsonl'), 'catalog', { catalog })).toBe(
        'no-policy'
      );
    });

    it('never throws into the append: failures log and return "failed"', () => {
      safeWriteFile(live, jsonl({ at: 1 }, { at: 2 }));
      const exploding = {
        action: 'window' as const,
        minBytes: 1,
        windowMs: 1,
        timeOf: (): number => {
          throw new Error('boom');
        },
      };
      expect(() => maintainStoreAfterAppend(live, exploding)).not.toThrow();
      resetAppendOnlyStoreMaintenanceState();
      expect(maintainStoreAfterAppend(live, exploding)).toBe('failed');
      // The failed rewrite restored every record and left no staging behind.
      expect(readRecords(live)).toEqual([{ at: 1 }, { at: 2 }]);
      expect(leftovers()).toEqual([]);
    });

    it('backs off after a failure: no retry until the store doubles', () => {
      safeWriteFile(live, jsonl({ at: 1 }, { at: 2 }));
      const exploding = {
        action: 'window' as const,
        minBytes: 1,
        windowMs: 1,
        timeOf: (): number => {
          throw new Error('boom');
        },
      };
      expect(maintainStoreAfterAppend(live, exploding)).toBe('failed');
      safeAppendFileSync(live, jsonl({ at: 3 }));
      expect(maintainStoreAfterAppend(live, exploding)).toBe('below-threshold');
      safeAppendFileSync(live, jsonl({ at: 4 }, { at: 5 }, { at: 6 }));
      expect(maintainStoreAfterAppend(live, exploding)).toBe('failed');
    });
  });
});
