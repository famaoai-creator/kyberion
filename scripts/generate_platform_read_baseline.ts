#!/usr/bin/env node
/**
 * Regenerate tests/fixtures/platform-read-baseline.json from a repo scan.
 *
 * The platform-read boundary gate compares the set of non-test source files
 * that contain raw `process.platform` / `os.platform()` reads against this
 * fixture. Prefer regenerating over hand-editing the allowlist:
 *
 *   pnpm generate:platform-read-baseline
 *
 * `--check` fails when the fixture drifts without rewriting it.
 *
 * The scan roots are all readable under the governed read boundary, so the
 * walk goes through secure-io rather than raw fs.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReadFile, safeReaddir } from '@agent/core/secure-io';
import { defineGenerator, isDirectScript } from './lib/harness.js';

const rootDir = pathResolver.rootDir();
const baselinePath = path.join(rootDir, 'tests', 'fixtures', 'platform-read-baseline.json');

const scanRoots = [
  'libs',
  'scripts',
  'satellites',
  'presence',
  'tools',
  'eval',
  'migration',
  'tests',
  'plugins',
];
const codeFileRe = /\.(ts|tsx|mts|mjs|cts|cjs|js|jsx)$/;
const testFileRe = /(\.test\.|\.spec\.|__tests__|\.live\.test\.)/;
const rawPlatformReadRe = /\bprocess\.platform\b|\bos\.platform\s*\(/;
const IGNORED_DIR_PARTS = [
  '/node_modules/',
  '/dist/',
  '/.next/',
  '/.turbo/',
  '/coverage/',
  '/.worktrees/',
  '/retired/',
  '/.git/',
];

function normalize(relPath: string): string {
  return relPath.split(path.sep).join('/');
}

function walk(dirPath: string, relativeBase = ''): string[] {
  if (!safeExistsSync(dirPath)) return [];
  const files: string[] = [];
  for (const name of safeReaddir(dirPath)) {
    const absPath = path.join(dirPath, name);
    const relPath = relativeBase ? path.join(relativeBase, name) : name;
    const norm = normalize(relPath);
    if (
      IGNORED_DIR_PARTS.some((part) => `/${norm}/`.includes(part) || norm.includes(part.slice(1)))
    ) {
      continue;
    }
    if (safeLstat(absPath).isDirectory()) {
      files.push(...walk(absPath, relPath));
      continue;
    }
    if (!codeFileRe.test(name) || name.endsWith('.d.ts')) continue;
    if (testFileRe.test(norm)) continue;
    files.push(norm);
  }
  return files;
}

export function scanPlatformReadBaseline(): { allowed_raw_platform_files: string[] } {
  const offenders: string[] = [];
  for (const root of scanRoots) {
    for (const relPath of walk(path.join(rootDir, root), root)) {
      const content = String(safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }));
      if (rawPlatformReadRe.test(content)) offenders.push(relPath);
    }
  }
  return {
    allowed_raw_platform_files: [...offenders].sort((a, b) => a.localeCompare(b)),
  };
}

export const main = defineGenerator({
  id: 'platform-read-baseline',
  outputs: [baselinePath],
  render() {
    const scanned = scanPlatformReadBaseline();
    return [{ path: baselinePath, content: `${JSON.stringify(scanned, null, 2)}\n` }];
  },
});

if (
  isDirectScript(import.meta.url, 'generate_platform_read_baseline.ts') ||
  isDirectScript(import.meta.url, 'generate_platform_read_baseline.js')
)
  void main();
