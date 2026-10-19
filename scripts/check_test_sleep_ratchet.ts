#!/usr/bin/env node
/**
 * Test sleep ratchet: real-time sleeps in test files may only go down.
 *
 * A test that waits a fixed number of milliseconds for something to happen
 * (a TTL to lapse, a deadline to fire, a background worker to run) passes on a
 * fast machine and flakes on a loaded CI runner. The gate counts those sleeps
 * per test file and fails when a file gains one. Event-loop yields
 * (`setTimeout(resolve, 0)`, `setImmediate`) are not counted.
 *
 * Counted shapes (TypeScript AST, so strings and comments never match):
 *   - `setTimeout(resolve, N)` / `setTimeout(() => resolve(), N)` — the timer
 *     callback only settles a promise, i.e. a sleep (N not the literal 0)
 *   - `setTimeout(N)` from `node:timers/promises`
 *   - `sleep(N)` / `delay(N)` / `wait(N)` / `pause(N)` helpers with N > 0
 */
import * as path from 'node:path';
import ts from 'typescript';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeMkdir, safeWriteFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { withExecutionContext } from '@agent/core/governance';
import { nowIso, readTextFile } from '@agent/core/foundation';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';
import { readSafeJsonFile } from './lib/json-input.js';

const ROOT = pathResolver.rootDir();
const GATE_ID = 'test-sleep-ratchet';
// Mirrors the vitest.config.mts include globs.
const DEFAULT_SCAN_ROOTS = ['libs', 'scripts', 'tests', 'presence', 'satellites'];
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/u;
const SKIPPED_SEGMENTS = new Set([
  '.next',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
  'test-results',
]);
const SLEEP_HELPER = /^(?:sleep|delay|wait|pause)(?:Ms|For)?$/iu;
// Promise settlers. `reject` is deliberately absent: `setTimeout(() =>
// reject(new Error('timed out')), N)` is a timeout guard, not a sleep.
const RESOLVER = /^(?:r|res|resolve\w*|done|wake|settle\w*)$/iu;

export const TEST_SLEEP_FIX_HINT = [
  'Replace the real-time sleep with a deterministic wait:',
  "  - TTL / expiry / lease checks: vi.useFakeTimers({ toFake: ['Date'] }) + vi.setSystemTime(Date.now() + ms)",
  '  - timer-driven code: vi.useFakeTimers() + await vi.advanceTimersByTimeAsync(ms)',
  '  - "wait until X happened": await vi.waitFor(() => expect(...)) (polls, bounded by its timeout)',
  '  - ordering / late-completion races: hold the work on a deferred promise and release it explicitly',
  '  - code that reads the clock: inject a clock (deps.clock / now option) instead of sleeping',
  'See knowledge/product/governance/kyberion-development-practices.md (hermetic tests).',
].join('\n');

export interface TestSleepSite {
  file: string;
  line: number;
  text: string;
}

export interface TestSleepBaseline {
  version: 1;
  generated_at: string;
  total: number;
  files: Record<string, number>;
}

export interface TestSleepReport {
  baseline_path: string;
  total: number;
  baseline_total: number | null;
  files: Record<string, number>;
  sites: TestSleepSite[];
  violations: string[];
  /** Files whose count dropped below the baseline (the baseline can be lowered). */
  improved: string[];
}

function numericLiteralValue(node: ts.Expression): number | undefined {
  if (ts.isNumericLiteral(node)) return Number(node.text.replace(/_/gu, ''));
  return undefined;
}

function isZeroDelay(node: ts.Expression | undefined): boolean {
  return node !== undefined && numericLiteralValue(node) === 0;
}

/** The timer callback only settles a promise: `resolve` or `() => resolve()`. */
function isSettleOnlyCallback(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return RESOLVER.test(node.text);
  if (!ts.isArrowFunction(node) && !ts.isFunctionExpression(node)) return false;
  let body: ts.Node = node.body;
  if (ts.isBlock(body)) {
    if (body.statements.length !== 1) return false;
    const [statement] = body.statements;
    if (!ts.isExpressionStatement(statement)) return false;
    body = statement.expression;
  }
  return (
    ts.isCallExpression(body) &&
    ts.isIdentifier(body.expression) &&
    RESOLVER.test(body.expression.text)
  );
}

function isSleepCall(node: ts.CallExpression): boolean {
  if (!ts.isIdentifier(node.expression)) return false;
  const name = node.expression.text;
  const [first, second] = node.arguments;
  if (name === 'setTimeout') {
    if (!first) return false;
    // node:timers/promises — `await setTimeout(50)`.
    if (node.arguments.length === 1) {
      const value = numericLiteralValue(first);
      return value !== undefined && value > 0;
    }
    return isSettleOnlyCallback(first) && second !== undefined && !isZeroDelay(second);
  }
  if (SLEEP_HELPER.test(name) && first && node.arguments.length === 1) {
    const value = numericLiteralValue(first);
    return value !== undefined && value > 0;
  }
  return false;
}

