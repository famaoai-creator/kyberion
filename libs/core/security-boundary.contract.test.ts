import { describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeLstat, safeReadFile, safeReaddir } from './secure-io.js';
import ts from 'typescript';

// Exact reviewed boundaries; bootstrap modules run before secure-io can load.
// A listed module must exist AND still use raw fs (stale entries fail below).
const ALLOWLIST: Record<string, string> = {
  'libs/core/secure-io.ts': 'Governed I/O facade',
  'libs/core/secure-io-path-guard.ts': 'Canonical permission and symlink guards',
  'libs/core/fs-primitives.ts': 'Low-level primitives consumed by secure-io',
  'libs/core/private-host-cache.mjs': 'Pre-TypeScript private executable cache; owner/mode guarded',
  'libs/core/repository-path-boundary.mjs': 'Pre-TypeScript canonical repository path validation',
  'scripts/ts-loader.mjs': 'TypeScript loader bootstraps secure-io itself',
  'scripts/ts-loader-cache.mjs': 'Private loader cache before TypeScript is available',
  'scripts/kyberion_cli_entry.mjs': 'Build-independent CLI bootstrap',
  'scripts/capability_discovery_entry.mjs': 'Build-independent read-only discovery',
  'scripts/bundle_entrypoints.mjs': 'Compiler bundling bootstrap',
  'scripts/write_core_dist_scope.mjs': 'Compiler output package-scope bootstrap',
  'scripts/git_merge_regenerate.mjs': 'Git merge-driver bootstrap before compiled artifacts exist',
  'scripts/agy_profile_controller.ts':
    'Existing host profile manager outside governed repository storage',
  'scripts/codex_profile_controller.ts':
    'Existing host profile manager outside governed repository storage',
};

function usesRawFs(source: string): boolean {
  const file = ts.createSourceFile('boundary.mjs', source, ts.ScriptTarget.Latest, true);
  let found = false;
  const raw = (node: ts.Node | undefined) =>
    node && ts.isStringLiteralLike(node) && /^(?:node:)?fs(?:\/promises)?$/.test(node.text);
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && raw(node.moduleSpecifier))
      found = true;
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      raw(node.moduleReference.expression)
    )
      found = true;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      raw(node.arguments[0])
    )
      found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function collectProductionTsFiles(dir: string): string[] {
  const entries = safeReaddir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = `${dir}/${entry}`;
    const stat = safeLstat(fullPath);
    if (stat.isDirectory()) {
      if (['dist', 'node_modules', '.next', '.turbo', 'coverage', 'test-results'].includes(entry))
        continue;
      files.push(...collectProductionTsFiles(fullPath));
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (!/\.[cm]?[jt]sx?$/.test(entry)) continue;
    if (entry.endsWith('.d.ts')) continue;
    if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry)) continue;
    files.push(fullPath);
  }
  return files;
}

describe('security boundary contract', () => {
  it('keeps raw fs imports confined to reviewed low-level boundaries', () => {
    const repoRoot = pathResolver.rootDir();
    const candidates = [
      ...collectProductionTsFiles(`${repoRoot}/libs`),
      ...collectProductionTsFiles(`${repoRoot}/scripts`),
      ...collectProductionTsFiles(`${repoRoot}/presence`),
      ...collectProductionTsFiles(`${repoRoot}/satellites`),
    ];

    const offenders = candidates.filter((filePath) => {
      const source = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      if (!usesRawFs(source)) return false;
      return !(filePath.slice(repoRoot.length + 1) in ALLOWLIST);
    });

    expect(offenders).toEqual([]);
    const rawFiles = new Set(
      candidates
        .filter((file) => usesRawFs(String(safeReadFile(file, { encoding: 'utf8' }))))
        .map((file) => file.slice(repoRoot.length + 1))
    );
    expect(Object.keys(ALLOWLIST).filter((file) => !rawFiles.has(file))).toEqual([]);
  });

  it('detects static, dynamic and CommonJS fs including promises in JavaScript', () => {
    for (const source of [
      "import fs from 'node:fs'",
      "import {readFile} from 'fs/promises'",
      "await import('node:fs/promises')",
      "const fs = require('fs')",
      "export * from 'node:fs'",
    ])
      expect(usesRawFs(source)).toBe(true);
    expect(usesRawFs("// import fs from 'fs'\nconst text = \"require('fs')\";")).toBe(false);
  });

  it('lets only secure-io.ts import its permission guards (secure-io-path-guard)', () => {
    const repoRoot = pathResolver.rootDir();
    const importers = [
      ...collectProductionTsFiles(`${repoRoot}/libs`),
      ...collectProductionTsFiles(`${repoRoot}/scripts`),
      ...collectProductionTsFiles(`${repoRoot}/satellites`),
      ...collectProductionTsFiles(`${repoRoot}/presence`),
    ]
      .filter((filePath) => !filePath.endsWith('/libs/core/secure-io-path-guard.ts'))
      .filter((filePath) =>
        /['"][^'"]*secure-io-path-guard(?:\.js)?['"]/.test(
          safeReadFile(filePath, { encoding: 'utf8' }) as string
        )
      )
      .map((filePath) => filePath.slice(repoRoot.length + 1));
    expect(importers).toEqual(['libs/core/secure-io.ts']);
  });
});
