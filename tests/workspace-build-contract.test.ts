import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeReadFile } from '@agent/core/secure-io';

const rootDir = process.cwd();

function collectExportTargets(exportsField: any): string[] {
  const targets: string[] = [];
  if (!exportsField || typeof exportsField !== 'object') return targets;

  for (const value of Object.values(exportsField)) {
    if (typeof value === 'string') {
      targets.push(value);
      continue;
    }
    if (value && typeof value === 'object') {
      for (const nested of Object.values(value)) {
        if (typeof nested === 'string') {
          targets.push(nested);
        }
      }
    }
  }
  return targets;
}

describe('Workspace build contract', () => {
  it('keeps CI-built workspace package entrypoints aligned with built output files', () => {
    const packageFiles = [
      'libs/core/package.json',
      'libs/shared-voice/package.json',
      'libs/shared-mobile/package.json',
    ];

    const missing: string[] = [];

    for (const relPkg of packageFiles) {
      const absPkg = path.join(rootDir, relPkg);
      const pkgDir = path.dirname(absPkg);
      const pkg = JSON.parse(safeReadFile(absPkg, { encoding: 'utf8' }) as string);
      const targets = [pkg.main, pkg.types, ...collectExportTargets(pkg.exports)].filter(
        (value: unknown): value is string => typeof value === 'string'
      );

      for (const target of targets) {
        const resolved = path.resolve(pkgDir, target);
        if (!safeExistsSync(resolved)) {
          missing.push(`${relPkg} -> ${target}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('keeps mobile runtime helpers in shared-mobile without closing legacy deep imports', () => {
    const core = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/core/package.json'), { encoding: 'utf8' }) as string
    );
    const mobile = JSON.parse(
      safeReadFile(path.join(rootDir, 'libs/shared-mobile/package.json'), {
        encoding: 'utf8',
      }) as string
    );
    expect(core.exports['./mobile-runtime-helpers']).toBeUndefined();
    expect(core.exports['./mobile-profile-validators']).toBeDefined();
    expect(core.exports['./types']).toBeDefined();
    expect(core.exports['./secure-io']).toBeDefined();
    expect(mobile.exports).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/mobile-runtime-helpers.ts'))).toBe(false);
    for (const filename of ['mobile-runtime-helpers.js', 'mobile-runtime-helpers.d.ts']) {
      expect(safeExistsSync(path.join(rootDir, 'libs/shared-mobile/dist', filename))).toBe(true);
    }
  });

  it('keeps two-stage barge-in in shared-voice and the shared energy detector in core', () => {
    const readPackage = (directory: string) =>
      JSON.parse(
        safeReadFile(path.join(rootDir, directory, 'package.json'), { encoding: 'utf8' }) as string
      ) as { exports: Record<string, { types: string; default: string }> };
    const core = readPackage('libs/core');
    const voice = readPackage('libs/shared-voice');

    expect(core.exports['./two-stage-barge-in']).toBeUndefined();
    expect(safeExistsSync(path.join(rootDir, 'libs/core/two-stage-barge-in.ts'))).toBe(false);
    expect(voice.exports['./two-stage-barge-in']).toEqual({
      types: './dist/two-stage-barge-in.d.ts',
      default: './dist/two-stage-barge-in.js',
    });
    // Meeting and voice both use the energy detector, so it must not move
    // into a package that would make core depend on shared-voice.
    expect(core.exports['./barge-in-controller']).toEqual({
      types: './dist/barge-in-controller.d.ts',
      default: './dist/barge-in-controller.js',
    });
  });
});
