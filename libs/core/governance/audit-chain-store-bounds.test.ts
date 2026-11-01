import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { AuditChainIo, AuditEntry } from './audit-chain.js';

// MSN-STORE-BOUNDS-20261101: an append reads only the last byte of the daily
// file, and the cursor seeds from the tail of the newest non-empty daily file,
// so neither cost grows with the chain and no size makes the chain fork.

let testRoot: string;
const GLOBAL_KEY = Symbol.for('@kyberion/audit-chain');

vi.mock('../path-resolver.js', () => ({
  pathResolver: {
    rootDir: () => testRoot,
    rootResolve: (sub = '') => path.join(testRoot, sub),
    shared: (sub = '') => path.join(testRoot, 'active', 'shared', sub),
  },
  rootDir: () => testRoot,
}));

vi.mock('../secure-io.js', async () => {
  const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    safeAppendFileSync: (p: string, data: string) => {
      actualFs.mkdirSync(path.dirname(p), { recursive: true });
      actualFs.appendFileSync(p, data);
    },
    safeExistsSync: (p: string) => actualFs.existsSync(p),
    safeReaddir: (p: string) => actualFs.readdirSync(p),
    safeMkdir: (p: string, opts: any) => actualFs.mkdirSync(p, opts),
    safeReadFile: (p: string, opts: any) => actualFs.readFileSync(p, opts),
    safeCreateExclusiveFileSync: (p: string, data: string) => {
      actualFs.mkdirSync(path.dirname(p), { recursive: true });
      actualFs.writeFileSync(p, data, { flag: 'wx' });
    },
    safeUnlinkSync: (p: string) => {
      try {
        actualFs.unlinkSync(p);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
    },
    safeWriteFile: (p: string, data: string) => {
      actualFs.mkdirSync(path.dirname(p), { recursive: true });
      actualFs.writeFileSync(p, data);
    },
    loadJsonIfPresent: <T>(p: string): T | null => {
      if (!actualFs.existsSync(p)) return null;
      try {
        return JSON.parse(actualFs.readFileSync(p, 'utf8')) as T;
      } catch {
        return null;
      }
    },
  };
});

vi.mock('./audit-forwarder.js', () => ({
  getAuditForwarder: () => ({ name: 'stub', publish: async () => {} }),
}));

interface RangeIo extends AuditChainIo {
  reads: string[];
  rangeReads: Array<{ file: string; position: number; length: number }>;
  failRangeFor?: string;
}

/** Real-filesystem audit I/O with range reads; whole-file `read` is recorded. */
function rangeIo(): RangeIo {
  const io: RangeIo = {
    reads: [],
    rangeReads: [],
    read: (file) => {
      io.reads.push(file);
      throw new Error('File too large: whole-file read past the cap');
    },
    loadJson: <T>(file: string) => JSON.parse(fs.readFileSync(file, 'utf8')) as T,
    exists: (file) => fs.existsSync(file),
    mkdir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    readdir: (dir) => fs.readdirSync(dir),
    append: (file, content) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, content);
    },
    assertSafePath: (file) => file,
    size: (file) => (fs.existsSync(file) ? fs.statSync(file).size : undefined),
    readRange: (file, position, length) => {
      io.rangeReads.push({ file, position, length });
      if (io.failRangeFor && file.endsWith(io.failRangeFor)) {
        throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
          code: 'EACCES',
        });
      }
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(length);
        const n = fs.readSync(fd, buf, 0, length, position);
        return buf.subarray(0, n);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
  return io;
}

const auditDir = () => path.join(testRoot, 'active', 'shared', 'logs', 'audit');
const auditFile = (date: string) => path.join(auditDir(), `audit-${date}.jsonl`);
const readEntries = (date: string): AuditEntry[] =>
  fs
    .readFileSync(auditFile(date), 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AuditEntry];
      } catch {
        return [];
      }
    });

async function freshChain(at: Date, io: AuditChainIo) {
  vi.setSystemTime(at);
  vi.resetModules();
  delete (globalThis as any)[GLOBAL_KEY];
  const mod = await import('./audit-chain.js');
  mod.setAuditChainScanOptionsForTests({ chunkBytes: 64 });
  const restore = mod.registerAuditChainIo(io);
  return { ...mod, restore };
}

const event = (operation: string) => ({
  agentId: 'store-bounds',
  action: 'test',
  operation,
  result: 'completed' as const,
});