export function findTestSleeps(repoRelativePath: string, text: string): TestSleepSite[] {
  const source = ts.createSourceFile(
    repoRelativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    repoRelativePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const sites: TestSleepSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isSleepCall(node)) {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      sites.push({ file: repoRelativePath, line: line + 1, text: node.getText(source) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function listTestFiles(scanRoots: string[], rootDir: string): string[] {
  const files: string[] = [];
  for (const root of scanRoots) {
    const absRoot = path.resolve(rootDir, root);
    if (!safeExistsSync(absRoot)) continue;
    for (const file of getAllFiles(absRoot)) {
      if (!TEST_FILE.test(file)) continue;
      const rel = path.relative(rootDir, file).split(path.sep).join('/');
      if (rel.split('/').some((segment) => SKIPPED_SEGMENTS.has(segment))) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

function readRegularFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

export function scanTestSleeps(
  scanRoots: string[] = DEFAULT_SCAN_ROOTS,
  rootDir: string = ROOT
): TestSleepSite[] {
  return listTestFiles(scanRoots, rootDir).flatMap((rel) =>
    findTestSleeps(rel, readRegularFile(path.resolve(rootDir, rel)))
  );
}

function countByFile(sites: TestSleepSite[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function checkTestSleepRatchet(
  options: {
    baselinePath?: string;
    scanRoots?: string[];
    rootDir?: string;
    writeBaseline?: boolean;
  } = {}
): TestSleepReport {
  const baselinePath = options.baselinePath ?? resolveCiGateBaselinePath(GATE_ID);
  const sites = scanTestSleeps(options.scanRoots, options.rootDir);
  const files = countByFile(sites);
  const total = sites.length;

  if (options.writeBaseline) {
    const baseline: TestSleepBaseline = { version: 1, generated_at: nowIso(), total, files };
    withExecutionContext('ecosystem_architect', () => {
      safeMkdir(path.dirname(baselinePath), { recursive: true });
      safeWriteFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
    });
    return {
      baseline_path: baselinePath,
      total,
      baseline_total: total,
      files,
      sites,
      violations: [],
      improved: [],
    };
  }

  if (!safeExistsSync(baselinePath)) {
    return {
      baseline_path: baselinePath,
      total,
      baseline_total: null,
      files,
      sites,
      violations: [
        `baseline missing: ${path.relative(ROOT, baselinePath)} (run with --write-baseline to initialize)`,
      ],
      improved: [],
    };
  }

  const baseline = readSafeJsonFile<TestSleepBaseline>(baselinePath, 'test sleep ratchet baseline');
  const violations: string[] = [];
  const improved: string[] = [];
  for (const [file, count] of Object.entries(files)) {
    const allowed = baseline.files[file] ?? 0;
    if (count <= allowed) continue;
    violations.push(`${file}: ${count} real-time sleep(s), baseline allows ${allowed}`);
    for (const site of sites.filter((entry) => entry.file === file)) {
      violations.push(`  ${site.file}:${site.line}  ${site.text.replace(/\s+/gu, ' ')}`);
    }
  }
  for (const [file, allowed] of Object.entries(baseline.files)) {
    if ((files[file] ?? 0) < allowed) improved.push(file);
  }

  return {
    baseline_path: baselinePath,
    total,
    baseline_total: baseline.total,
    files,
    sites,
    violations,
    improved,
  };
}

export const runCheckTestSleepRatchet = defineScript({
  name: 'check:test-sleep-ratchet',
  flags: [],
  run(context) {
    const writeBaseline = context.argv.includes('--write-baseline');
    const report = checkTestSleepRatchet({ writeBaseline });

    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          'real-time sleeps in tests increased:',
          ...report.violations,
          '',
          TEST_SLEEP_FIX_HINT,
        ].join('\n')
      );
    }

    if (writeBaseline) {
      context.print(`[check:test-sleep-ratchet] baseline written: ${report.total} sleep(s)`);
      return { report };
    }
    context.print(
      `[check:test-sleep-ratchet] OK (${report.total} real-time sleep(s), baseline ${report.baseline_total})`
    );
    if (report.improved.length > 0) {
      context.print(
        `[check:test-sleep-ratchet] ${report.improved.length} file(s) dropped below the baseline — lower it with: node --import ./scripts/ts-loader.mjs scripts/check_test_sleep_ratchet.ts --write-baseline`
      );
    }
    return { report };
  },
});

if (
  isDirectScript(import.meta.url, 'check_test_sleep_ratchet.ts') ||
  isDirectScript(import.meta.url, 'check_test_sleep_ratchet.js')
)
  void runCheckTestSleepRatchet();
