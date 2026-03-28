import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const guardMocks = vi.hoisted(() => ({
  validateWritePermission: vi.fn(() => ({ allowed: true, reason: '' })),
  validateReadPermission: vi.fn(() => ({ allowed: true, reason: '' })),
}));

vi.mock('./tier-guard.js', () => ({
  validateWritePermission: guardMocks.validateWritePermission,
  validateReadPermission: guardMocks.validateReadPermission,
}));

vi.mock('./path-resolver.js', () => ({
  resolve: (p: string) => p,
}));

describe('secure-io branch coverage', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secure-io-branch-'));
    guardMocks.validateWritePermission.mockReset();
    guardMocks.validateReadPermission.mockReset();
    guardMocks.validateWritePermission.mockReturnValue({ allowed: true, reason: '' });
    guardMocks.validateReadPermission.mockReturnValue({ allowed: true, reason: '' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('covers file io wrappers and guard-denied branches', async () => {
    const io = await import('./secure-io.js');
    const file = path.join(tmpDir, 'a.txt');
    const dir = path.join(tmpDir, 'd');
    const moved = path.join(tmpDir, 'moved.txt');
    const copied = path.join(tmpDir, 'copied.txt');
    const link = path.join(tmpDir, 'link.txt');
    const appendFile = path.join(tmpDir, 'append.log');
    const deepWrite = path.join(tmpDir, 'new-dir', 'deep.txt');
    const symlinkInMissingDir = path.join(tmpDir, 'missing', 'nested', 'a.link');
    const appendInMissingDir = path.join(tmpDir, 'missing-append', 'x.log');
    const sub = path.join(tmpDir, 'sub');

    io.safeWriteFile(file, 'hello');
    io.safeWriteFile(deepWrite, 'deep');
    expect(io.safeExistsSync(deepWrite)).toBe(true);
    expect(io.safeReadFile(file)).toBe('hello');
    expect(Buffer.isBuffer(io.safeReadFile(file, { encoding: null }))).toBe(true);
    expect(io.safeExistsSync(file)).toBe(true);
    expect(io.safeExistsSync('')).toBe(false);

    io.safeAppendFileSync(file, '\nworld');
    expect(String(io.safeReadFile(file))).toContain('world');

    io.safeCopyFileSync(file, copied);
    expect(io.safeExistsSync(copied)).toBe(true);

    io.safeMoveSync(copied, moved);
    expect(io.safeExistsSync(moved)).toBe(true);
    expect(io.safeExistsSync(copied)).toBe(false);

    io.safeMkdir(sub);
    io.safeSymlinkSync(file, link);
    io.safeSymlinkSync(file, symlinkInMissingDir);
    expect(io.safeExistsSync(path.dirname(symlinkInMissingDir))).toBe(true);
    expect(io.safeReadlink(link).length).toBeGreaterThan(0);
    expect(io.safeLstat(link).isSymbolicLink()).toBe(true);
    expect(io.safeStat(file).isFile()).toBe(true);
    expect(io.safeReaddir(tmpDir).length).toBeGreaterThan(0);

    const fd = io.safeOpenAppendFile(appendFile);
    fs.closeSync(fd);
    const fd2 = io.safeOpenAppendFile(appendInMissingDir);
    fs.closeSync(fd2);
    expect(io.safeExistsSync(path.dirname(appendInMissingDir))).toBe(true);
    io.safeFsyncFile(file);

    io.safeUnlinkSync(moved);
    expect(io.safeExistsSync(moved)).toBe(false);
    io.safeUnlinkSync(path.join(tmpDir, 'missing-unlink.txt'));

    io.safeRmSync(path.join(tmpDir, 'missing-rm'));
    io.safeRmSync(sub);
    expect(io.safeExistsSync(sub)).toBe(false);

    const artifactPath = path.join(tmpDir, 'artifact.bin');
    const artifact = io.writeArtifact(artifactPath, Buffer.from('abc'), 'bin');
    expect(artifact.path).toBe(artifactPath);
    expect(artifact.size_bytes).toBe(3);
    expect(artifact.hash.length).toBe(64);

    expect(io.validateUrl('https://example.com')).toBe('https://example.com');
    expect(() => io.validateUrl('ftp://example.com')).toThrow('Unsupported protocol');
    expect(() => io.validateUrl('http://127.0.0.1')).toThrow('Blocked URL');
    expect(() => io.validateUrl('not-url')).toThrow('Invalid URL');
    expect(io.sanitizePath('../a/../b')).toBe('a/b');
    expect(io.sanitizePath(null as any)).toBe('');

    const out = io.safeExec(process.execPath, ['-e', 'process.stdout.write("OK")']);
    expect(out).toBe('OK');
  });

  it('covers read/write denial errors', async () => {
    const io = await import('./secure-io.js');
    const file = path.join(tmpDir, 'denied.txt');
    fs.writeFileSync(file, 'x');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: false, reason: 'read denied' });
    expect(() => io.safeReadFile(file)).toThrow('[SECURITY] Read access denied');

    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'write denied' });
    expect(() => io.safeWriteFile(file, 'y')).toThrow('write denied');
  });

  it('covers read/copy/move/symlink/listing guard failures', async () => {
    const io = await import('./secure-io.js');
    const src = path.join(tmpDir, 'src.txt');
    const dst = path.join(tmpDir, 'dst.txt');
    const link = path.join(tmpDir, 'x', 'link.txt');
    fs.writeFileSync(src, 'x');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: false, reason: 'rd' });
    expect(() => io.safeCopyFileSync(src, dst)).toThrow('[SECURITY] Read access denied');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: true, reason: '' });
    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'wr' });
    expect(() => io.safeCopyFileSync(src, dst)).toThrow('wr');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: false, reason: 'rd2' });
    expect(() => io.safeMoveSync(src, dst)).toThrow('[SECURITY] Read access denied');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: true, reason: '' });
    guardMocks.validateWritePermission
      .mockReturnValueOnce({ allowed: false, reason: 'src-no-write' })
      .mockReturnValueOnce({ allowed: true, reason: '' });
    expect(() => io.safeMoveSync(src, dst)).toThrow('src-no-write');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: true, reason: '' });
    guardMocks.validateWritePermission.mockReset();
    guardMocks.validateWritePermission
      .mockReturnValueOnce({ allowed: true, reason: '' })
      .mockReturnValueOnce({ allowed: false, reason: 'dst-no-write' });
    expect(() => io.safeMoveSync(src, dst)).toThrow('dst-no-write');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: false, reason: 'target' });
    expect(() => io.safeSymlinkSync(src, link)).toThrow('[SECURITY] Read access denied');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: true, reason: '' });
    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'link' });
    expect(() => io.safeSymlinkSync(src, link)).toThrow('link');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: false, reason: 'readdir' });
    expect(() => io.safeReaddir(tmpDir)).toThrow('[ROLE_VIOLATION]');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: false, reason: 'stat' });
    expect(() => io.safeStat(src)).toThrow('[ROLE_VIOLATION]');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: false, reason: 'lstat' });
    expect(() => io.safeLstat(src)).toThrow('[ROLE_VIOLATION]');

    guardMocks.validateReadPermission.mockReturnValueOnce({ allowed: false, reason: 'readlink' });
    expect(() => io.safeReadlink(src)).toThrow('[ROLE_VIOLATION]');
  });

  it('covers safeWriteFile error cleanup branches', async () => {
    const io = await import('./secure-io.js');
    const file = path.join(tmpDir, 'cleanup.txt');

    expect(() => io.safeWriteFile(file, { bad: true } as any)).toThrow();
    const leftovers = fs.readdirSync(tmpDir).filter((entry) => entry.includes('cleanup.txt.tmp.'));
    expect(leftovers).toHaveLength(0);

    expect(() => io.safeWriteFile(path.join(tmpDir, 'no-mkdir', 'x.txt'), 'x', { mkdir: false })).toThrow();
  });

  it('covers role-violation branches when reason is empty', async () => {
    const io = await import('./secure-io.js');
    const file = path.join(tmpDir, 'plain.txt');
    fs.writeFileSync(file, 'x');

    guardMocks.validateReadPermission.mockReturnValue({ allowed: false, reason: '' });
    expect(() => io.safeReaddir(tmpDir)).toThrow('[ROLE_VIOLATION]');
    expect(() => io.safeStat(file)).toThrow('[ROLE_VIOLATION]');
    expect(() => io.safeLstat(file)).toThrow('[ROLE_VIOLATION]');
    expect(() => io.safeReadlink(file)).toThrow('[ROLE_VIOLATION]');
  });

  it('covers write-guard denial branches for unlink/mkdir/open-append/fsync', async () => {
    const io = await import('./secure-io.js');
    const file = path.join(tmpDir, 'guard.txt');
    fs.writeFileSync(file, 'x');

    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'no-unlink' });
    expect(() => io.safeUnlinkSync(file)).toThrow('no-unlink');

    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'no-mkdir' });
    expect(() => io.safeMkdir(path.join(tmpDir, 'denied-dir'))).toThrow('no-mkdir');

    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'no-append' });
    expect(() => io.safeOpenAppendFile(path.join(tmpDir, 'denied', 'a.log'))).toThrow('no-append');

    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'no-fsync' });
    expect(() => io.safeFsyncFile(file)).toThrow('no-fsync');

    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'no-append-sync' });
    expect(() => io.safeAppendFileSync(file, 'x')).toThrow('no-append-sync');

    guardMocks.validateWritePermission.mockReturnValueOnce({ allowed: false, reason: 'no-rm' });
    expect(() => io.safeRmSync(file)).toThrow('no-rm');
  });

  it('covers buildSafeExecEnv fallback/default branches and existing mkdir branch', async () => {
    const io = await import('./secure-io.js');
    const prevTerm = process.env.TERM;
    delete process.env.TERM;
    const env = io.buildSafeExecEnv({ OPTIONAL_EMPTY: undefined, EXPLICIT: 'ok' } as any);
    expect(env.TERM).toBe('dumb');
    expect(env.EXPLICIT).toBe('ok');
    expect(env.OPTIONAL_EMPTY).toBeUndefined();
    if (prevTerm === undefined) {
      delete process.env.TERM;
    } else {
      process.env.TERM = prevTerm;
    }

    const existingDir = path.join(tmpDir, 'exists');
    fs.mkdirSync(existingDir, { recursive: true });
    io.safeMkdir(existingDir);
    expect(fs.existsSync(existingDir)).toBe(true);
  });
});
