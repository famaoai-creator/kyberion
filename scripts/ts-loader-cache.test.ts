import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
// node:fs: the cache lives outside the governed tree (os tmp / node_modules),
// which secure-io deliberately refuses; the tests plant and inspect entries there.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeReadFile, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import {
  TS_LOADER_CACHE_ENTRY_EXTENSION,
  isTrustedStat,
  pruneTsLoaderCache,
  transpileWithCache,
  tsLoaderCacheDir,
  tsLoaderCacheKey,
} from './ts-loader-cache.mjs';
import { resolvePrivateCacheDir } from '../libs/core/private-host-cache.mjs';

// Sources live in a per-test sandbox under active/shared/tmp/ (passed as
// `projectRoot`); the cache lives in a private os tmp directory, so neither the
// operator's cache nor the governed tree is touched.
let sandbox: string;
let tmpRoot: string;
let cacheDir: string;
let srcFile: string;
let env: NodeJS.ProcessEnv;

const uid = typeof process.getuid === 'function' ? process.getuid() : null;
// POSIX owner/mode semantics: Windows has no mode bits to check (platform gate, as for host binaries).
const posixOnly = it.skipIf(process.platform === 'win32');

function cacheEntries(): string[] {
  if (!fs.existsSync(cacheDir)) return [];
  return fs
    .readdirSync(cacheDir)
    .filter((shard) => !shard.startsWith('.'))
    .flatMap((shard) =>
      fs.readdirSync(path.join(cacheDir, shard)).map((name) => path.join(shard, name))
    );
}

function transpile(source: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return transpileWithCache(srcFile, source, {
    env: { ...env, ...extraEnv },
    projectRoot: sandbox,
  });
}

/** A syntactically valid entry, with the right trailer, whose code is not what the source says. */
function plantEntry(source: string, mode: number): string {
  const key = tsLoaderCacheKey(srcFile, source);
  const entry = path.join(cacheDir, key.slice(0, 2), `${key}${TS_LOADER_CACHE_ENTRY_EXTENSION}`);
  fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
  fs.writeFileSync(entry, `export const planted = true;\n//# kyberion-ts-loader-cache=${key}\n`);
  fs.chmodSync(entry, mode);
  return entry;
}

