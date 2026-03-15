import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeExistsSync, safeLstat, safeReadFile, safeReaddir } from '../libs/core/secure-io.js';

const rootDir = process.cwd();

function collectPackageFiles(baseDir: string, depth = 1): string[] {
  if (!safeExistsSync(baseDir)) return [];
  const found: string[] = [];

  function visit(currentDir: string, currentDepth: number) {
    const pkgPath = path.join(currentDir, 'package.json');
    if (safeExistsSync(pkgPath)) {
      found.push(path.relative(rootDir, pkgPath));
      return;
    }
    if (currentDepth === 0) return;
    for (const entry of safeReaddir(currentDir)) {
      const next = path.join(currentDir, entry);
      if (safeLstat(next).isDirectory()) {
        visit(next, currentDepth - 1);
      }
    }
  }

  visit(baseDir, depth);
  return found.sort((a, b) => a.localeCompare(b));
}

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
  it('keeps workspace package entrypoints aligned with built output files', () => {
    const packageFiles = [
      'libs/core/package.json',
      ...collectPackageFiles(path.join(rootDir, 'libs'), 2).filter((rel) => rel.startsWith('libs/shared-')),
      ...collectPackageFiles(path.join(rootDir, 'libs/actuators'), 2),
      ...collectPackageFiles(path.join(rootDir, 'satellites'), 2),
    ];

    const missing: string[] = [];

    for (const relPkg of packageFiles) {
      const absPkg = path.join(rootDir, relPkg);
      const pkgDir = path.dirname(absPkg);
      const pkg = JSON.parse(safeReadFile(absPkg, { encoding: 'utf8' }) as string);
      const targets = [
        pkg.main,
        pkg.types,
        ...collectExportTargets(pkg.exports),
      ].filter((value: unknown): value is string => typeof value === 'string');

      for (const target of targets) {
        const resolved = path.resolve(pkgDir, target);
        if (!safeExistsSync(resolved)) {
          missing.push(`${relPkg} -> ${target}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
