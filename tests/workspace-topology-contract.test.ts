import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { safeExistsSync, safeReadFile, safeReaddir, safeLstat } from '../libs/core/secure-io.js';

const rootDir = process.cwd();

function collectPackageFiles(baseDir: string, depth = 2): string[] {
  if (!safeExistsSync(baseDir)) return [];
  const found: string[] = [];

  function visit(currentDir: string, currentDepth: number) {
    const pkgPath = path.join(currentDir, 'package.json');
    if (safeExistsSync(pkgPath)) {
      found.push(path.relative(rootDir, pkgPath).split(path.sep).join('/'));
      return;
    }
    if (currentDepth === 0) return;
    for (const entry of safeReaddir(currentDir)) {
      const next = path.join(currentDir, entry);
      if (safeLstat(next).isDirectory()) visit(next, currentDepth - 1);
    }
  }

  visit(baseDir, depth);
  return found.sort((a, b) => a.localeCompare(b));
}

describe('Workspace topology contract', () => {
  it('keeps root workspaces aligned with pnpm workspace packages', () => {
    const rootPkg = JSON.parse(safeReadFile('package.json', { encoding: 'utf8' }) as string);
    const pnpmWorkspace = yaml.load(safeReadFile('pnpm-workspace.yaml', { encoding: 'utf8' }) as string) as any;

    expect([...(rootPkg.workspaces || [])].sort()).toEqual([...(pnpmWorkspace.packages || [])].sort());
  });

  it('treats presence packages as explicit app or service workspaces', () => {
    const packageFiles = [
      ...collectPackageFiles(path.join(rootDir, 'presence/displays')),
      ...collectPackageFiles(path.join(rootDir, 'presence/bridge')),
    ];

    const violations: string[] = [];

    for (const relPkg of packageFiles) {
      const pkg = JSON.parse(safeReadFile(relPkg, { encoding: 'utf8' }) as string);
      const hasEntrypoint = typeof pkg.main === 'string' || typeof pkg.types === 'string' || typeof pkg.exports === 'object';
      const scripts = pkg.scripts || {};
      const isPrivate = pkg.private === true;
      const hasAppContract = Boolean(scripts.dev && scripts.build && scripts.start);
      const hasServiceContract = Boolean(scripts.build && scripts.start);

      if (!hasEntrypoint && !(isPrivate && (hasAppContract || hasServiceContract))) {
        violations.push(relPkg);
      }
    }

    expect(violations).toEqual([]);
  });
});
