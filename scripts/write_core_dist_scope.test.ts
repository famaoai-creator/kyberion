import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { buildDistScope, findDistScopeDrift, writeDistScope } from './write_core_dist_scope.mjs';

const realCorePackage = JSON.parse(
  String(safeReadFile(pathResolver.rootResolve('libs/core/package.json'), { encoding: 'utf8' }))
) as { imports?: Record<string, string>; scripts?: Record<string, string> };

let coreDir: string;

/** A miniature @agent/core: a large exports map, one `#imports` entry, and a dist module using it. */
function writeFixture(): void {
  const exportsMap: Record<string, unknown> = {};
  for (let i = 0; i < 200; i += 1) exportsMap[`./m${i}`] = { default: `./dist/m${i}.js` };
  safeMkdir(path.join(coreDir, 'dist'), { recursive: true });
  safeWriteFile(
    path.join(coreDir, 'package.json'),
    JSON.stringify({
      name: '@fixture/core',
      type: 'module',
      imports: { '#boundary': './boundary.mjs' },
      exports: exportsMap,
    })
  );
  safeWriteFile(
    path.join(coreDir, 'boundary.mjs'),
    "export const marker = 'boundary-ok';\nexport default 'boundary-default';\n"
  );
  safeWriteFile(
    path.join(coreDir, 'dist', 'entry.js'),
    "export { marker } from '#boundary';\nexport { default as fallback } from '#boundary';\n"
  );
}

/** Import dist/entry.js in a fresh process; report the export and the package scope Node used. */
function runEntry(): {
  marker?: string;
  fallback?: string;
  scope?: string;
  status: number | null;
  stderr: string;
} {
  const entry = path.join(coreDir, 'dist', 'entry.js');
  const script = `
    import { findPackageJSON } from 'node:module';
    import { pathToFileURL } from 'node:url';
    const url = pathToFileURL(${JSON.stringify(entry)}).href;
    const mod = await import(url);
    process.stdout.write(
      JSON.stringify({ marker: mod.marker, fallback: mod.fallback, scope: findPackageJSON(url) })
    );
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  const parsed = result.status === 0 ? JSON.parse(result.stdout) : {};
  return { ...parsed, status: result.status, stderr: result.stderr };
}

beforeEach(() => {
  coreDir = pathResolver.sharedTmp(
    `core-dist-scope-test/${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  writeFixture();
});

afterEach(() => {
  safeRmSync(coreDir, { recursive: true, force: true });
});

