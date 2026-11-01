#!/usr/bin/env node
/**
 * Runtime store whole-read ratchet (MSN-STORE-BOUNDS-2-20261101, P1):
 * whole-file reads of append-only JSONL stores may only go down.
 *
 * A reader that loads a store whole goes through the 100MB read cap, so once
 * the store outgrows the cap every read throws (the trigger-deliveries crash
 * loop) and memory scales with the store. `libs/core/jsonl-read.ts` reads by
 * purpose in fixed chunks instead. The gate counts whole-file JSONL reads per
 * production file and fails when a file gains one.
 *
 * Counted shapes (TypeScript AST, so strings and comments never match):
 *   - any call of `readJsonLines(...)` (foundation/json whole-file reader) or
 *     `readJsonLinesCached(...)` (jsonl-tail whole-file cache), by bare name
 *     or as a property (`json.readJsonLines(...)`);
 *   - `<expr>.split('\n')` / `.split(/\r?\n/)` (any string or regex literal
 *     containing a newline) whose receiver expression itself contains a call
 *     of `safeReadFile` / `safeReadFileSync` / `readTextFile` / `readFileSync`
 *     — only in files that mention a `.jsonl` path in a string literal, so
 *     splitting markdown or CSV text is not counted.
 *
 * Deliberately not counted (low false positives over full recall): a read
 * assigned to a variable and split in a later statement. Test files,
 * `__tests__/`, fixtures and build output are not scanned.
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
const GATE_ID = 'runtime-store-whole-read';
/** Same production roots as the runtime-store-retention gate. */
const DEFAULT_SCAN_ROOTS = ['libs', 'scripts', 'satellites', 'presence'];
const SOURCE_FILE = /\.[cm]?tsx?$/u;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$|\.d\.ts$/u;
const SKIPPED_SEGMENTS = new Set([
  '.next',
  '.turbo',
  '__tests__',
  'coverage',
  'dist',
  'fixtures',
  'node_modules',
  'test-results',
]);
const WHOLE_FILE_JSONL_READERS = new Set(['readJsonLines', 'readJsonLinesCached']);
const WHOLE_FILE_TEXT_READERS = new Set([
  'safeReadFile',
  'safeReadFileSync',
  'readTextFile',
  'readFileSync',
]);
const JSONL_PATH = /\.jsonl\b/u;

export const RUNTIME_STORE_WHOLE_READ_FIX_HINT = [
  'Read append-only JSONL stores by purpose with libs/core/jsonl-read.ts (size never makes a read fail):',
  '  - last record     → readLastJsonLine / readJsonLinesBackward',
  '  - recent window   → readJsonLinesSince(path, { cutoff, timeOf })',
  '  - full history    → streamJsonLines (constant memory, forward)',
  "Tolerate torn lines with { onMalformed: 'skip' } unless the store contract is strict.",
  'Bound growth at the writer with maintainStoreAfterAppend (libs/core/append-only-store.ts).',
].join('\n');

export interface WholeReadSite {
  file: string;
  line: number;
  text: string;
}

export interface WholeReadBaseline {
  version: 1;
  generated_at: string;
  total: number;
  files: Record<string, number>;
}

export interface WholeReadReport {
  baseline_path: string;
  total: number;
  baseline_total: number | null;
  files: Record<string, number>;
  sites: WholeReadSite[];
  violations: string[];
  /** Files whose count dropped below the baseline (the baseline can be lowered). */
  improved: string[];
}

function calleeName(node: ts.CallExpression): string | undefined {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

function isNewlineSeparator(node: ts.Expression | undefined): boolean {
  if (!node) return false;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.includes('\n');
  }
  if (ts.isRegularExpressionLiteral(node)) return node.text.includes('\\n');
  return false;
}

function containsWholeTextRead(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name && WHOLE_FILE_TEXT_READERS.has(name)) return true;
  }
  // Do not descend into nested functions: `.split` must apply to this read.
  if (ts.isFunctionLike(node)) return false;
  return ts.forEachChild(node, containsWholeTextRead) === true;
}

