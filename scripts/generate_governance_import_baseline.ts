#!/usr/bin/env node
/**
 * Regenerate tests/fixtures/governance-import-baseline.json from a repo scan.
 *
 * Prefer this over hand-editing the fixture when a change intentionally adds
 * a direct `node:fs` / `node:child_process` import:
 *
 *   node --import ./scripts/ts-loader.mjs scripts/generate_governance_import_baseline.ts
 *
 * Use `--check` in CI-adjacent flows to fail when the fixture drifts without
 * rewriting it.
 *
 * Direct node:fs is intentional here: the scanner must walk the whole
 * repository including paths the secure-io read boundary refuses (the same
 * reason tests/governance-import-baseline.test.ts uses node:fs). Registered
 * in governance-import-baseline.json.
 */
/* eslint-disable no-restricted-imports, no-restricted-syntax -- repo-wide import scanner; see file header */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineScript, isDirectScript } from './lib/harness.js';

const rootDir = process.cwd();
const baselinePath = path.join(rootDir, 'tests', 'fixtures', 'governance-import-baseline.json');

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  'node_modules',
  'dist',
  'coverage',
  'active',
  'work',
  'vault',
  '.claude',
  '.codex',
  '.worktrees',
  '.tmp-mulmoclaude',
  '.tmp-agency-agents',
  '.pnpm-store',
]);
const EXCLUDED_FILES = new Set(['tests/governance-import-baseline.test.ts']);

const FS_PATTERN = /from\s+['"](?:node:)?fs['"]|require\(\s*['"](?:node:)?fs['"]\s*\)/;
const CHILD_PATTERN =
  /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/;

function walk(dirPath: string, relativeBase = ''): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const absPath = path.join(dirPath, entry.name);
    const relPath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;

    if (entry.isDirectory()) {
      if (relPath === 'knowledge/confidential' || relPath === 'knowledge/personal') continue;
      files.push(...walk(absPath, relPath));
      continue;
    }

    if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      if (EXCLUDED_FILES.has(relPath)) continue;
      if (relPath.endsWith('.d.ts')) continue;
      files.push(relPath);
    }
  }

  return files;
}

function normalize(list: string[]): string[] {
  return [...list].sort((a, b) => a.localeCompare(b));
}

function findRestrictedImports(pattern: RegExp): string[] {
  const files = walk(rootDir);
  const matches: string[] = [];
  for (const relPath of files) {
    const content = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
    if (pattern.test(content)) matches.push(relPath);
  }
  return normalize(matches);
}

export function scanGovernanceImportBaseline(): {
  fs_imports: string[];
  child_process_imports: string[];
} {
  return {
    fs_imports: findRestrictedImports(FS_PATTERN),
    child_process_imports: findRestrictedImports(CHILD_PATTERN),
  };
}

function main(argv: readonly string[]): number {
  const checkOnly = argv.includes('--check');
  const scanned = scanGovernanceImportBaseline();
  const next = `${JSON.stringify(scanned, null, 2)}\n`;

  if (checkOnly) {
    const current = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf8') : '';
    if (current !== next) {
      process.stderr.write(
        `[governance-import-baseline] fixture out of date\n` +
          `  fix: node --import ./scripts/ts-loader.mjs scripts/generate_governance_import_baseline.ts\n`
      );
      return 1;
    }
    process.stdout.write('[governance-import-baseline] ok\n');
    return 0;
  }

  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, next, 'utf8');
  process.stdout.write(
    `[governance-import-baseline] wrote ${path.relative(rootDir, baselinePath)} ` +
      `(fs=${scanned.fs_imports.length}, child_process=${scanned.child_process_imports.length})\n`
  );
  return 0;
}

export const generateGovernanceImportBaselineScript = defineScript({
  name: 'generate-governance-import-baseline',
  flags: [],
  run(context) {
    const exitCode = main(context.argv);
    process.exitCode = exitCode;
    return exitCode;
  },
});

if (
  isDirectScript(import.meta.url, 'generate_governance_import_baseline.ts') ||
  isDirectScript(import.meta.url, 'generate_governance_import_baseline.js')
)
  void generateGovernanceImportBaselineScript();
