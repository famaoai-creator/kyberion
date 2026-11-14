#!/usr/bin/env node
/**
 * Regenerate tests/fixtures/governance-import-baseline.json from a repo scan.
 *
 * Prefer this over hand-editing the fixture when a change intentionally adds
 * a direct `node:fs` / `node:child_process` import:
 *
 *   pnpm generate:governance-import-baseline
 *
 * Use `--check` in CI-adjacent flows to fail when the fixture drifts without
 * rewriting it.
 *
 * The scan goes through secure-io: every directory it walks is readable under
 * the governed read boundary (tier roots such as knowledge/personal and
 * knowledge/confidential, and runtime roots such as active/ and vault/, are
 * skipped below), so it needs no raw-fs exemption from
 * libs/core/security-boundary.contract.test.ts.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeLstat, safeReadFile, safeReaddir } from '@agent/core/secure-io';
import { defineGenerator, isDirectScript } from '../lib/harness.js';

const rootDir = pathResolver.rootDir();
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
  const files: string[] = [];

  for (const name of safeReaddir(dirPath)) {
    if (IGNORED_DIRS.has(name)) continue;
    const absPath = path.join(dirPath, name);
    const relPath = relativeBase ? path.join(relativeBase, name) : name;
    // Tier roots are skipped before any metadata read: secure-io refuses them.
    if (relPath === 'knowledge/confidential' || relPath === 'knowledge/personal') continue;

    if (safeLstat(absPath).isDirectory()) {
      files.push(...walk(absPath, relPath));
      continue;
    }

    if (CODE_EXTENSIONS.has(path.extname(name))) {
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
    const content = String(safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }));
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

export const main = defineGenerator({
  id: 'governance-import-baseline',
  outputs: [baselinePath],
  render() {
    const scanned = scanGovernanceImportBaseline();
    return [{ path: baselinePath, content: `${JSON.stringify(scanned, null, 2)}\n` }];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_governance_import_baseline.ts') ||
  isDirectScript(import.meta.url, 'generate_governance_import_baseline.js')
)
  void main();