function mentionsJsonlPath(source: ts.SourceFile): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)) &&
      JSONL_PATH.test(node.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function findWholeStoreReads(repoRelativePath: string, text: string): WholeReadSite[] {
  const source = ts.createSourceFile(
    repoRelativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    repoRelativePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const jsonlFile = mentionsJsonlPath(source);
  const sites: WholeReadSite[] = [];
  const record = (node: ts.Node): void => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    sites.push({ file: repoRelativePath, line: line + 1, text: node.getText(source) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && WHOLE_FILE_JSONL_READERS.has(name)) record(node);
      else if (
        jsonlFile &&
        name === 'split' &&
        ts.isPropertyAccessExpression(node.expression) &&
        isNewlineSeparator(node.arguments[0]) &&
        containsWholeTextRead(node.expression.expression)
      )
        record(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

function listSourceFiles(scanRoots: string[], rootDir: string): string[] {
  const files: string[] = [];
  for (const root of scanRoots) {
    const absRoot = path.resolve(rootDir, root);
    if (!safeExistsSync(absRoot)) continue;
    for (const file of getAllFiles(absRoot)) {
      if (!SOURCE_FILE.test(file) || TEST_FILE.test(file)) continue;
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

export function scanWholeStoreReads(
  scanRoots: string[] = DEFAULT_SCAN_ROOTS,
  rootDir: string = ROOT
): WholeReadSite[] {
  return listSourceFiles(scanRoots, rootDir).flatMap((rel) =>
    findWholeStoreReads(rel, readRegularFile(path.resolve(rootDir, rel)))
  );
}

function countByFile(sites: WholeReadSite[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const site of sites) counts[site.file] = (counts[site.file] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function checkRuntimeStoreWholeRead(
  options: {
    baselinePath?: string;
    scanRoots?: string[];
    rootDir?: string;
    writeBaseline?: boolean;
  } = {}
): WholeReadReport {
  const baselinePath = options.baselinePath ?? resolveCiGateBaselinePath(GATE_ID);
  const sites = scanWholeStoreReads(options.scanRoots, options.rootDir);
  const files = countByFile(sites);
  const total = sites.length;

  if (options.writeBaseline) {
    const baseline: WholeReadBaseline = { version: 1, generated_at: nowIso(), total, files };
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

  const baseline = readSafeJsonFile<WholeReadBaseline>(
    baselinePath,
    'runtime store whole-read baseline'
  );
  const violations: string[] = [];
  const improved: string[] = [];
  for (const [file, count] of Object.entries(files)) {
    const allowed = baseline.files[file] ?? 0;
    if (count <= allowed) continue;
    violations.push(`${file}: ${count} whole-file JSONL read(s), baseline allows ${allowed}`);
    for (const site of sites.filter((entry) => entry.file === file)) {
      violations.push(
        `  ${site.file}:${site.line}  ${site.text.replace(/\s+/gu, ' ').slice(0, 160)}`
      );
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

export const runCheckRuntimeStoreWholeRead = defineScript({
  name: 'check:runtime-store-whole-read',
  flags: [],
  run(context) {
    const writeBaseline = context.argv.includes('--write-baseline');
    const report = checkRuntimeStoreWholeRead({ writeBaseline });

    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          'whole-file reads of JSONL stores increased:',
          ...report.violations,
          '',
          RUNTIME_STORE_WHOLE_READ_FIX_HINT,
        ].join('\n')
      );
    }

    if (writeBaseline) {
      context.print(`[check:runtime-store-whole-read] baseline written: ${report.total} read(s)`);
      return { report };
    }
    context.print(
      `[check:runtime-store-whole-read] OK (${report.total} whole-file JSONL read(s), baseline ${report.baseline_total})`
    );
    if (report.improved.length > 0) {
      context.print(
        `[check:runtime-store-whole-read] ${report.improved.length} file(s) dropped below the baseline — lower it with: node --import ./scripts/ts-loader.mjs scripts/check_runtime_store_whole_read.ts --write-baseline`
      );
    }
    return { report };
  },
});

if (
  isDirectScript(import.meta.url, 'check_runtime_store_whole_read.ts') ||
  isDirectScript(import.meta.url, 'check_runtime_store_whole_read.js')
)
  void runCheckRuntimeStoreWholeRead();