describe('audit-chain — size-independent append and seed', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-audit-tenant-'));
    for (const key of ['KYBERION_TENANT', 'MISSION_ID']) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.useFakeTimers();
    delete (globalThis as any)[GLOBAL_KEY];
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(testRoot, { recursive: true, force: true });
    delete (globalThis as any)[GLOBAL_KEY];
    vi.useRealTimers();
  });

  it('appends and re-seeds a multi-chunk daily file without a whole-file read', async () => {
    const io = rangeIo();
    const chain = await freshChain(new Date('2026-07-01T10:00:00.000Z'), io);
    const recorded = [1, 2, 3, 4].map((i) => chain.auditChain.record(event(`op-${i}`)));
    chain.restore();

    // Each entry is far larger than the 64-byte chunk: the file is "over the cap".
    expect(fs.statSync(auditFile('2026-07-01')).size).toBeGreaterThan(64 * 8);
    const onDisk = readEntries('2026-07-01');
    expect(onDisk.map((entry) => entry.previousHash)).toEqual([
      expect.any(String),
      ...recorded.slice(0, 3).map((entry) => entry.currentHash),
    ]);

    // A new process seeds from the tail only, and keeps the id counter going.
    const next = await freshChain(new Date('2026-07-01T11:00:00.000Z'), io);
    const after = next.auditChain.record(event('op-5'));
    next.restore();
    expect(after.previousHash).toBe(recorded[3].currentHash);
    expect(after.id).toMatch(/-5$/);

    expect(io.reads).toEqual([]);
    // The append's newline probe reads one byte, not the file.
    expect(io.rangeReads.some((read) => read.length === 1)).toBe(true);
    expect(Math.max(...io.rangeReads.map((read) => read.length))).toBeLessThanOrEqual(64);
  });

  it('chains past a torn last line and keeps the fragment on its own line', async () => {
    const io = rangeIo();
    const first = await freshChain(new Date('2026-07-01T10:00:00.000Z'), io);
    const before = first.auditChain.record(event('before'));
    first.restore();
    fs.appendFileSync(auditFile('2026-07-01'), '{"id":"AUD-TORN","currentHash":"ab');

    const next = await freshChain(new Date('2026-07-01T11:00:00.000Z'), io);
    const after = next.auditChain.record(event('after'));
    next.restore();

    expect(after.previousHash).toBe(before.currentHash);
    const lines = fs.readFileSync(auditFile('2026-07-01'), 'utf8').split('\n');
    expect(lines[1]).toBe('{"id":"AUD-TORN","currentHash":"ab');
    expect(JSON.parse(lines[2]).id).toBe(after.id);
    expect(io.reads).toEqual([]);
  });

  it('falls back to an older daily file when the newest one is empty', async () => {
    const io = rangeIo();
    const first = await freshChain(new Date('2026-07-01T10:00:00.000Z'), io);
    const older = first.auditChain.record(event('older'));
    first.restore();
    fs.writeFileSync(auditFile('2026-07-02'), '');
    fs.writeFileSync(auditFile('2026-07-03'), '\n\n');

    const next = await freshChain(new Date('2026-07-03T10:00:00.000Z'), io);
    const after = next.auditChain.record(event('newer'));
    next.restore();
    expect(after.previousHash).toBe(older.currentHash);
  });

  it('refuses to append when the newest daily file cannot be read, instead of forking', async () => {
    const io = rangeIo();
    const first = await freshChain(new Date('2026-07-01T10:00:00.000Z'), io);
    first.auditChain.record(event('day-1'));
    first.restore();
    const second = await freshChain(new Date('2026-07-02T10:00:00.000Z'), io);
    second.auditChain.record(event('day-2'));
    second.restore();
    const day2Size = fs.statSync(auditFile('2026-07-02')).size;

    io.failRangeFor = 'audit-2026-07-02.jsonl';
    const next = await freshChain(new Date('2026-07-02T11:00:00.000Z'), io);
    expect(() => next.auditChain.record(event('day-2-later'))).toThrow(
      '[AUDIT_CHAIN_TAIL_UNREADABLE]'
    );
    // Nothing was chained from day 1's older hash.
    io.failRangeFor = undefined;
    next.restore();
    expect(fs.statSync(auditFile('2026-07-02')).size).toBe(day2Size);
  });

  it('streams verification of a multi-chunk file without a whole-file read', async () => {
    const io = rangeIo();
    const chain = await freshChain(new Date('2026-07-01T10:00:00.000Z'), io);
    for (const i of [1, 2, 3]) chain.auditChain.record(event(`v-${i}`));
    fs.appendFileSync(auditFile('2026-07-01'), 'not-json\n');
    const result = chain.auditChain.verify();
    chain.restore();
    expect(result.total).toBe(4);
    expect(result.corrupted).toEqual(['audit-2026-07-01.jsonl:line:4:invalid_record']);
    expect(io.reads).toEqual([]);
  });
});
