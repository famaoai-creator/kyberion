import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sharedTmp } from './path-resolver.js';
import { safeMkdir, safeMoveSync, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  fileEndsWithNewline,
  JsonlLineTooLongError,
  JsonlSourceChangedError,
  readJsonLinesBackward,
  readJsonLinesSince,
  DEFAULT_SINCE_STOP_AFTER_OLDER,
  readLastJsonLine,
  streamJsonLines,
  streamTextLines,
  streamTextLinesBackward,
  type JsonlByteSource,
  type JsonlPinnedReader,
} from './jsonl-read.js';

/** In-memory byte source that counts the bytes it serves. */
function memorySource(files: Record<string, string | Buffer>) {
  const stats = { bytesRead: 0, reads: 0 };
  const source: JsonlByteSource = {
    size: (p) => (p in files ? Buffer.from(files[p]!).length : undefined),
    readRange: (p, position, length) => {
      const buf = Buffer.from(files[p]!).subarray(position, position + length);
      stats.bytesRead += buf.length;
      stats.reads++;
      return Buffer.from(buf);
    },
  };
  return { source, stats };
}

const jsonl = (...records: unknown[]): string =>
  records.map((r) => `${JSON.stringify(r)}\n`).join('');

const CHUNK_SIZES = [1, 2, 3, 5, 7, 16, 1024];

