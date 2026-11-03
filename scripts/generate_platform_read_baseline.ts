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
 */
/* eslint-disable no-restricted-imports, no-restricted-syntax -- repo-wide scanner; same rationale as generate_governance_import_baseline */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const rootDir = process.cwd();
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
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absPath = path.join(dirPath, entry.name);
    const relPath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;
    const norm = normalize(relPath);
    if (
      IGNORED_DIR_PARTS.some((part) => `/${norm}/`.includes(part) || norm.includes(part.slice(1)))
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...walk(absPath, relPath));
      continue;
    }
    if (!codeFileRe.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
    if (testFileRe.test(norm)) continue;
    files.push(norm);
  }
  return files;
}

export function scanPlatformReadBaseline(): { allowed_raw_platform_files: string[] } {
  const offenders: string[] = [];
  for (const root of scanRoots) {
    for (const relPath of walk(path.join(rootDir, root), root)) {
      const content = fs.readFileSync(path.join(rootDir, relPath), 'utf8');
      if (rawPlatformReadRe.test(content)) offenders.push(relPath);
    }
  }
  return {
    allowed_raw_platform_files: [...offenders].sort((a, b) => a.localeCompare(b)),
  };
}

function main(argv = process.argv.slice(2)): number {
  const checkOnly = argv.includes('--check');
  const scanned = scanPlatformReadBaseline();
  const next = `${JSON.stringify(scanned, null, 2)}\n`;
  if (checkOnly) {
    const current = fs.existsSync(baselinePath) ? fs.readFileSync(baselinePath, 'utf8') : '';
    if (current !== next) {
      process.stderr.write(
        `[platform-read-baseline] fixture out of date\n` +
          `  fix: pnpm generate:platform-read-baseline\n`
      );
      return 1;
    }
    process.stdout.write('[platform-read-baseline] ok\n');
    return 0;
  }
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, next, 'utf8');
  process.stdout.write(
    `[platform-read-baseline] wrote ${path.relative(rootDir, baselinePath)} ` +
      `(${scanned.allowed_raw_platform_files.length} files)\n`
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main();
}
