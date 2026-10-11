import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { findSourceShadows } from '../scripts/check_source_shadows.js';
import { runClean } from '../scripts/clean.js';
import {
  OWNED_BUILD_DIRECTORIES,
  OWNED_BUILD_METADATA,
  PACKAGE_BUILD_OUTPUTS,
} from '../scripts/build-output-layout.js';

const root = pathResolver.sharedTmp('build-output-ownership-test');
function write(file: string, contents = 'fixture\n'): void {
  const target = path.join(root, file);
  safeMkdir(path.dirname(target), { recursive: true });
  safeWriteFile(target, contents);
}
function readJson(file: string) {
  return JSON.parse(safeReadFile(pathResolver.rootResolve(file), { encoding: 'utf8' }) as string);
}
afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('single-owner build contract', () => {
  it('keeps language options separate from emission ownership', () => {
    const options = readJson('tsconfig.base.json').compilerOptions;
    for (const key of [
      'outDir',
      'rootDir',
      'tsBuildInfoFile',
      'incremental',
      'composite',
      'paths',
    ]) {
      expect(options).not.toHaveProperty(key);
    }
    for (const { id } of PACKAGE_BUILD_OUTPUTS) {
      const config = readJson(id + '/tsconfig.json');
      expect(config.compilerOptions.outDir).toMatch(/^\.?\/?dist$/);
      expect(config.compilerOptions.tsBuildInfoFile).toBe('./dist/.tsbuildinfo');
      expect(config.compilerOptions.composite).toBe(true);
      expect(readJson(id + '/package.json').scripts.build).toContain(
        'write_core_dist_scope.mjs --run'
      );
    }
  });

  it('uses one dependency graph for package and runtime entrypoints', () => {
    const packages = readJson('tsconfig.packages.json');
    const runtime = readJson('tsconfig.json');
    expect(runtime.references).toEqual(packages.references);
    expect(runtime.compilerOptions.paths).not.toHaveProperty('@agent/core');
    expect(Object.keys(runtime.compilerOptions.paths)).toEqual([
      '@actuator/service',
      '@actuator/system',
      '@actuator/meeting-browser-driver',
    ]);
    expect(readJson('tsconfig.actuators.json')).toEqual({
      files: [],
      references: [{ path: './tsconfig.json' }],
    });
    expect(readJson('package.json').scripts['build:actuators']).toBe('pnpm run build:repo');
    for (const name of ['media', 'nerve', 'network', 'vision']) {
      const pkg = readJson('libs/shared-' + name + '/package.json');
      expect(pkg.main).toBe('./dist/index.js');
      expect(pkg.types).toBe('./dist/index.d.ts');
    }
  });

  it('removes obsolete owned emits and incremental records without traversing other trees', () => {
    for (const directory of OWNED_BUILD_DIRECTORIES) write(directory + '/obsolete.js');
    for (const file of OWNED_BUILD_METADATA) write(file);
    const keep = [
      '.worktrees/other/dist/keep.js',
      'libs/user-owned/dist/keep.js',
      'active/shared/tmp/user.tsbuildinfo',
      'libs/core/handwritten.js',
      'coverage/user-note.txt',
    ];
    for (const file of keep) write(file);
    runClean(root);
    for (const directory of OWNED_BUILD_DIRECTORIES)
      expect(safeExistsSync(path.join(root, directory))).toBe(false);
    for (const file of OWNED_BUILD_METADATA)
      expect(safeExistsSync(path.join(root, file))).toBe(false);
    for (const file of keep) expect(safeExistsSync(path.join(root, file))).toBe(true);
  });

  it('finds physical ignored and untracked shadows including declaration maps', () => {
    write('.gitignore', 'libs/core/**/*.js\nlibs/core/**/*.map\n');
    write('libs/core/demo.ts', 'export const value = 1;\n');
    for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) write('libs/core/demo' + suffix);
    expect(findSourceShadows(root)).toEqual([
      'libs/core/demo.d.ts',
      'libs/core/demo.d.ts.map',
      'libs/core/demo.js',
      'libs/core/demo.js.map',
    ]);
  });

  it('preserves generated TypeScript and handwritten declaration/JavaScript inputs', () => {
    write('libs/core/types.generated.ts');
    write('libs/core/handwritten.js');
    write('libs/core/ambient.d.ts');
    write('libs/core/validators.ts');
    write('libs/core/validators.d.cts');
    write('libs/core/dist/generated.js');
    write('libs/core/dist/generated.ts');
    expect(findSourceShadows(root)).toEqual([]);
  });
});
