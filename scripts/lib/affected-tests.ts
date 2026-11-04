/**
 * Affected tests for a change (pre-PR checklist step 3.5).
 *
 * Two selections, because gates run no test suite and the import graph does
 * not see data:
 *   1. code: `vitest run --changed <base>` — every test that (transitively)
 *      imports a changed file. Vitest computes this itself.
 *   2. readers: changed files that are not code (JSON / YAML / Markdown under
 *      knowledge/, manifests, AGENTS.md, CONTRIBUTING.md, …) are read at run
 *      time, so the import graph never selects the tests that read them
 *      (registry-count tests, doc contract tests). We find those tests by a
 *      fixed-string search for the file's path in test sources.
 *
 * Pure apart from the injected git runner; execution lives in
 * publish_pull_request.ts (`runAffectedTests`).
 */

import * as path from 'node:path';
import type { GitRunner } from '../run_checks.js';
import { TEST_SUITES } from '../test_suite.js';

/** Extensions vitest follows through the import graph. */
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);

/** Test file globs (git pathspec, `:(glob)` magic). */
export const TEST_FILE_PATHSPECS = [
  ':(glob)**/*.test.ts',
  ':(glob)**/*.test.tsx',
  ':(glob)**/*.test.mts',
] as const;

/** Basenames too common to identify one file; only their full path is searched. */
const GENERIC_BASENAMES = new Set([
  'index.json',
  'index.md',
  'readme.md',
  'package.json',
  'manifest.json',
  'schema.json',
  'config.json',
  'policy.json',
  'tsconfig.json',
  'changelog.md',
  'skill.md',
  'state.json',
]);

/** Changed paths that never have test readers worth running. */
const IGNORED_PREFIXES = ['changelog.d/', 'active/', 'dist/', 'node_modules/'];

/** Generated outputs whose readers are the generator's own freshness tests. */
const IGNORED_FILES = new Set(['knowledge/_index.md', 'pnpm-lock.yaml']);

/** A needle that matches more test files than this identifies nothing. */
export const MAX_READERS_PER_FILE = 40;

/**
 * Paths the CI test suites run (scripts/test_suite.ts TEST_SUITES, flags
 * dropped). Affected tests are limited to these: the root vitest config also
 * matches tests CI never runs (e.g. presence/displays/** package suites with
 * their own environments), and a failure there says nothing about CI.
 */
export function ciTestPaths(): string[] {
  const paths = new Set<string>();
  for (const entries of Object.values(TEST_SUITES)) {
    for (const entry of entries as readonly string[]) if (!entry.startsWith('-')) paths.add(entry);
  }
  return [...paths].sort();
}

export function isCiTest(file: string, paths: readonly string[] = ciTestPaths()): boolean {
  return paths.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

export interface ReaderMatch {
  file: string;
  needles: string[];
  tests: string[];
  /** True when the needles matched too many tests to be a useful selection. */
  tooBroad: boolean;
}

export interface AffectedTestPlan {
  base: string;
  codeFiles: string[];
  dataFiles: string[];
  readers: ReaderMatch[];
  /** Deduplicated reader tests to run (excludes too-broad matches and non-CI tests). */
  readerTests: string[];
  /** Reader tests outside the CI test suites (reported, not run). */
  nonCiReaderTests: string[];
  /** Path filters for the code run (the CI test suite paths). */
  ciPaths: string[];
}

export function isCodeFile(file: string): boolean {
  return CODE_EXTENSIONS.has(path.posix.extname(file).toLowerCase());
}

export function isTestFile(file: string): boolean {
  return /\.test\.(?:ts|tsx|mts)$/u.test(file);
}

/** Changed non-code files whose run-time readers should be searched for. */
export function dataFilesOf(files: readonly string[]): string[] {
  return files.filter(
    (file) =>
      !isCodeFile(file) &&
      !IGNORED_FILES.has(file) &&
      !IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix))
  );
}

/**
 * Strings a test would contain if it reads `file`: the repo-relative path,
 * the path relative to `knowledge/` (pathResolver.knowledge(...) callers),
 * and the basename unless it is generic.
 */
export function readerNeedles(file: string): string[] {
  const needles = new Set<string>([file]);
  if (file.startsWith('knowledge/')) needles.add(file.slice('knowledge/'.length));
  const base = path.posix.basename(file);
  if (!GENERIC_BASENAMES.has(base.toLowerCase()) && base.length >= 6) needles.add(base);
  return [...needles];
}

/** Test files (tracked and untracked) whose source contains any needle. */
export function findReaderTests(needles: readonly string[], git: GitRunner): string[] {
  if (needles.length === 0) return [];
  const args = [
    'grep',
    '--untracked',
    '-l',
    '-F',
    ...needles.flatMap((needle) => ['-e', needle]),
    '--',
    ...TEST_FILE_PATHSPECS,
  ];
  const result = git(args);
  // git grep exits 1 when nothing matched.
  if (result.status === 1) return [];
  if (result.status !== 0) {
    throw new Error(`git grep for reader tests failed: ${result.stderr.trim()}`);
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

export function planAffectedTests(
  changed: { base: string; files: readonly string[] },
  git: GitRunner
): AffectedTestPlan {
  const codeFiles = changed.files.filter(isCodeFile);
  const dataFiles = dataFilesOf(changed.files);
  const readers: ReaderMatch[] = dataFiles.map((file) => {
    const needles = readerNeedles(file);
    const tests = findReaderTests(needles, git);
    return { file, needles, tests, tooBroad: tests.length > MAX_READERS_PER_FILE };
  });
  const ciPaths = ciTestPaths();
  const selected = [
    ...new Set(readers.filter((reader) => !reader.tooBroad).flatMap((reader) => reader.tests)),
  ].sort();
  const readerTests = selected.filter((test) => isCiTest(test, ciPaths));
  const nonCiReaderTests = selected.filter((test) => !isCiTest(test, ciPaths));
  return {
    base: changed.base,
    codeFiles,
    dataFiles,
    readers,
    readerTests,
    nonCiReaderTests,
    ciPaths,
  };
}

/** Human-readable summary lines for the preflight log. */
export function describeAffectedTestPlan(plan: AffectedTestPlan): string[] {
  const lines = [
    `[pr:affected-tests] ${plan.codeFiles.length} code file(s) → vitest run --changed ${plan.base}`,
    `[pr:affected-tests] ${plan.dataFiles.length} data/doc file(s) → ${plan.readerTests.length} reader test file(s)`,
  ];
  if (plan.nonCiReaderTests.length > 0) {
    lines.push(
      `[pr:affected-tests]   not run (outside the CI test suites): ${plan.nonCiReaderTests.join(', ')}`
    );
  }
  for (const reader of plan.readers) {
    if (reader.tooBroad) {
      lines.push(
        `[pr:affected-tests]   ${reader.file}: ${reader.tests.length} readers — too broad to select, run the suite that owns it`
      );
    } else if (reader.tests.length > 0) {
      lines.push(`[pr:affected-tests]   ${reader.file} → ${reader.tests.join(', ')}`);
    }
  }
  return lines;
}
