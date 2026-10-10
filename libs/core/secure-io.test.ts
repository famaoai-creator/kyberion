import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `node:fs` is a native ESM namespace whose exports are non-configurable, so
// `vi.spyOn(fs, 'readSync')` cannot redefine the property directly. Mocking
// the module with a `vi.fn` wrapper around the real implementation gives the
// byte-bound and snapshot-race tests below spyable references while
// every other export (used throughout this file's fixtures) stays real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    constants: { ...actual.constants },
    readSync: vi.fn(actual.readSync),
    openSync: vi.fn(actual.openSync),
    fstatSync: vi.fn(actual.fstatSync),
    lstatSync: vi.fn(actual.lstatSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
import {
  validateFileSize,
  buildSafeExecEnv,
  ensureDir,
  loadJson,
  loadJsonIfPresent,
  safeExec,
  safeExecResult,
  assertSafeRepositoryPath,
  safeReadFile,
  MAX_RANGE_READ_BYTES,
  safeReadFileRange,
  MAX_SNAPSHOT_READ_BYTES,
  safeReadFileSnapshot,
  safeReadFileTail,
  safeRealpath,
  safeStatfs,
  safeWriteFile,
  sanitizePath,
  validateUrl,
} from './secure-io.js';

describe('secure-io core', () => {
  let tmpDir: string;

  beforeEach(() => {
    const tmpRoot = path.join(process.cwd(), 'active', 'shared', 'tmp', 'tests');
    if (!fs.existsSync(tmpRoot)) fs.mkdirSync(tmpRoot, { recursive: true });
    tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'secure-io-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('validateFileSize', () => {
    it('should return size for a small file', () => {
      const testFile = path.join(tmpDir, 'small.txt');
      fs.writeFileSync(testFile, 'Hello, World!');
      const size = validateFileSize(testFile);
      expect(size).toBe(13);
    });

    it('should throw for oversized file', () => {
      const testFile = path.join(tmpDir, 'large.txt');
      fs.writeFileSync(testFile, 'x'.repeat(100));
      expect(() => validateFileSize(testFile, 0.00001)).toThrow('File too large');
    });
  });

  describe('safeReadFile', () => {
    it('should read a valid file', () => {
      const testFile = path.join(tmpDir, 'read.txt');
      fs.writeFileSync(testFile, 'Safe content');
      const content = safeReadFile(testFile);
      expect(content.toString()).toBe('Safe content');
    });

    it('should throw for missing file', () => {
      expect(() => safeReadFile(path.join(tmpDir, 'missing.txt'))).toThrow('File not found');
    });

    it('should throw for empty path', () => {
      expect(() => safeReadFile('')).toThrow('Missing required');
    });

    it('denies credential and Kyberion connection paths before filesystem access', () => {
      expect(() => safeReadFile(path.join(os.homedir(), '.ssh/id_ed25519'))).toThrow(
        '[SENSITIVE_PATH_DENIED]'
      );
      expect(() =>
        safeReadFile(path.join(process.cwd(), 'knowledge/personal/connections/slack.json'))
      ).toThrow('[SENSITIVE_PATH_DENIED]');
    });
  });

  describe('safeReadFileRange', () => {
    it('reads a bounded window and a short final window', () => {
      const testFile = path.join(tmpDir, 'range.txt');
      const content = '0123456789'.repeat(10);
      fs.writeFileSync(testFile, content);
      expect(safeReadFileRange(testFile, 5, 10).toString('utf8')).toBe(content.slice(5, 15));
      expect(safeReadFileRange(testFile, 95, 10).toString('utf8')).toBe(content.slice(95));
      expect(safeReadFileRange(testFile, 200, 10).length).toBe(0);
    });

    it('rejects invalid bounds and symlinks', () => {
      const testFile = path.join(tmpDir, 'range-target.txt');
      fs.writeFileSync(testFile, 'abc');
      expect(() => safeReadFileRange(testFile, -1, 1)).toThrow('Invalid position');
      expect(() => safeReadFileRange(testFile, 0, 0)).toThrow('Invalid length');
      const link = path.join(tmpDir, 'range-link.txt');
      fs.symlinkSync(testFile, link);
      expect(() => safeReadFileRange(link, 0, 1)).toThrow('symbolic link');
    });

    it('refuses a window larger than the range cap', () => {
      const testFile = path.join(tmpDir, 'range-cap.txt');
      fs.writeFileSync(testFile, 'abc');
      expect(safeReadFileRange(testFile, 0, MAX_RANGE_READ_BYTES).toString('utf8')).toBe('abc');
      expect(() => safeReadFileRange(testFile, 0, MAX_RANGE_READ_BYTES + 1)).toThrow('exceeds the');
    });
  });

  describe('safeReadFileSnapshot', () => {
    let actualFs: typeof fs;
    const supported = fs.constants.O_NOFOLLOW > 0 && fs.constants.O_NONBLOCK > 0;
    const snapshotIt = it.skipIf(!supported);

    beforeEach(async () => {
      actualFs = await vi.importActual<typeof fs>('node:fs');
      vi.mocked(fs.readSync).mockReset().mockImplementation(actualFs.readSync);
      vi.mocked(fs.openSync).mockReset().mockImplementation(actualFs.openSync);
      vi.mocked(fs.fstatSync).mockReset().mockImplementation(actualFs.fstatSync);
      vi.mocked(fs.lstatSync).mockReset().mockImplementation(actualFs.lstatSync);
      vi.mocked(fs.closeSync).mockReset().mockImplementation(actualFs.closeSync);
    });

    afterEach(() => {
      vi.mocked(fs.readSync).mockReset().mockImplementation(actualFs.readSync);
      vi.mocked(fs.openSync).mockReset().mockImplementation(actualFs.openSync);
      vi.mocked(fs.fstatSync).mockReset().mockImplementation(actualFs.fstatSync);
      vi.mocked(fs.lstatSync).mockReset().mockImplementation(actualFs.lstatSync);
      vi.mocked(fs.closeSync).mockReset().mockImplementation(actualFs.closeSync);
    });

    snapshotIt('returns exact binary bytes at the limit and supports empty files', () => {
      const file = path.join(tmpDir, 'snapshot.bin');
      const bytes = Buffer.from([0, 255, 12, 128, 0]);
      fs.writeFileSync(file, bytes);
      expect(safeReadFileSnapshot(file, bytes.length)).toEqual(bytes);
      expect(fs.openSync).toHaveBeenCalledWith(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      fs.writeFileSync(file, '');
      expect(safeReadFileSnapshot(file, 1)).toEqual(Buffer.alloc(0));
    });

    snapshotIt('continues partial reads without exceeding the byte limit plus one', () => {
      const file = path.join(tmpDir, 'snapshot-partial.txt');
      fs.writeFileSync(file, 'abcdef');
      vi.mocked(fs.readSync).mockImplementation((fd, buffer, offset, length, position) =>
        actualFs.readSync(fd, buffer, offset, Math.min(length, 2), position)
      );
      expect(safeReadFileSnapshot(file, 6).toString()).toBe('abcdef');
      expect(fs.readSync).toHaveBeenCalledTimes(4);
      for (const call of vi.mocked(fs.readSync).mock.calls) {
        expect(call[1].byteLength).toBeLessThanOrEqual(7);
        expect(call[2] + call[3]).toBeLessThanOrEqual(7);
      }
    });

    it.each([0, -1, 1.5, NaN, Infinity, -Infinity, MAX_SNAPSHOT_READ_BYTES + 1])(
      'rejects invalid cap %p before opening a file',
      (cap) => {
        expect(() => safeReadFileSnapshot(path.join(tmpDir, 'missing'), cap)).toThrow(
          'Invalid maxBytes'
        );
        expect(fs.openSync).not.toHaveBeenCalled();
      }
    );

    it.each(['O_NOFOLLOW', 'O_NONBLOCK'] as const)(
      'fails closed when %s is unsupported',
      (flag) => {
        const original = fs.constants[flag];
        Object.defineProperty(fs.constants, flag, { value: 0, configurable: true });
        try {
          expect(() => safeReadFileSnapshot(path.join(tmpDir, 'missing'), 1)).toThrow(
            'unsupported on this platform'
          );
          expect(fs.openSync).not.toHaveBeenCalled();
        } finally {
          Object.defineProperty(fs.constants, flag, { value: original, configurable: true });
        }
      }
    );

    snapshotIt('rejects oversized files and directories before opening or reading', () => {
      const file = path.join(tmpDir, 'snapshot-oversize.txt');
      fs.writeFileSync(file, 'abcdef');
      expect(() => safeReadFileSnapshot(file, 5)).toThrow('snapshot byte limit');
      expect(() => safeReadFileSnapshot(tmpDir, 5)).toThrow('Not a regular file');
      expect(fs.openSync).not.toHaveBeenCalled();
      expect(fs.readSync).not.toHaveBeenCalled();
    });

    snapshotIt('rejects leaf and ancestor symlinks without reading', () => {
      const dir = path.join(tmpDir, 'snapshot-real');
      const link = path.join(tmpDir, 'snapshot-linked');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'file'), 'abc');
      fs.symlinkSync(dir, link, 'dir');
      const leaf = path.join(tmpDir, 'snapshot-leaf');
      fs.symlinkSync(path.join(dir, 'file'), leaf);
      expect(() => safeReadFileSnapshot(leaf, 3)).toThrow('RESOURCE_PATH_SYMLINK');
      expect(() => safeReadFileSnapshot(path.join(link, 'file'), 3)).toThrow(
        'RESOURCE_PATH_SYMLINK'
      );
      expect(fs.readSync).not.toHaveBeenCalled();
    });

    snapshotIt('rejects a same-sized different inode returned by open before any read', () => {
      const file = path.join(tmpDir, 'snapshot-authorized');
      const other = path.join(tmpDir, 'snapshot-unauthorized');
      fs.writeFileSync(file, 'aaa');
      fs.writeFileSync(other, 'bbb');
      let opened = -1;
      // Models swap/open/restore: the path still names A when open returns B's fd.
      vi.mocked(fs.openSync).mockImplementationOnce((_file, flags) => {
        opened = actualFs.openSync(other, flags);
        return opened;
      });
      expect(() => safeReadFileSnapshot(file, 3)).toThrow('changed before snapshot read');
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(fs.closeSync).toHaveBeenCalledWith(opened);
      expect(() => actualFs.fstatSync(opened)).toThrow();
    });

    snapshotIt('refuses a leaf swapped to a symlink immediately before open', () => {
      const file = path.join(tmpDir, 'snapshot-open-leaf');
      const other = path.join(tmpDir, 'snapshot-other');
      fs.writeFileSync(file, 'aaa');
      fs.writeFileSync(other, 'bbb');
      vi.mocked(fs.openSync).mockImplementationOnce((target, flags) => {
        fs.unlinkSync(file);
        fs.symlinkSync(other, file);
        return actualFs.openSync(target, flags);
      });
      expect(() => safeReadFileSnapshot(file, 3)).toThrow();
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(fs.closeSync).not.toHaveBeenCalled();
    });

    snapshotIt('rejects ancestor swap/open/restore before reading the different inode', () => {
      const dir = path.join(tmpDir, 'snapshot-parent');
      const other = path.join(tmpDir, 'snapshot-other-parent');
      const saved = path.join(tmpDir, 'snapshot-parent-saved');
      fs.mkdirSync(dir);
      fs.mkdirSync(other);
      const file = path.join(dir, 'file');
      fs.writeFileSync(file, 'aaa');
      fs.writeFileSync(path.join(other, 'file'), 'bbb');
      vi.mocked(fs.openSync).mockImplementationOnce((target, flags) => {
        fs.renameSync(dir, saved);
        fs.symlinkSync(other, dir, 'dir');
        try {
          return actualFs.openSync(target, flags);
        } finally {
          fs.unlinkSync(dir);
          fs.renameSync(saved, dir);
        }
      });
      expect(() => safeReadFileSnapshot(file, 3)).toThrow('changed before snapshot read');
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(fs.closeSync).toHaveBeenCalledOnce();
    });

    snapshotIt(
      'rejects repeated ancestor substitutions restored around each strict path check',
      () => {
        const dir = path.join(tmpDir, 'snapshot-repeated-parent');
        const saved = path.join(tmpDir, 'snapshot-repeated-saved');
        const other = path.join(tmpDir, 'snapshot-repeated-other');
        fs.mkdirSync(dir);
        fs.mkdirSync(other);
        const file = path.join(dir, 'file');
        fs.writeFileSync(file, 'aaa');
        fs.writeFileSync(path.join(other, 'file'), 'bbb');
        const originalDirectory = actualFs.lstatSync(dir, { bigint: true });
        let swapped = false;
        const swap = () => {
          fs.renameSync(dir, saved);
          fs.symlinkSync(other, dir, 'dir');
          swapped = true;
        };
        const restore = () => {
          if (!swapped) return;
          fs.unlinkSync(dir);
          fs.renameSync(saved, dir);
          swapped = false;
        };
        let leafStats = 0;
        vi.mocked(fs.lstatSync).mockImplementation((target, options) => {
          if (target !== file || !options?.bigint) return actualFs.lstatSync(target, options);
          leafStats += 1;
          // Both leaf samples deliberately see B, while all strict path walks
          // see A. The first substitution stays in place through open/read.
          swap();
          const stat = actualFs.lstatSync(target, options);
          if (leafStats > 1) restore();
          return stat;
        });
        let descriptorStats = 0;
        vi.mocked(fs.fstatSync).mockImplementation((fd, options) => {
          const stat = actualFs.fstatSync(fd, options);
          descriptorStats += 1;
          if (descriptorStats === 2) restore();
          return stat;
        });
        try {
          expect(() => safeReadFileSnapshot(file, 3)).toThrow('Snapshot ancestor changed');
          expect(leafStats).toBe(2);
          expect(descriptorStats).toBe(2);
          expect(fs.readSync).toHaveBeenCalled();
          expect(fs.closeSync).toHaveBeenCalledOnce();
          const restoredDirectory = actualFs.lstatSync(dir, { bigint: true });
          expect(restoredDirectory.ino).toBe(originalDirectory.ino);
          expect(actualFs.readFileSync(file, 'utf8')).toBe('aaa');
        } finally {
          restore();
        }
      }
    );

    snapshotIt.each(['dev', 'ino', 'mtimeNs', 'ctimeNs'] as const)(
      'rejects a changed ancestor %s even when every other sampled field is stable',
      (field) => {
        const file = path.join(tmpDir, 'snapshot-ancestor-metadata');
        fs.writeFileSync(file, 'abc');
        let samples = 0;
        vi.mocked(fs.lstatSync).mockImplementation((target, options) => {
          const stat = actualFs.lstatSync(target, options);
          if (target === tmpDir && options?.bigint) {
            samples += 1;
            if (samples === 2) {
              return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
                [field]: (stat as fs.BigIntStats)[field] + 1n,
              });
            }
          }
          return stat;
        });
        expect(() => safeReadFileSnapshot(file, 3)).toThrow('Snapshot ancestor changed');
        expect(samples).toBe(2);
        expect(fs.closeSync).toHaveBeenCalledOnce();
      }
    );

    snapshotIt('opens a raced FIFO nonblocking and rejects it before reading', () => {
      const file = path.join(tmpDir, 'snapshot-fifo-source');
      const fifo = path.join(tmpDir, 'snapshot-fifo');
      fs.writeFileSync(file, 'aaa');
      safeExec('mkfifo', [fifo]);
      // safeExec's policy load reads through safeReadFile (fd-based), which
      // closes its own descriptor; count only the snapshot's closes below.
      vi.mocked(fs.closeSync).mockClear();
      vi.mocked(fs.openSync).mockImplementationOnce((_target, flags) => {
        // Assert before the real open, so a regression cannot hang this test.
        expect(Number(flags) & fs.constants.O_NONBLOCK).not.toBe(0);
        return actualFs.openSync(fifo, flags);
      });
      expect(() => safeReadFileSnapshot(file, 3)).toThrow('changed before snapshot read');
      expect(fs.readSync).not.toHaveBeenCalled();
      expect(fs.closeSync).toHaveBeenCalledOnce();
    });

    snapshotIt.each(['rewrite', 'grow', 'truncate'] as const)(
      'rejects an in-place %s during a partial read',
      (mutation) => {
        const file = path.join(tmpDir, 'snapshot-mutation');
        fs.writeFileSync(file, 'abcdef');
        vi.mocked(fs.readSync).mockImplementationOnce((fd, buffer, offset, length, position) => {
          const read = actualFs.readSync(fd, buffer, offset, Math.min(length, 2), position);
          if (mutation === 'grow') fs.appendFileSync(file, 'extra bytes');
          else if (mutation === 'truncate') fs.truncateSync(file, 1);
          else {
            fs.writeFileSync(file, 'uvwxyz');
            fs.utimesSync(file, new Date(0), new Date(0));
          }
          return read;
        });
        expect(() => safeReadFileSnapshot(file, 6)).toThrow('changed during snapshot read');
        expect(fs.closeSync).toHaveBeenCalledOnce();
        for (const call of vi.mocked(fs.readSync).mock.calls) {
          expect(call[1].byteLength).toBeLessThanOrEqual(7);
          expect(call[2] + call[3]).toBeLessThanOrEqual(7);
        }
      }
    );

    snapshotIt('rejects early EOF instead of returning a truncated snapshot', () => {
      const file = path.join(tmpDir, 'snapshot-early-eof');
      fs.writeFileSync(file, 'abc');
      vi.mocked(fs.readSync).mockReturnValueOnce(0);
      expect(() => safeReadFileSnapshot(file, 3)).toThrow('changed during snapshot read');
      expect(fs.closeSync).toHaveBeenCalledOnce();
    });

    snapshotIt('rechecks ancestors after reading even when the leaf inode is unchanged', () => {
      const dir = path.join(tmpDir, 'snapshot-post-parent');
      const saved = path.join(tmpDir, 'snapshot-post-parent-saved');
      fs.mkdirSync(dir);
      const file = path.join(dir, 'file');
      fs.writeFileSync(file, 'abc');
      vi.mocked(fs.readSync).mockImplementationOnce((fd, buffer, offset, length, position) => {
        const read = actualFs.readSync(fd, buffer, offset, length, position);
        fs.renameSync(dir, saved);
        fs.symlinkSync(saved, dir, 'dir');
        return read;
      });
      expect(() => safeReadFileSnapshot(file, 3)).toThrow('RESOURCE_PATH_SYMLINK');
      expect(fs.closeSync).toHaveBeenCalledOnce();
    });

    snapshotIt('rechecks the final pathname against the descriptor', () => {
      const file = path.join(tmpDir, 'snapshot-post-leaf');
      const other = path.join(tmpDir, 'snapshot-replacement');
      const saved = path.join(tmpDir, 'snapshot-original');
      fs.writeFileSync(file, 'aaa');
      fs.writeFileSync(other, 'bbb');
      vi.mocked(fs.readSync).mockImplementationOnce((fd, buffer, offset, length, position) => {
        const read = actualFs.readSync(fd, buffer, offset, length, position);
        fs.renameSync(file, saved);
        fs.renameSync(other, file);
        return read;
      });
      expect(() => safeReadFileSnapshot(file, 3)).toThrow('changed during snapshot read');
      expect(fs.closeSync).toHaveBeenCalledOnce();
    });

    snapshotIt.each(['fstat', 'read'] as const)(
      'closes the descriptor after a %s error',
      (step) => {
        const file = path.join(tmpDir, 'snapshot-error');
        fs.writeFileSync(file, 'abc');
        const fail = () => {
          throw new Error('injected failure');
        };
        if (step === 'fstat') vi.mocked(fs.fstatSync).mockImplementationOnce(fail);
        else vi.mocked(fs.readSync).mockImplementationOnce(fail);
        expect(() => safeReadFileSnapshot(file, 3)).toThrow('injected failure');
        expect(fs.closeSync).toHaveBeenCalledOnce();
        const fd = vi.mocked(fs.closeSync).mock.calls[0][0];
        expect(() => actualFs.fstatSync(fd)).toThrow();
      }
    );
  });

  describe('safeRealpath', () => {
    it('resolves symlinked parent directories, including for a missing leaf', () => {
      const realDir = path.join(tmpDir, 'real');
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, 'a.txt'), 'a');
      const linkDir = path.join(tmpDir, 'link');
      fs.symlinkSync(realDir, linkDir);
      const canonicalReal = fs.realpathSync.native(realDir);
      expect(safeRealpath(path.join(linkDir, 'a.txt'))).toBe(path.join(canonicalReal, 'a.txt'));
      expect(safeRealpath(path.join(linkDir, 'new', 'b.txt'))).toBe(
        path.join(canonicalReal, 'new', 'b.txt')
      );
    });

    it('rejects a dangling or looping symlink component instead of treating it as missing', () => {
      const dangling = path.join(tmpDir, 'dangling');
      fs.symlinkSync(path.join(tmpDir, 'nowhere'), dangling);
      expect(() => safeRealpath(dangling)).toThrow('[PATH_UNRESOLVABLE]');
      expect(() => safeRealpath(path.join(dangling, 'x.txt'))).toThrow('[PATH_UNRESOLVABLE]');
      const loop = path.join(tmpDir, 'loop');
      fs.symlinkSync(loop, loop);
      expect(() => safeRealpath(path.join(loop, 'x.txt'))).toThrow('[PATH_UNRESOLVABLE]');
    });

    it('refuses paths that resolve outside the repository', () => {
      expect(() => safeRealpath(path.join(os.tmpdir(), 'x.txt'))).toThrow(
        '[PATH_OUTSIDE_REPOSITORY]'
      );
      const escape = path.join(tmpDir, 'escape');
      fs.symlinkSync(os.tmpdir(), escape);
      expect(() => safeRealpath(path.join(escape, 'x.txt'))).toThrow('[PATH_OUTSIDE_REPOSITORY]');
      expect(safeRealpath(process.cwd())).toBe(fs.realpathSync.native(process.cwd()));
    });
  });

  describe('safeReadFileTail', () => {
    it('reads the full content when the file is smaller than maxBytes', () => {
      const testFile = path.join(tmpDir, 'tail-small.txt');
      const content = 'Safe content';
      fs.writeFileSync(testFile, content);

      const result = safeReadFileTail(testFile, 1024);
      expect(result.buffer.toString('utf8')).toBe(content);
      expect(result.size).toBe(content.length);
      expect(result.truncated).toBe(false);
    });

    it('truncates to the last maxBytes of a larger file', () => {
      const testFile = path.join(tmpDir, 'tail-large.txt');
      const content = '0123456789'.repeat(1000); // 10000 bytes
      fs.writeFileSync(testFile, content);

      const result = safeReadFileTail(testFile, 2000);
      expect(result.buffer.length).toBe(2000);
      expect(result.buffer.toString('utf8')).toBe(content.slice(-2000));
      expect(result.size).toBe(10000);
      expect(result.truncated).toBe(true);
    });

    it('reports truncated=false at the exact boundary (size === maxBytes)', () => {
      const testFile = path.join(tmpDir, 'tail-exact.txt');
      const content = 'x'.repeat(500);
      fs.writeFileSync(testFile, content);

      const result = safeReadFileTail(testFile, 500);
      expect(result.buffer.toString('utf8')).toBe(content);
      expect(result.truncated).toBe(false);
    });

    it('rejects a directory', () => {
      const dirPath = path.join(tmpDir, 'a-directory');
      fs.mkdirSync(dirPath);
      expect(() => safeReadFileTail(dirPath, 1024)).toThrow('Not a regular file');
    });

    it('rejects a symbolic link', () => {
      const target = path.join(tmpDir, 'tail-target.txt');
      const link = path.join(tmpDir, 'tail-link.txt');
      fs.writeFileSync(target, 'original');
      fs.symlinkSync(target, link);

      expect(() => safeReadFileTail(link, 1024)).toThrow(
        '[SECURITY] Refusing to read symbolic link'
      );
    });

    it('rejects a path outside the repository root', () => {
      const outside = path.join(os.tmpdir(), 'kyberion-secure-io-outside-tail.txt');
      expect(() => safeReadFileTail(outside, 1024)).toThrow('[SECURITY] Read access denied');
    });

    it('rejects a missing file', () => {
      expect(() => safeReadFileTail(path.join(tmpDir, 'missing-tail.txt'), 1024)).toThrow(
        'File not found'
      );
    });

    it.each([0, -1, 1.5, NaN, Infinity, -Infinity])(
      'rejects an invalid maxBytes value: %p',
      (maxBytes) => {
        const testFile = path.join(tmpDir, 'tail-invalid.txt');
        fs.writeFileSync(testFile, 'content');
        expect(() => safeReadFileTail(testFile, maxBytes)).toThrow('Invalid maxBytes');
      }
    );

    it('never requests more than maxBytes from fs.readSync, even for a much larger file', () => {
      const testFile = path.join(tmpDir, 'tail-spy.txt');
      const content = 'y'.repeat(50_000);
      fs.writeFileSync(testFile, content);

      const readSyncMock = fs.readSync as unknown as ReturnType<typeof vi.fn>;
      readSyncMock.mockClear();

      const maxBytes = 4096;
      const result = safeReadFileTail(testFile, maxBytes);
      expect(result.truncated).toBe(true);
      expect(result.buffer.length).toBe(maxBytes);

      const relevantCalls = readSyncMock.mock.calls.filter(
        (call: unknown[]) => typeof call[3] === 'number'
      );
      expect(relevantCalls.length).toBeGreaterThan(0);
      for (const call of relevantCalls) {
        const length = call[3] as number;
        expect(length).toBeLessThanOrEqual(maxBytes);
      }
    });
  });

  describe('assertSafeRepositoryPath', () => {
    it('rejects repository paths that traverse a symbolic link', () => {
      const targetDir = path.join(tmpDir, 'target');
      const linkDir = path.join(tmpDir, 'linked');
      fs.mkdirSync(targetDir);
      fs.symlinkSync(targetDir, linkDir, 'dir');

      expect(() =>
        assertSafeRepositoryPath(path.relative(process.cwd(), path.join(linkDir, 'x.txt')), {
          allowMissingLeaf: true,
        })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    });

    it('allows an explicitly opted-in final symlink without allowing traversal through it', () => {
      const targetDir = path.join(tmpDir, 'target');
      const linkDir = path.join(tmpDir, 'linked');
      fs.mkdirSync(targetDir);
      fs.symlinkSync(targetDir, linkDir, 'dir');

      expect(
        assertSafeRepositoryPath(path.relative(process.cwd(), linkDir), {
          allowSymlinkLeaf: true,
        })
      ).toBe(linkDir);
      expect(() =>
        assertSafeRepositoryPath(path.relative(process.cwd(), path.join(linkDir, 'x.txt')), {
          allowMissingLeaf: true,
          allowSymlinkLeaf: true,
        })
      ).toThrow('[RESOURCE_PATH_SYMLINK]');
    });

    it('allows a missing leaf while keeping the path inside the repository', () => {
      const filePath = path.relative(process.cwd(), path.join(tmpDir, 'new.txt'));
      expect(assertSafeRepositoryPath(filePath, { allowMissingLeaf: true })).toBe(
        path.join(process.cwd(), filePath)
      );
      expect(() => assertSafeRepositoryPath(filePath)).toThrow('does not exist');
    });
  });

  describe('safeWriteFile', () => {
    it('create-only retains full policy-engine checks and does not replace bytes', async () => {
      const testFile = path.join(tmpDir, 'exclusive.txt');
      safeWriteFile(testFile, 'first', { createOnly: true });
      expect(() => safeWriteFile(testFile, 'second', { createOnly: true })).toThrow(/EEXIST/);
      expect(safeReadFile(testFile)).toBe('first');
      const { policyEngine } = await import('./governance/policy-engine.js');
      const spy = vi.spyOn(policyEngine, 'evaluate').mockImplementation(() => {
        throw new Error('policy file parse failure');
      });
      try {
        expect(() =>
          safeWriteFile(path.join(tmpDir, 'exclusive-denied.txt'), 'data', { createOnly: true })
        ).toThrow('Policy engine unavailable');
        expect(fs.existsSync(path.join(tmpDir, 'exclusive-denied.txt'))).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
    it('should perform atomic write and clean up temp files', () => {
      const testFile = path.join(tmpDir, 'atomic.txt');
      safeWriteFile(testFile, 'initial');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('initial');

      safeWriteFile(testFile, 'updated');
      expect(fs.readFileSync(testFile, 'utf8')).toBe('updated');

      const files = fs.readdirSync(tmpDir);
      const tempFiles = files.filter((f) => f.includes('atomic.txt.tmp'));
      expect(tempFiles.length).toBe(0);
    });

    it('applies the requested mode when the atomic temp file is created', () => {
      const testFile = path.join(tmpDir, 'private.txt');
      const previousUmask = process.umask(0);
      try {
        safeWriteFile(testFile, 'secret', { mode: 0o600 });
      } finally {
        process.umask(previousUmask);
      }
      expect(fs.statSync(testFile).mode & 0o777).toBe(0o600);
    });

    it('gates execute_command through the policy engine (ring3 read-only)', async () => {
      const savedRing = process.env.KYBERION_AGENT_RING;
      process.env.KYBERION_AGENT_RING = '3';
      try {
        expect(() => safeExec('echo', ['hello'])).toThrow('[POLICY_BLOCKED]');
        expect(() => safeExecResult('echo', ['hello'])).toThrow('[POLICY_BLOCKED]');
      } finally {
        if (savedRing === undefined) delete process.env.KYBERION_AGENT_RING;
        else process.env.KYBERION_AGENT_RING = savedRing;
      }
    });

    it('allows execute_command for unrestricted rings', () => {
      expect(safeExec('echo', ['-n', 'ok'])).toBe('ok');
    });

    it('fails closed when policy evaluation itself throws (SA-05)', async () => {
      const { policyEngine } = await import('./governance/policy-engine.js');
      const spy = vi.spyOn(policyEngine, 'evaluate').mockImplementation(() => {
        throw new Error('policy file parse failure');
      });
      try {
        const testFile = path.join(tmpDir, 'fail-closed.txt');
        expect(() => safeWriteFile(testFile, 'data')).toThrow('Policy engine unavailable');
        expect(fs.existsSync(testFile)).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });

    it('refuses to replace a symbolic link', () => {
      const target = path.join(tmpDir, 'target.txt');
      const link = path.join(tmpDir, 'link.txt');
      fs.writeFileSync(target, 'original');
      fs.symlinkSync(target, link);

      expect(() => safeWriteFile(link, 'replacement')).toThrow('Refusing to replace symbolic link');
      expect(fs.readFileSync(target, 'utf8')).toBe('original');
    });

    it('denies credential paths for writes and command execution', () => {
      expect(() => safeWriteFile(path.join(os.homedir(), '.aws/credentials'), 'token')).toThrow(
        '[SENSITIVE_PATH_DENIED]'
      );
      expect(() => safeExec('cat', ['~/.ssh/id_ed25519'])).toThrow('[SENSITIVE_PATH_DENIED]');
      expect(() => safeExecResult('cat', ['$HOME/.codex/auth.json'])).toThrow(
        '[SENSITIVE_PATH_DENIED]'
      );
    });
  });

  describe('loadJson', () => {
    it('should read and parse JSON content', () => {
      const testFile = path.join(tmpDir, 'payload.json');
      fs.writeFileSync(testFile, JSON.stringify({ hello: 'world' }));
      expect(loadJson<{ hello: string }>(testFile)).toEqual({ hello: 'world' });
    });

    it('rejects dangerous JSON keys before exposing the parsed value', () => {
      const testFile = path.join(tmpDir, 'dangerous.json');
      fs.writeFileSync(testFile, '{"__proto__":{"polluted":true}}');

      expect(() => loadJson(testFile)).toThrow('contains a dangerous JSON key');
      expect(loadJsonIfPresent(testFile)).toBeNull();
    });

    it('preserves root $schema metadata for catalog read-modify-write flows', () => {
      const testFile = path.join(tmpDir, 'catalog.json');
      fs.writeFileSync(
        testFile,
        JSON.stringify({ $schema: 'knowledge/product/schemas/catalog.schema.json', entries: [] })
      );
      const catalog = loadJson<Record<string, unknown>>(testFile);
      expect(catalog.$schema).toBe('knowledge/product/schemas/catalog.schema.json');
      expect(catalog).toEqual({
        $schema: 'knowledge/product/schemas/catalog.schema.json',
        entries: [],
      });
    });

    it('returns null for a missing or invalid optional JSON file', () => {
      const missing = path.join(tmpDir, 'missing.json');
      const invalid = path.join(tmpDir, 'invalid.json');
      fs.writeFileSync(invalid, '{not-json');

      expect(loadJsonIfPresent(missing)).toBeNull();
      expect(loadJsonIfPresent(invalid)).toBeNull();
    });

    it('parses a valid optional JSON file', () => {
      const testFile = path.join(tmpDir, 'optional.json');
      fs.writeFileSync(testFile, JSON.stringify({ enabled: true }));
      expect(loadJsonIfPresent<{ enabled: boolean }>(testFile)).toEqual({ enabled: true });
    });
  });

  describe('ensureDir', () => {
    it('should create directories recursively', () => {
      const dir = path.join(tmpDir, 'nested', 'dir');
      ensureDir(dir);
      expect(fs.existsSync(dir)).toBe(true);
    });
  });

  describe('sanitizePath', () => {
    it('should remove path traversal and leading slashes', () => {
      expect(sanitizePath('../etc/passwd')).toBe('etc/passwd');
      expect(sanitizePath('..\\windows\\system32')).toBe('windows\\system32');
      expect(sanitizePath('/absolute/path')).toBe('absolute/path');
      expect(sanitizePath('safe/path/file.txt')).toBe('safe/path/file.txt');
    });

    it('should remove null bytes', () => {
      expect(sanitizePath('file\0name.txt')).toBe('filename.txt');
    });

    it('should handle empty or null input', () => {
      expect(sanitizePath('')).toBe('');
      expect(sanitizePath(null as unknown as string)).toBe('');
    });
  });

  describe('validateUrl', () => {
    it('should accept valid HTTPS URL', () => {
      const url = 'https://example.com/api';
      expect(validateUrl(url)).toBe(url);
    });

    it('should block localhost and loopback', () => {
      expect(() => validateUrl('http://localhost:3000')).toThrow('Blocked URL');
      expect(() => validateUrl('http://127.0.0.1:8080')).toThrow('Blocked URL');
    });

    it('should block private IP ranges', () => {
      expect(() => validateUrl('http://10.0.0.1')).toThrow('Blocked URL');
      expect(() => validateUrl('http://127.0.0.1')).toThrow('Blocked URL');
      expect(() => validateUrl('http://169.254.1.10')).toThrow('Blocked URL');
      expect(() => validateUrl('http://192.168.1.1')).toThrow('Blocked URL');
      expect(() => validateUrl('http://172.16.0.1')).toThrow('Blocked URL');
    });

    it('should block private and loopback IPv6 ranges', () => {
      expect(() => validateUrl('http://[::1]')).toThrow('Blocked URL');
      expect(() => validateUrl('http://[fd00::1]')).toThrow('Blocked URL');
      expect(() => validateUrl('http://[fe80::1]')).toThrow('Blocked URL');
      expect(() => validateUrl('http://[::ffff:127.0.0.1]')).toThrow('Blocked URL');
    });

    it('should reject non-HTTP protocols', () => {
      expect(() => validateUrl('ftp://example.com')).toThrow('Unsupported protocol');
    });

    it('should reject invalid URLs', () => {
      expect(() => validateUrl('not-a-url')).toThrow('Invalid URL');
    });

    it('should throw for empty input', () => {
      expect(() => validateUrl('')).toThrow('Missing or invalid URL');
    });
  });

  describe('buildSafeExecEnv', () => {
    it('preserves Windows executable discovery variables without inheriting secrets', () => {
      vi.stubEnv('PATHEXT', '.EXE;.CMD;.BAT');
      vi.stubEnv('SystemRoot', 'C:\\Windows');
      vi.stubEnv('UNREGISTERED_TEST_SECRET', 'hidden');
      try {
        const env = buildSafeExecEnv();
        expect(env.PATHEXT).toBe('.EXE;.CMD;.BAT');
        expect(env.SystemRoot).toBe('C:\\Windows');
        expect(env.UNREGISTERED_TEST_SECRET).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('should only inherit allowlisted variables by default', () => {
      process.env.OPENAI_API_KEY = 'secret-openai-key';
      process.env.PATH = process.env.PATH || '/usr/bin';
      process.env.CUSTOM_SECRET = 'should-not-leak';

      const env = buildSafeExecEnv();

      expect(env.PATH).toBe(process.env.PATH);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CUSTOM_SECRET).toBeUndefined();
    });

    it('should allow explicit env overrides when needed', () => {
      const env = buildSafeExecEnv({ CUSTOM_SECRET: 'explicit-only', MISSION_ID: 'MSN-1' });

      expect(env.CUSTOM_SECRET).toBe('explicit-only');
      expect(env.MISSION_ID).toBe('MSN-1');
    });
  });

  describe('safeStatfs', () => {
    it('reports free and total bytes for the volume holding a path', () => {
      const result = safeStatfs(tmpDir);
      expect(result.totalBytes).toBeGreaterThan(0);
      expect(result.freeBytes).toBeGreaterThanOrEqual(0);
      expect(result.freeBytes).toBeLessThanOrEqual(result.totalBytes);
    });

    it('throws for a missing path', () => {
      expect(() => safeStatfs(path.join(tmpDir, 'missing', 'dir'))).toThrow();
    });
  });
});