describe('core dist package scope', () => {
  it('gives dist/ its own small scope and keeps #imports resolving to the one real module', () => {
    writeDistScope({ coreDir, env: {} });
    const manifest = JSON.parse(
      String(safeReadFile(path.join(coreDir, 'dist', 'package.json'), { encoding: 'utf8' }))
    );
    expect(manifest.type).toBe('module');
    expect(manifest.imports).toEqual({ '#boundary': './boundary.mjs' });
    expect(manifest.exports).toBeUndefined();
    expect(manifest.name).toBeUndefined();

    const run = runEntry();
    expect(run.stderr).toBe('');
    expect(run.marker).toBe('boundary-ok');
    // `export *` does not forward a default export; the shim adds it (review L1).
    expect(run.fallback).toBe('boundary-default');
    expect(run.scope).toBe(path.join(coreDir, 'dist', 'package.json'));
  });

  it('KYBERION_CORE_DIST_SCOPE=0 removes the marker and falls back to the package root (differential)', () => {
    writeDistScope({ coreDir, env: {} });
    const on = runEntry();
    writeDistScope({ coreDir, env: { KYBERION_CORE_DIST_SCOPE: '0' } });
    expect(safeExistsSync(path.join(coreDir, 'dist', 'package.json'))).toBe(false);
    expect(safeExistsSync(path.join(coreDir, 'dist', 'boundary.mjs'))).toBe(false);
    const off = runEntry();
    expect(off.status).toBe(0);
    expect(off.scope).toBe(path.join(coreDir, 'package.json'));
    // Same module, same export, whichever scope resolved it.
    expect(off.marker).toBe(on.marker);
  });

  it('a dist scope without "imports" breaks #imports (the failure the shims prevent)', () => {
    safeWriteFile(path.join(coreDir, 'dist', 'package.json'), JSON.stringify({ type: 'module' }));
    const run = runEntry();
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/ERR_PACKAGE_IMPORT_NOT_DEFINED|#boundary/);
  });

  it('rejects an #imports target it cannot shim inside dist/', () => {
    expect(() => buildDistScope({ imports: { '#x': '../outside.mjs' } })).toThrow(
      /CORE_DIST_SCOPE_UNSUPPORTED_IMPORT/
    );
    expect(() => buildDistScope({ imports: { '#x': { node: './a.mjs' } } })).toThrow(
      /CORE_DIST_SCOPE_UNSUPPORTED_IMPORT/
    );
  });

  it('covers every #imports entry of the real libs/core package and runs in its build', () => {
    const { manifest, shims } = buildDistScope(realCorePackage);
    expect(Object.keys(manifest.imports).sort()).toEqual(
      Object.keys(realCorePackage.imports ?? {}).sort()
    );
    for (const shim of shims) {
      expect(safeExistsSync(pathResolver.rootResolve(path.join('libs/core', shim.file)))).toBe(
        true
      );
    }
    expect(realCorePackage.scripts?.build).toContain('scripts/write_core_dist_scope.mjs');
  });

  it('runs from a symlinked checkout (no argv[1] path comparison) and only on a direct run', () => {
    // Real checkout: <tmp>/real/{scripts,libs/core}; the build runs it through <tmp>/link.
    const tmp = path.dirname(coreDir);
    const real = path.join(tmp, `real-${path.basename(coreDir)}`);
    const link = path.join(tmp, `link-${path.basename(coreDir)}`);
    safeMkdir(path.join(real, 'scripts'), { recursive: true });
    safeMkdir(path.join(real, 'libs'), { recursive: true });
    safeWriteFile(
      path.join(real, 'scripts', 'write_core_dist_scope.mjs'),
      String(
        safeReadFile(pathResolver.rootResolve('scripts/write_core_dist_scope.mjs'), {
          encoding: 'utf8',
        })
      )
    );
    try {
      safeSymlinkSync(coreDir, path.join(real, 'libs', 'core'));
      safeSymlinkSync(real, link);
      const run = spawnSync(
        process.execPath,
        [path.join(link, 'scripts', 'write_core_dist_scope.mjs'), '--run'],
        { encoding: 'utf8', timeout: 30_000, cwd: path.join(link, 'libs', 'core') }
      );
      expect(run.stderr).toBe('');
      expect(run.status).toBe(0);
      expect(safeExistsSync(path.join(coreDir, 'dist', 'package.json'))).toBe(true);
      expect(findDistScopeDrift({ coreDir, env: {} })).toEqual([]);
    } finally {
      safeRmSync(link, { force: true });
      safeRmSync(real, { recursive: true, force: true });
    }
  });

  it('reports drift when the dist scope no longer matches libs/core/package.json', () => {
    // No dist scope written yet: the manifest is missing.
    expect(findDistScopeDrift({ coreDir, env: {} }).join('\n')).toMatch(/missing/);
    writeDistScope({ coreDir, env: {} });
    expect(findDistScopeDrift({ coreDir, env: {} })).toEqual([]);

    // An #imports change without a rebuild.
    const pkgPath = path.join(coreDir, 'package.json');
    const pkg = JSON.parse(String(safeReadFile(pkgPath, { encoding: 'utf8' })));
    pkg.imports['#extra'] = './extra.mjs';
    safeWriteFile(pkgPath, JSON.stringify(pkg));
    safeWriteFile(path.join(coreDir, 'extra.mjs'), 'export const extra = 1;\n');
    const drift = findDistScopeDrift({ coreDir, env: {} });
    expect(drift.some((line) => line.includes('imports'))).toBe(true);
    expect(drift.some((line) => line.includes('dist/extra.mjs is missing'))).toBe(true);

    // The CLI form the packaging-contract gate runs exits 1 on drift.
    writeDistScope({ coreDir, env: {} });
    safeWriteFile(path.join(coreDir, 'dist', 'boundary.mjs'), 'export {};\n');
    expect(findDistScopeDrift({ coreDir, env: {} })).toEqual([
      expect.stringContaining('dist/boundary.mjs is stale'),
    ]);

    // No dist/ at all: nothing to check (the loader falls back to sources).
    safeRmSync(path.join(coreDir, 'dist'), { recursive: true, force: true });
    expect(findDistScopeDrift({ coreDir, env: {} })).toEqual([]);
  });

  it('every real shim exposes exactly the namespace of its target module', () => {
    const coreRoot = pathResolver.rootResolve('libs/core');
    const { shims } = buildDistScope(realCorePackage, (file: string) =>
      String(safeReadFile(path.join(coreRoot, file), { encoding: 'utf8' }))
    );
    expect(shims.length).toBeGreaterThan(0);
    const shimDir = path.join(coreDir, 'shim-check', 'dist');
    safeMkdir(shimDir, { recursive: true });
    // Same relative layout as libs/core/dist: '../<file>' must reach the target.
    for (const shim of shims) {
      safeWriteFile(
        path.join(shimDir, shim.file),
        shim.body.replaceAll(`'../${shim.file}'`, JSON.stringify(path.join(coreRoot, shim.file)))
      );
    }
    const script = `
      const out = {};
      for (const file of ${JSON.stringify(shims.map((shim) => shim.file))}) {
        const shim = await import(${JSON.stringify(shimDir)} + '/' + file);
        const target = await import(${JSON.stringify(coreRoot)} + '/' + file);
        out[file] = { shim: Object.keys(shim).sort(), target: Object.keys(target).sort() };
      }
      process.stdout.write(JSON.stringify(out));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.stderr).toBe('');
    const namespaces = JSON.parse(result.stdout) as Record<
      string,
      { shim: string[]; target: string[] }
    >;
    for (const [file, keys] of Object.entries(namespaces)) {
      expect(keys.shim, file).toEqual(keys.target);
    }
  });
});
