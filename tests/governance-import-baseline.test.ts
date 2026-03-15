import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const rootDir = process.cwd();
const baselinePath = path.join(rootDir, 'tests', 'fixtures', 'governance-import-baseline.json');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as {
  fs_imports: string[];
  child_process_imports: string[];
};

const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const IGNORED_DIRS = new Set([
  '.git',
  '.next',
  'node_modules',
  'dist',
  'coverage',
  'active',
  'scratch',
  'work',
  'vault',
]);
const EXCLUDED_FILES = new Set([
  'tests/governance-import-baseline.test.ts',
]);

function walk(dirPath: string, relativeBase = ''): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const absPath = path.join(dirPath, entry.name);
    const relPath = relativeBase ? path.join(relativeBase, entry.name) : entry.name;

    if (entry.isDirectory()) {
      files.push(...walk(absPath, relPath));
      continue;
    }

    if (CODE_EXTENSIONS.has(path.extname(entry.name))) {
      if (EXCLUDED_FILES.has(relPath)) continue;
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
    if (pattern.test(content)) {
      matches.push(relPath);
    }
  }

  return normalize(matches);
}

function diffMessage(kind: string, expected: string[], actual: string[]): string {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const added = actual.filter((item) => !expectedSet.has(item));
  const removed = expected.filter((item) => !actualSet.has(item));

  return [
    `${kind} baseline changed.`,
    added.length ? `Added:\n${added.join('\n')}` : 'Added:\n(none)',
    removed.length ? `Removed:\n${removed.join('\n')}` : 'Removed:\n(none)',
    'If intentional, update tests/fixtures/governance-import-baseline.json in the same change.',
  ].join('\n\n');
}

describe('Governance import baseline', () => {
  it('does not introduce new direct fs imports without updating the baseline', () => {
    const actual = findRestrictedImports(
      /from\s+['"](?:node:)?fs['"]|require\(\s*['"](?:node:)?fs['"]\s*\)/
    );
    const expected = normalize(baseline.fs_imports);
    expect(actual, diffMessage('Direct fs import', expected, actual)).toEqual(expected);
  });

  it('does not introduce new direct child_process imports without updating the baseline', () => {
    const actual = findRestrictedImports(
      /from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\)/
    );
    const expected = normalize(baseline.child_process_imports);
    expect(actual, diffMessage('Direct child_process import', expected, actual)).toEqual(expected);
  });
});