describe('jsonl-read', () => {
  describe('chunk-boundary reassembly', () => {
    const records = Array.from({ length: 12 }, (_, i) => ({ n: i, pad: 'é'.repeat(i) }));
    const content = jsonl(...records);

    for (const chunkBytes of CHUNK_SIZES) {
      it(`forward and backward agree with chunkBytes=${chunkBytes}`, () => {
        const { source } = memorySource({ f: content });
        expect([...streamJsonLines('f', { source, chunkBytes })]).toEqual(records);
        expect([...readJsonLinesBackward('f', { source, chunkBytes })]).toEqual(
          [...records].reverse()
        );
        expect(readLastJsonLine('f', { source, chunkBytes })).toEqual(records[11]);
      });
    }

    it('reassembles a line longer than one chunk', () => {
      const long = { big: 'x'.repeat(5000) };
      const { source } = memorySource({ f: jsonl({ a: 1 }, long, { b: 2 }) });
      expect([...streamJsonLines('f', { source, chunkBytes: 64 })]).toEqual([
        { a: 1 },
        long,
        { b: 2 },
      ]);
      expect([...readJsonLinesBackward('f', { source, chunkBytes: 64 })]).toEqual([
        { b: 2 },
        long,
        { a: 1 },
      ]);
    });
  });

  describe('line endings and empty input', () => {
    it('handles CRLF line endings in both directions', () => {
      const { source } = memorySource({ f: '{"a":1}\r\n{"a":2}\r\n' });
      for (const chunkBytes of [1, 3, 64]) {
        expect([...streamJsonLines('f', { source, chunkBytes })]).toEqual([{ a: 1 }, { a: 2 }]);
        expect([...readJsonLinesBackward('f', { source, chunkBytes })]).toEqual([
          { a: 2 },
          { a: 1 },
        ]);
      }
      expect([...streamTextLines('f', { source })].map((l) => l.text)).toEqual([
        '{"a":1}',
        '{"a":2}',
      ]);
    });

    it('returns empty / null for an empty or missing file', () => {
      const { source } = memorySource({ empty: '' });
      for (const p of ['empty', 'missing']) {
        expect([...streamJsonLines(p, { source })]).toEqual([]);
        expect([...readJsonLinesBackward(p, { source })]).toEqual([]);
        expect(readLastJsonLine(p, { source })).toBeNull();
        expect(readJsonLinesSince(p, { source, timeOf: () => 0, sinceMs: 0 })).toEqual([]);
        expect(fileEndsWithNewline(p, { source })).toBe(true);
      }
    });

    it('skips blank lines and keeps line numbers for raw scans', () => {
      const { source } = memorySource({ f: '\n{"a":1}\n\n{"a":2}' });
      expect([...streamTextLines('f', { source, chunkBytes: 2 })]).toEqual([
        { text: '', lineNumber: 1, terminated: true, byteStart: 0, byteEnd: 1 },
        { text: '{"a":1}', lineNumber: 2, terminated: true, byteStart: 1, byteEnd: 9 },
        { text: '', lineNumber: 3, terminated: true, byteStart: 9, byteEnd: 10 },
        { text: '{"a":2}', lineNumber: 4, terminated: false, byteStart: 10, byteEnd: 17 },
      ]);
      expect(
        [...streamTextLinesBackward('f', { source, chunkBytes: 2 })].map((l) => l.text)
      ).toEqual(['{"a":2}', '', '{"a":1}', '']);
      expect([...readJsonLinesBackward('f', { source })]).toEqual([{ a: 2 }, { a: 1 }]);
    });

    it('fileEndsWithNewline reads only the last byte', () => {
      const { source, stats } = memorySource({ yes: '{"a":1}\n'.repeat(1000), no: '{"a":1}' });
      expect(fileEndsWithNewline('yes', { source })).toBe(true);
      expect(stats.bytesRead).toBe(1);
      expect(fileEndsWithNewline('no', { source })).toBe(false);
    });
  });

  describe('torn tail', () => {
    it('backward readers skip an unterminated final line that fails to parse', () => {
      const { source } = memorySource({ f: '{"a":1}\n{"a":2}\n{"a":' });
      for (const chunkBytes of [1, 4, 64]) {
        expect(readLastJsonLine('f', { source, chunkBytes })).toEqual({ a: 2 });
        expect([...readJsonLinesBackward('f', { source, chunkBytes })]).toEqual([
          { a: 2 },
          { a: 1 },
        ]);
      }
    });

    it('backward readers keep an unterminated final line that parses', () => {
      const { source } = memorySource({ f: '{"a":1}\n{"a":2}' });
      expect(readLastJsonLine('f', { source, chunkBytes: 3 })).toEqual({ a: 2 });
    });

    it('a torn tail is never silently skipped when terminated (malformed policy applies)', () => {
      const { source } = memorySource({ f: '{"a":1}\n{"a":\n' });
      expect(() => readLastJsonLine('f', { source })).toThrow();
      expect(readLastJsonLine('f', { source, onMalformed: 'skip' })).toEqual({ a: 1 });
    });

    it('the forward reader applies the malformed policy to a torn tail', () => {
      const { source } = memorySource({ f: '{"a":1}\n{"a":' });
      expect(() => [...streamJsonLines('f', { source })]).toThrow();
      expect([...streamJsonLines('f', { source, onMalformed: 'skip' })]).toEqual([{ a: 1 }]);
    });
  });

  describe('malformed lines', () => {
    const content = '{"a":1}\nnot json\n{"a":3}\n';

    it("throws by default ('throw'), like readJsonLines", () => {
      const { source } = memorySource({ f: content });
      expect(() => [...streamJsonLines('f', { source })]).toThrow();
      expect(() => [...readJsonLinesBackward('f', { source })]).toThrow();
    });

    it("'skip' drops malformed lines", () => {
      const { source } = memorySource({ f: content });
      expect([...streamJsonLines('f', { source, onMalformed: 'skip' })]).toEqual([
        { a: 1 },
        { a: 3 },
      ]);
      expect([...readJsonLinesBackward('f', { source, onMalformed: 'skip' })]).toEqual([
        { a: 3 },
        { a: 1 },
      ]);
    });

    it('a callback receives the line number and raw line', () => {
      const { source } = memorySource({ f: content });
      const seen: Array<[number, string]> = [];
      const records = [
        ...streamJsonLines('f', {
          source,
          onMalformed: (_e, n, raw) => seen.push([n, raw]),
        }),
      ];
      expect(records).toEqual([{ a: 1 }, { a: 3 }]);
      expect(seen).toEqual([[2, 'not json']]);
    });

    it('mapper failures follow the same policy and map receives line numbers', () => {
      const { source } = memorySource({ f: jsonl({ a: 1 }, { a: -1 }, { a: 3 }) });
      const map = (value: unknown, n: number) => {
        const a = (value as { a: number }).a;
        if (a < 0) throw new Error('negative');
        return { a, n };
      };
      expect(() => [...streamJsonLines('f', { source, map })]).toThrow('negative');
      expect([...streamJsonLines('f', { source, map, onMalformed: 'skip' })]).toEqual([
        { a: 1, n: 1 },
        { a: 3, n: 3 },
      ]);
      // Backward line numbers count from the end (1 = last line).
      expect([...readJsonLinesBackward('f', { source, map, onMalformed: 'skip' })]).toEqual([
        { a: 3, n: 1 },
        { a: 1, n: 3 },
      ]);
    });
  });

  describe('oversized line guard', () => {
    const huge = JSON.stringify({ big: 'x'.repeat(500) });
    const content = `{"a":1}\n${huge}\n{"a":3}\n`;

    for (const chunkBytes of [7, 64, 4096]) {
      it(`reports and skips a line over maxLineBytes (chunkBytes=${chunkBytes})`, () => {
        const { source } = memorySource({ f: content });
        const opts = { source, chunkBytes, maxLineBytes: 100 };
        expect(() => [...streamJsonLines('f', opts)]).toThrow(JsonlLineTooLongError);
        expect(() => [...readJsonLinesBackward('f', opts)]).toThrow(JsonlLineTooLongError);
        expect([...streamJsonLines('f', { ...opts, onMalformed: 'skip' })]).toEqual([
          { a: 1 },
          { a: 3 },
        ]);
        expect([...readJsonLinesBackward('f', { ...opts, onMalformed: 'skip' })]).toEqual([
          { a: 3 },
          { a: 1 },
        ]);
        const errors: unknown[] = [];
        const lines: number[] = [];
        const survivors = Array.from(
          streamJsonLines('f', {
            ...opts,
            onMalformed: (e, n) => {
              errors.push(e);
              lines.push(n);
            },
          })
        );
        expect(survivors).toEqual([{ a: 1 }, { a: 3 }]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toBeInstanceOf(JsonlLineTooLongError);
        expect(lines).toEqual([2]);
      });
    }

    it('skips an oversized first line and an oversized unterminated last line', () => {
      const { source } = memorySource({ f: `${huge}\n{"a":2}\n${huge}` });
      const opts = { source, chunkBytes: 16, maxLineBytes: 100, onMalformed: 'skip' as const };
      expect([...streamJsonLines('f', opts)]).toEqual([{ a: 2 }]);
      expect([...readJsonLinesBackward('f', opts)]).toEqual([{ a: 2 }]);
    });
  });

  describe('backward early stop', () => {
    it('reads only the tail when the caller breaks', () => {
      const records = Array.from({ length: 2000 }, (_, i) => ({ n: i }));
      const { source, stats } = memorySource({ f: jsonl(...records) });
      const total = Buffer.byteLength(jsonl(...records));
      const it = readJsonLinesBackward<{ n: number }>('f', { source, chunkBytes: 256 });
      const newest = it.next().value;
      expect(newest).toEqual({ n: 1999 });
      expect(stats.bytesRead).toBeLessThanOrEqual(256);
      expect(stats.bytesRead).toBeLessThan(total);
    });

    it('readJsonLinesSince returns oldest-first and stops after a run of older records', () => {
      const records = Array.from({ length: 1000 }, (_, i) => ({ t: i * 10 }));
      const { source, stats } = memorySource({ f: jsonl(...records) });
      const total = Buffer.byteLength(jsonl(...records));
      const recent = readJsonLinesSince<{ t: number }>('f', {
        source,
        chunkBytes: 128,
        timeOf: (r) => r.t,
        sinceMs: 9950,
      });
      expect(recent.map((r) => r.t)).toEqual([9950, 9960, 9970, 9980, 9990]);
      expect(stats.bytesRead).toBeLessThan(total / 10);
    });

    it('readJsonLinesSince skips a skewed-clock old row instead of stopping at it', () => {
      // A row stamped long before the window sits between in-window rows.
      const { source } = memorySource({
        f: jsonl({ t: 1 }, { t: 2 }, { t: 50 }, { t: 60 }, { t: 3 }, { t: 70 }, { t: 80 }),
      });
      const since = (stopAfterOlder?: number) =>
        readJsonLinesSince<{ t: number }>('f', {
          source,
          timeOf: (r) => r.t,
          sinceMs: 10,
          stopAfterOlder,
        }).map((r) => r.t);
      expect(since()).toEqual([50, 60, 70, 80]);
      expect(DEFAULT_SINCE_STOP_AFTER_OLDER).toBe(64);
      // The bound is a run of consecutive older rows: K=1 restores the old early stop.
      expect(since(1)).toEqual([70, 80]);
      expect(since(2)).toEqual([50, 60, 70, 80]);
    });

    it('readJsonLinesSince honours maxRecords and keeps records without a time', () => {
      const { source } = memorySource({
        f: jsonl({ t: 1 }, { t: 5 }, { note: 'untimed' }, { t: 6 }, { t: 7 }),
      });
      const since = (maxRecords?: number) =>
        readJsonLinesSince<{ t?: number }>('f', {
          source,
          timeOf: (r) => r.t,
          sinceMs: 5,
          maxRecords,
        });
      expect(since()).toEqual([{ t: 5 }, { note: 'untimed' }, { t: 6 }, { t: 7 }]);
      expect(since(2)).toEqual([{ t: 6 }, { t: 7 }]);
    });
  });

  describe('governed default source (real files under active/shared/tmp)', () => {
    let dir: string;
    beforeEach(() => {
      dir = sharedTmp(`jsonl-read-${randomUUID().slice(0, 8)}`);
      safeMkdir(dir, { recursive: true });
    });
    afterEach(() => {
      safeRmSync(dir, { recursive: true, force: true });
    });

    it('reads through secure-io range reads with small chunks', () => {
      const file = path.join(dir, 'store.jsonl');
      const records = Array.from({ length: 50 }, (_, i) => ({ n: i, s: 'ü'.repeat(i % 7) }));
      safeWriteFile(file, jsonl(...records) + '{"torn":');
      expect([...streamJsonLines(file, { chunkBytes: 17, onMalformed: 'skip' })]).toEqual(records);
      expect(readLastJsonLine(file, { chunkBytes: 17 })).toEqual(records[49]);
      expect(fileEndsWithNewline(file)).toBe(false);
      expect(readLastJsonLine(path.join(dir, 'missing.jsonl'))).toBeNull();
    });

    it('a scan stays on its inode when the path is renamed aside and replaced mid-scan', () => {
      const file = path.join(dir, 'store.jsonl');
      const records = Array.from({ length: 40 }, (_, i) => ({ n: i }));
      const replacement = jsonl({ replaced: true });
      const replaceMidScan = (): void => {
        safeMoveSync(file, path.join(dir, 'store.jsonl.compacting-1'));
        safeWriteFile(file, replacement);
      };

      safeWriteFile(file, jsonl(...records));
      const forward = streamJsonLines<{ n: number }>(file, { chunkBytes: 16 });
      const seen = [forward.next().value, forward.next().value];
      replaceMidScan();
      expect([...seen, ...forward]).toEqual(records);

      safeWriteFile(file, jsonl(...records));
      const backward = readJsonLinesBackward<{ n: number }>(file, { chunkBytes: 16 });
      const newest = [backward.next().value, backward.next().value];
      replaceMidScan();
      expect([...newest, ...backward]).toEqual([...records].reverse());
    });
  });

  describe('scan handle lifecycle', () => {
    function pinnedSource(content: string) {
      const events: string[] = [];
      const buf = Buffer.from(content);
      const source: JsonlByteSource = {
        size: () => buf.length,
        readRange: () => {
          throw new Error('by-path read must not be used when open() exists');
        },
        open: (): JsonlPinnedReader => {
          events.push('open');
          return {
            size: buf.length,
            read: (position, length) => Buffer.from(buf.subarray(position, position + length)),
            close: () => events.push('close'),
          };
        },
      };
      return { source, events };
    }

    it('opens once per scan and closes on completion, early break and error', () => {
      const content = jsonl({ a: 1 }, { a: 2 }, { a: 3 });
      const done = pinnedSource(content);
      expect([...streamJsonLines('f', { source: done.source, chunkBytes: 4 })]).toHaveLength(3);
      expect(done.events).toEqual(['open', 'close']);

      const early = pinnedSource(content);
      for (const record of streamJsonLines('f', { source: early.source, chunkBytes: 4 })) {
        expect(record).toEqual({ a: 1 });
        break;
      }
      expect(early.events).toEqual(['open', 'close']);

      const last = pinnedSource(content);
      expect(readLastJsonLine('f', { source: last.source, chunkBytes: 4 })).toEqual({ a: 3 });
      expect(last.events).toEqual(['open', 'close']);

      const broken = pinnedSource(`${content}not json\n`);
      expect(() => [...streamJsonLines('f', { source: broken.source })]).toThrow();
      expect(broken.events).toEqual(['open', 'close']);

      const unstarted = pinnedSource(content);
      streamJsonLines('f', { source: unstarted.source });
      expect(unstarted.events).toEqual([]);
    });

    it('a by-path source restarts once when the file is replaced before anything was emitted', () => {
      const files: Record<string, Buffer> = { f: Buffer.from(jsonl({ old: 1 }, { old: 2 })) };
      let ino = 1;
      let reads = 0;
      const source: JsonlByteSource = {
        size: (p) => files[p]?.length,
        identity: (p) => (files[p] ? { dev: 1, ino } : undefined),
        readRange: (p, position, length) => {
          reads++;
          if (reads === 1) {
            files.f = Buffer.from(jsonl({ fresh: 1 }));
            ino = 2;
          }
          return Buffer.from(files[p]!.subarray(position, position + length));
        },
      };
      expect([...streamJsonLines('f', { source, chunkBytes: 4 })]).toEqual([{ fresh: 1 }]);
    });

    it('a by-path source raises JsonlSourceChangedError when the file is replaced after lines were emitted', () => {
      const files: Record<string, Buffer> = {
        f: Buffer.from(jsonl({ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 })),
      };
      const source: JsonlByteSource = {
        size: (p) => files[p]?.length,
        readRange: (p, position, length) =>
          Buffer.from(files[p]!.subarray(position, position + length)),
      };
      const scan = streamJsonLines('f', { source, chunkBytes: 8 });
      expect(scan.next().value).toEqual({ n: 1 });
      files.f = Buffer.from(jsonl({ n: 9 })); // smaller replacement (rotation)
      expect(() => [...scan]).toThrow(JsonlSourceChangedError);
    });
  });
});
