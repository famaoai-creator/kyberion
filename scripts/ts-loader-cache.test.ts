import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { transpileWithCache, tsLoaderCacheDir, tsLoaderCacheKey } from './ts-loader-cache.mjs';

// Every case runs against a sandbox: sources and cache live under a per-test
// directory in active/shared/tmp/, passed as `projectRoot` and
// KYBERION_TS_LOADER_CACHE_DIR, so the operator's cache floor is never touched.
let sandbox: string;
let cacheDir: string;
let srcFile: string;
let env: NodeJS.ProcessEnv;

function cacheEntries(): string[] {
  if (!safeExistsSync(cacheDir)) return [];
  return safeReaddir(cacheDir).flatMap((shard) =>
    safeReaddir(path.join(cacheDir, shard)).map((name) => path.join(shard, name))
  );
}

function transpile(source: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return transpileWithCache(srcFile, source, {
    env: { ...env, ...extraEnv },
    projectRoot: sandbox,
  });
}

beforeEach(() => {
  sandbox = pathResolver.sharedTmp(
    `ts-loader-cache-test/${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  cacheDir = path.join(sandbox, 'cache');
  srcFile = path.join(sandbox, 'src', 'module.ts');
  safeMkdir(path.dirname(srcFile), { recursive: true });
  env = { KYBERION_TS_LOADER_CACHE_DIR: cacheDir };
});

afterEach(() => {
  safeRmSync(sandbox, { recursive: true, force: true });
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

  it('keys on the file path, not only the content (the inline source map names the file)', () => {
    const source = 'export const x = 1;\n';
    expect(tsLoaderCacheKey('/repo/a.ts', source)).not.toBe(tsLoaderCacheKey('/repo/b.ts', source));
    expect(tsLoaderCacheKey('/repo/a.ts', source)).toBe(tsLoaderCacheKey('/repo/a.ts', source));
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

  it('defaults to the system partition of the cache floor', () => {
    expect(tsLoaderCacheDir({})).toBe(
      pathResolver.rootResolve('active/shared/cache/system/ts-loader')
    );
  });

  it('never caches sources from data trees (active/, knowledge/, customer/, vault/)', () => {
    for (const top of ['active', 'knowledge', 'customer', 'vault']) {
      const dataFile = path.join(sandbox, top, 'x.ts');
      transpileWithCache(dataFile, 'export const y = 1;\n', { env, projectRoot: sandbox });
    }
    expect(cacheEntries()).toHaveLength(0);
  });

  it('ignores a truncated or foreign entry and rewrites it', () => {
    const source = 'export const z: number = 3;\n';
    const original = transpile(source);
    const [entry] = cacheEntries();
    const entryPath = path.join(cacheDir, entry);
    safeWriteFile(entryPath, original.outputText.slice(0, 20));
    const retried = transpile(source);
    expect(retried.cacheHit).toBe(false);
    expect(retried.outputText).toBe(original.outputText);
    expect(transpile(source).cacheHit).toBe(true);
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
});
