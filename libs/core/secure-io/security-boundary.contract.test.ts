import { describe, expect, it } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import { safeLstat, safeReadFile, safeReaddir } from '../secure-io.js';
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
  'scripts/capability/capability_discovery_entry.mjs': 'Build-independent read-only discovery',
  'scripts/bundle_entrypoints.mjs': 'Compiler bundling bootstrap',
  'scripts/write_core_dist_scope.mjs': 'Compiler output package-scope bootstrap',
  'scripts/git_merge_regenerate.mjs': 'Git merge-driver bootstrap before compiled artifacts exist',
  'scripts/agy/agy_profile_controller.ts':
    'Existing host profile manager outside governed repository storage',
  'scripts/codex/codex_profile_controller.ts':
    'Existing host profile manager outside governed repository storage',
};

function usesRawFs(source: string, fileName = 'boundary.mjs'): boolean {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false);
  const raw = (node: ts.Node | undefined) =>
    node && ts.isStringLiteralLike(node) && /^(?:node:)?fs(?:\/promises)?$/.test(node.text);
  const visit = (node: ts.Node): true | undefined => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && raw(node.moduleSpecifier))
      return true;
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      raw(node.moduleReference.expression)
    )
      return true;
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
      raw(node.arguments[0])
    )
      return true;
    return ts.forEachChild(node, visit);
  };
  return visit(file) === true;
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

const PRODUCTION_ROOTS = ['libs', 'scripts', 'presence', 'satellites'];

// Every fs specifier usesRawFs can detect still contains one of these quoted
// literals in the source text — including the escaped forms '\x66s' / '\u0066s'
// that a naive "'fs'" search would miss. Files failing this cannot import fs,
// so only they skip the per-file TypeScript parse; coverage-on CI was timing
// out parsing thousands of candidates that never mention fs at all.
const FS_SPECIFIER_HINT = /['"`](?:node:)?(?:fs(?:\/promises)?|\\x66s|\\u0066s|\\146s)['"`]/;

interface ProductionScan {
  /** Absolute candidate paths grouped by production root. */
  filesByRoot: Map<string, string[]>;
  /** Absolute path → file source (read exactly once for the whole suite). */
  sourceByFile: Map<string, string>;
  /** Repo-relative paths confirmed to use raw fs. */
  rawFsFiles: Set<string>;
}

// One walk + one read per production file for the entire suite. The earlier
// shape re-walked every root per test and re-parsed every candidate — each
// added test multiplied the whole-repo scan.
let productionScan: ProductionScan | undefined;
function scanProductionFiles(): ProductionScan {
  if (productionScan) return productionScan;
  const repoRoot = pathResolver.rootDir();
  const filesByRoot = new Map<string, string[]>();
  const sourceByFile = new Map<string, string>();
  const rawFsFiles = new Set<string>();
  for (const root of PRODUCTION_ROOTS) {
    const candidates = collectProductionTsFiles(`${repoRoot}/${root}`);
    filesByRoot.set(root, candidates);
    for (const file of candidates) {
      const source = String(safeReadFile(file, { encoding: 'utf8' }));
      sourceByFile.set(file, source);
      if (FS_SPECIFIER_HINT.test(source) && usesRawFs(source, file)) {
        rawFsFiles.add(file.slice(repoRoot.length + 1));
      }
    }
  }
  productionScan = { filesByRoot, sourceByFile, rawFsFiles };
  return productionScan;
}

describe('security boundary contract', () => {
  it('keeps every reviewed boundary inside an audited production root', () => {
    expect(
      Object.keys(ALLOWLIST).filter(
        (file) => !PRODUCTION_ROOTS.some((root) => file.startsWith(`${root}/`))
      )
    ).toEqual([]);
  });

  it.each(PRODUCTION_ROOTS)('confines raw fs in %s to reviewed low-level boundaries', (root) => {
    const scan = scanProductionFiles();
    const prefix = `${root}/`;
    const rawFiles = new Set([...scan.rawFsFiles].filter((file) => file.startsWith(prefix)));
    expect([...rawFiles].filter((file) => !(file in ALLOWLIST))).toEqual([]);
    expect(
      Object.keys(ALLOWLIST).filter((file) => file.startsWith(prefix) && !rawFiles.has(file))
    ).toEqual([]);
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

  it('detects decoded specifiers and TypeScript import-equals', () => {
    for (const source of [
      String.raw`import fs from '\x66s'`,
      String.raw`export * from 'node:\u0066s/promises'`,
      String.raw`require('\u0066s')`,
      String.raw`import('node:\x66s')`,
      "import fs = require('fs')",
    ])
      expect(usesRawFs(source, 'boundary.ts')).toBe(true);
    expect(usesRawFs("import fs from 'fs-extra'", 'boundary.ts')).toBe(false);
  });

  it.each(['boundary.tsx', 'boundary.jsx'])(
    'distinguishes JSX text from executable imports in %s',
    (fileName) => {
      expect(usesRawFs("const view = <div>require('fs')</div>", fileName)).toBe(false);
      expect(usesRawFs("const view = <div>{require('fs')}</div>", fileName)).toBe(true);
      expect(usesRawFs("const view = <div>{import('node:fs/promises')}</div>", fileName)).toBe(
        true
      );
    }
  );

  it('lets only secure-io.ts import its permission guards (secure-io-path-guard)', () => {
    const repoRoot = pathResolver.rootDir();
    const scan = scanProductionFiles();
    const importers = [...scan.sourceByFile.keys()]
      .filter((filePath) => !filePath.endsWith('/libs/core/secure-io-path-guard.ts'))
      .filter((filePath) =>
        /['"][^'"]*secure-io-path-guard(?:\.js)?['"]/.test(
          scan.sourceByFile.get(filePath) as string
        )
      )
      .map((filePath) => filePath.slice(repoRoot.length + 1));
    expect(importers).toEqual(['libs/core/secure-io.ts']);
  });

  it('lets only the backup file walk use the backup credential read admission', () => {
    const repoRoot = pathResolver.rootDir();
    const scan = scanProductionFiles();
    const users = [...scan.sourceByFile.keys()]
      .filter((filePath) => !filePath.endsWith('/libs/core/sensitive-path-policy.ts'))
      .filter((filePath) =>
        /\bwithBackupCredentialReadAdmission\b/.test(scan.sourceByFile.get(filePath) as string)
      )
      .map((filePath) => filePath.slice(repoRoot.length + 1));
    expect(users).toEqual(['scripts/lib/backup/backup-file-selection.ts']);
  });
});