beforeEach(() => {
  sandbox = pathResolver.sharedTmp(
    `ts-loader-cache-test/${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kyberion-ts-loader-cache-test-'));
  cacheDir = path.join(tmpRoot, 'cache');
  srcFile = path.join(sandbox, 'src', 'module.ts');
  safeMkdir(path.dirname(srcFile), { recursive: true });
  env = { KYBERION_TS_LOADER_CACHE_DIR: cacheDir };
});

afterEach(() => {
  safeRmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ts-loader transpile cache', () => {
  it('misses once, then hits with byte-identical output', () => {
    const source = 'export const answer: number = 42;\n';
    const first = transpile(source);
    const second = transpile(source);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.outputText).toBe(first.outputText);
    expect(first.outputText).toContain('export const answer = 42;');
    expect(cacheEntries()).toHaveLength(1);
  });

  it('invalidates the entry when the source file changes', () => {
    safeWriteFile(srcFile, 'export const value: string = "before";\n');
    const before = transpile(String(safeReadFile(srcFile, { encoding: 'utf8' })));
    expect(transpile(String(safeReadFile(srcFile, { encoding: 'utf8' }))).cacheHit).toBe(true);

    safeWriteFile(srcFile, 'export const value: string = "after";\n');
    const after = transpile(String(safeReadFile(srcFile, { encoding: 'utf8' })));
    expect(after.cacheHit).toBe(false);
    expect(after.outputText).toContain('"after"');
    expect(after.outputText).not.toContain('"before"');
    expect(before.outputText).toContain('"before"');
    expect(cacheEntries()).toHaveLength(2);
  });

  it('stores entries under a non-code extension, invisible to repository code scanners', () => {
    transpile('export const scanned = false;\n');
    const [entry] = cacheEntries();
    expect(entry.endsWith(TS_LOADER_CACHE_ENTRY_EXTENSION)).toBe(true);
    // The boundary tests (foundation-io, process-boundary, runtime-child-process)
    // select files with this pattern.
    expect(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(entry)).toBe(false);
  });

  it('keys on the file path, not only the content (the inline source map names the file)', () => {
    const source = 'export const x = 1;\n';
    expect(tsLoaderCacheKey('/repo/a.ts', source)).not.toBe(tsLoaderCacheKey('/repo/b.ts', source));
    expect(tsLoaderCacheKey('/repo/a.ts', source)).toBe(tsLoaderCacheKey('/repo/a.ts', source));
  });

  it('keys on the loader file itself, so a compiler-option edit invalidates every entry', () => {
    // The options live in ts-loader-cache.mjs; its digest is part of the key.
    const loaderFile = pathResolver.rootResolve('scripts/ts-loader-cache.mjs');
    const loaderText = String(safeReadFile(loaderFile, { encoding: 'utf8' }));
    expect(loaderText).toContain('function compilerOptionsFor(');
    expect(loaderText).toContain('loaderDigest()');
    expect(loaderText).not.toMatch(/options:es2022/);
  });

  it('KYBERION_TS_LOADER_CACHE=0 turns the cache off: no entry is read or written', () => {
    const source = 'export const off = true;\n';
    for (const flag of ['0', 'false', 'off']) {
      expect(tsLoaderCacheDir({ ...env, KYBERION_TS_LOADER_CACHE: flag })).toBeNull();
    }
    expect(transpile(source, { KYBERION_TS_LOADER_CACHE: '0' }).cacheHit).toBe(false);
    expect(transpile(source, { KYBERION_TS_LOADER_CACHE: '0' }).cacheHit).toBe(false);
    expect(cacheEntries()).toHaveLength(0);
  });

  it('defaults to node_modules/.cache, outside every governed (agent-writable) tree', () => {
    expect(tsLoaderCacheDir({})).toBe(
      path.join(pathResolver.rootDir(), 'node_modules', '.cache', 'kyberion-ts-loader')
    );
  });

  it('refuses an override inside the checkout unless it is under node_modules/', () => {
    const root = pathResolver.rootDir();
    for (const governed of [
      'active/shared/cache/system/ts-loader',
      'active/shared/tmp/x',
      'knowledge/public/x',
      'scripts/.cache',
      '.',
      'node_modules',
    ]) {
      expect(tsLoaderCacheDir({ KYBERION_TS_LOADER_CACHE_DIR: governed })).toBeNull();
      expect(
        tsLoaderCacheDir({ KYBERION_TS_LOADER_CACHE_DIR: path.join(root, governed) })
      ).toBeNull();
    }
    expect(tsLoaderCacheDir({ KYBERION_TS_LOADER_CACHE_DIR: 'node_modules/.cache/x' })).toBe(
      path.join(root, 'node_modules/.cache/x')
    );
    expect(tsLoaderCacheDir({ KYBERION_TS_LOADER_CACHE_DIR: cacheDir })).toBe(cacheDir);
  });

  it('never caches sources from data trees (active/, knowledge/, customer/, vault/)', () => {
    for (const top of ['active', 'knowledge', 'customer', 'vault']) {
      const dataFile = path.join(sandbox, top, 'x.ts');
      transpileWithCache(dataFile, 'export const y = 1;\n', { env, projectRoot: sandbox });
    }
    expect(cacheEntries()).toHaveLength(0);
  });

  it('ignores a truncated entry, deletes it and rewrites it', () => {
    const source = 'export const z: number = 3;\n';
    const original = transpile(source);
    const [entry] = cacheEntries();
    const entryPath = path.join(cacheDir, entry);
    fs.writeFileSync(entryPath, original.outputText.slice(0, 20));
    const retried = transpile(source);
    expect(retried.cacheHit).toBe(false);
    expect(retried.outputText).toBe(original.outputText);
    expect(transpile(source).cacheHit).toBe(true);
  });

  describe('poisoning (a planted entry is never executed)', () => {
    posixOnly('rejects and deletes an entry with a group/other write bit', () => {
      const source = 'export const real: number = 1;\n';
      const entry = plantEntry(source, 0o666);
      const result = transpile(source);
      expect(result.cacheHit).toBe(false);
      expect(result.outputText).not.toContain('planted');
      expect(result.outputText).toContain('export const real = 1;');
      // Replaced by a trusted entry (0600, own uid) that now hits.
      expect(fs.statSync(entry).mode & 0o077).toBe(0);
      expect(transpile(source).cacheHit).toBe(true);
    });

    it('never executes an entry when the cache is owned by another uid', () => {
      const source = 'export const owned: number = 2;\n';
      plantEntry(source, 0o600);
      // Seen from a process running as another uid, root and entry have the wrong owner.
      const otherUid = (uid ?? 1000) + 1;
      const result = transpileWithCache(srcFile, source, {
        env,
        projectRoot: sandbox,
        expectedUid: otherUid,
      });
      expect(result.cacheHit).toBe(false);
      expect(result.outputText).not.toContain('planted');
    });

    it('trusts an entry only with the reader uid and no group/other write bit', () => {
      // The same check runs on the fstat of every entry before it is read.
      expect(isTrustedStat({ uid: 501, mode: 0o100600 }, 501)).toBe(true);
      expect(isTrustedStat({ uid: 501, mode: 0o100644 }, 501)).toBe(true);
      expect(isTrustedStat({ uid: 502, mode: 0o100600 }, 501)).toBe(false);
      if (process.platform !== 'win32') {
        expect(isTrustedStat({ uid: 501, mode: 0o100620 }, 501)).toBe(false);
        expect(isTrustedStat({ uid: 501, mode: 0o100602 }, 501)).toBe(false);
      }
      // No uid concept (Windows): ownership is not checked.
      expect(isTrustedStat({ uid: 0, mode: 0o100600 }, null)).toBe(true);
    });

    posixOnly('does not follow a symlinked entry', () => {
      const source = 'export const linked: number = 3;\n';
      const outside = path.join(tmpRoot, 'outside.js');
      fs.writeFileSync(outside, 'export const planted = true;\n', { mode: 0o600 });
      const key = tsLoaderCacheKey(srcFile, source);
      const entry = path.join(
        cacheDir,
        key.slice(0, 2),
        `${key}${TS_LOADER_CACHE_ENTRY_EXTENSION}`
      );
      fs.mkdirSync(path.dirname(entry), { recursive: true, mode: 0o700 });
      fs.symlinkSync(outside, entry);
      const result = transpile(source);
      expect(result.cacheHit).toBe(false);
      expect(result.outputText).not.toContain('planted');
    });

    posixOnly('turns the cache off when the cache root is group/other writable', () => {
      fs.mkdirSync(cacheDir, { mode: 0o700 });
      fs.chmodSync(cacheDir, 0o777);
      const source = 'export const open: number = 4;\n';
      plantEntry(source, 0o600);
      const result = transpile(source);
      expect(result.cacheHit).toBe(false);
      expect(result.outputText).not.toContain('planted');
    });

    posixOnly('creates directories 0700 and entries 0600', () => {
      transpile('export const modes = true;\n');
      const [entry] = cacheEntries();
      expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(cacheDir, path.dirname(entry))).mode & 0o777).toBe(0o700);
      expect(fs.statSync(path.join(cacheDir, entry)).mode & 0o777).toBe(0o600);
    });
  });

  it('prunes entries written longer ago than the maximum age, at most once a day', () => {
    transpile('export const fresh = 1;\n');
    transpile('export const stale = 2;\n');
    const [first] = cacheEntries();
    const old = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(path.join(cacheDir, first), old, old);
    expect(pruneTsLoaderCache(cacheDir, { force: true })).toBe(1);
    expect(cacheEntries()).toHaveLength(1);
    // The marker defers the next sweep.
    fs.utimesSync(path.join(cacheDir, cacheEntries()[0]), old, old);
    expect(pruneTsLoaderCache(cacheDir)).toBe(0);
  });

  it('matches the uncached output for a real repository module (differential)', () => {
    const real = pathResolver.rootResolve('scripts/lib/harness.ts');
    const source = String(safeReadFile(real, { encoding: 'utf8' }));
    const projectRoot = pathResolver.rootDir();
    const uncached = transpileWithCache(real, source, {
      env: { KYBERION_TS_LOADER_CACHE: '0' },
      projectRoot,
    });
    const miss = transpileWithCache(real, source, { env, projectRoot });
    const hit = transpileWithCache(real, source, { env, projectRoot });
    expect(miss.cacheHit).toBe(false);
    expect(hit.cacheHit).toBe(true);
    expect(miss.outputText).toBe(uncached.outputText);
    expect(hit.outputText).toBe(uncached.outputText);
  });

  it('stays consistent when several processes fill the same entry at once', async () => {
    const source = 'export const shared: string = "concurrent";\n';
    const loaderCache = pathResolver.rootResolve('scripts/ts-loader-cache.mjs');
    const script = `
      const { transpileWithCache } = await import(${JSON.stringify(loaderCache)});
      const r = transpileWithCache(${JSON.stringify(srcFile)}, ${JSON.stringify(source)}, {
        env: { KYBERION_TS_LOADER_CACHE_DIR: ${JSON.stringify(cacheDir)} },
        projectRoot: ${JSON.stringify(sandbox)},
      });
      process.stdout.write(JSON.stringify(r));
    `;
    const runs = await Promise.all(
      Array.from(
        { length: 6 },
        () =>
          new Promise<{ outputText: string }>((resolve, reject) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            let err = '';
            const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
            child.stdout.on('data', (chunk) => (out += chunk));
            child.stderr.on('data', (chunk) => (err += chunk));
            child.on('error', reject);
            child.on('exit', (code) => {
              clearTimeout(timer);
              if (code === 0) resolve(JSON.parse(out));
              else reject(new Error(`child exited ${code}: ${err}`));
            });
          })
      )
    );
    const expected = transpile(source, { KYBERION_TS_LOADER_CACHE: '0' }).outputText;
    for (const run of runs) expect(run.outputText).toBe(expected);
    // Exactly one complete entry, no temp files left behind, and it is a valid hit.
    expect(cacheEntries().filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(cacheEntries()).toHaveLength(1);
    const hit = transpile(source);
    expect(hit.cacheHit).toBe(true);
    expect(hit.outputText).toBe(expected);
  }, 60_000);

  describe('private host cache location (shared with the STT discovery cache)', () => {
    it('decides containment on the realpath, so a workspace link under node_modules cannot escape', () => {
      // pnpm links workspace packages: node_modules/@ws/pkg -> ../../libs/pkg (source tree).
      const project = path.join(tmpRoot, 'project');
      fs.mkdirSync(path.join(project, 'libs', 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(project, 'node_modules', '@ws'), { recursive: true });
      fs.symlinkSync(
        path.join(project, 'libs', 'pkg'),
        path.join(project, 'node_modules', '@ws', 'pkg'),
        'dir'
      );
      const viaLink = path.join(project, 'node_modules', '@ws', 'pkg', 'cache');
      expect(
        resolvePrivateCacheDir({ projectRoot: project, name: 'x', override: viaLink })
      ).toBeNull();
      expect(tsLoaderCacheDir({ KYBERION_TS_LOADER_CACHE_DIR: viaLink }, project)).toBeNull();
      const real = path.join(project, 'node_modules', '.cache', 'x');
      expect(resolvePrivateCacheDir({ projectRoot: project, name: 'x', override: real })).toBe(
        real
      );
      expect(resolvePrivateCacheDir({ projectRoot: project, name: 'x' })).toBe(real);
    });

    it('is off on Windows unless KYBERION_WINDOWS_PRIVATE_CACHE=1 (no uid or mode bits to check)', () => {
      const project = path.join(tmpRoot, 'project');
      fs.mkdirSync(project, { recursive: true });
      expect(
        resolvePrivateCacheDir({ projectRoot: project, name: 'x', env: {}, platform: 'win32' })
      ).toBeNull();
      expect(
        resolvePrivateCacheDir({
          projectRoot: project,
          name: 'x',
          env: { KYBERION_WINDOWS_PRIVATE_CACHE: '1' },
          platform: 'win32',
        })
      ).toBe(path.join(project, 'node_modules', '.cache', 'x'));
      expect(
        resolvePrivateCacheDir({ projectRoot: project, name: 'x', env: {}, platform: 'linux' })
      ).toBe(path.join(project, 'node_modules', '.cache', 'x'));
    });
  });
});
