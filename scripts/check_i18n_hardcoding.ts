#!/usr/bin/env node
// I18N-03: ratchet against new hardcoded user-facing Japanese strings.
//
// Detection strategy (see docs/developer/improvement-plans-2026-07/
// INTERNATIONALIZATION_PLAN_2026-07-26.ja.md §2.4/§2.7 and the I18N-03 item
// in §4): flag a string literal / template literal part / JSX text node when
// it contains a Hiragana or Katakana character. Kanji-only strings are
// deliberately NOT flagged — kanji ranges show up constantly in regexes and
// character-class definitions across this codebase (including this file's
// own detection pattern), which would make kanji-based detection extremely
// noisy. Hiragana/Katakana are a much more reliable "this is Japanese prose,
// not a regex fragment" signal.
import * as path from 'node:path';
import ts from 'typescript';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeStat, safeReaddir } from '@agent/core/secure-io';
import { nowIso, readTextFile } from '@agent/core/foundation';
import {
  loadI18nHardcodingBaselineAtPath,
  writeI18nHardcodingBaselineAtPath,
  type I18nHardcodingBaseline,
} from '@agent/core/i18n-hardcoding-baseline';
import { getAllFiles } from '@agent/core/fs-utils';
import { withExecutionContext } from '@agent/core/governance';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';

const ROOT = pathResolver.rootDir();
const DEFAULT_BASELINE_PATH = resolveCiGateBaselinePath('i18n');

// The Hiragana block (U+3040-U+309F) and Katakana block (U+30A0-U+30FF) are
// contiguous, so a single range covers "Hiragana or Katakana". Written as a
// \u escape (not literal kana characters) so this detector's own source
// stays plain ASCII and cannot accidentally flag itself.
const KANA_PATTERN = /[\u3040-\u30ff]/u;

// Opt-out directive format: "// i18n-exempt: <reason>" on the same line as
// (or the line above) a flagged literal. The directive text itself is ASCII
// and never matches KANA_PATTERN, so it cannot exempt itself by accident.
const EXEMPT_COMMENT_PATTERN = /\/\/\s*i18n-exempt:\s*(.*)$/u;

// Scan each workspace package at its ROOT, not at <package>/src. Several
// packages keep user-facing code directly in the package directory —
// satellites/voice-hub/server.ts is the single largest offender in the tree —
// so a src-only scan would leave them permanently un-ratcheted. getAllFiles
// already skips node_modules/dist/build/.next via project_standards.ignore_dirs.
const GLOB_SCAN_PARENTS = [
  'libs/actuators',
  'satellites',
  'presence/displays',
  'presence/bridge',
  'presence/sensors',
];
const DIRECT_SCAN_ROOTS = ['libs/core', 'scripts'];

// Plan §2.7: sample code and dev-only tooling are explicitly out of scope.
const EXCLUDED_SUBTREE_PATTERNS = [/^libs\/core\/src\/native-[^/]+-engine\/examples\//u];

export function readI18nHardcodingTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

export type I18nHardcodingReport = {
  status: 'pass' | 'fail';
  checked_at: string;
  checked_files: number;
  baseline_path: string;
  total_violations: number;
  exemption_count: number;
  violations: string[];
  stale_entries: string[];
  updated_baseline: boolean;
};

export function isTestFile(repoRelativePath: string): boolean {
  return (
    /(^|\/)__tests__\//iu.test(repoRelativePath) ||
    /\.test\.[cm]?[jt]sx?$/iu.test(repoRelativePath) ||
    /\.spec\.[^/]*$/iu.test(repoRelativePath)
  );
}

export function isExcludedFile(repoRelativePath: string): boolean {
  if (isTestFile(repoRelativePath)) return true;
  return EXCLUDED_SUBTREE_PATTERNS.some((pattern) => pattern.test(repoRelativePath));
}

// Expands the glob-shaped scan targets (libs/actuators/<name>/src, etc) into concrete directories.
export function resolveDefaultScanRoots(): string[] {
  const roots: string[] = [];

  for (const relativeDir of DIRECT_SCAN_ROOTS) {
    const abs = pathResolver.rootResolve(relativeDir);
    if (safeExistsSync(abs)) roots.push(abs);
  }

  for (const parent of GLOB_SCAN_PARENTS) {
    const parentAbs = pathResolver.rootResolve(parent);
    if (!safeExistsSync(parentAbs)) continue;
    for (const entry of safeReaddir(parentAbs)) {
      const childAbs = path.join(parentAbs, entry);
      if (safeExistsSync(childAbs) && safeStat(childAbs).isDirectory()) {
        roots.push(childAbs);
      }
    }
  }

  return roots;
}

type FileScanResult = {
  count: number;
  exemptions: number;
};

/**
 * Scans a single file's AST for Hiragana/Katakana-bearing string literals,
 * template literal parts, and JSX text nodes. Comments are never visited
 * here — only literal AST nodes — so comment text can never contribute a
 * violation.
 */
export function scanFileForKanaLiterals(text: string, repoRelativePath: string): FileScanResult {
  const sourceFile = ts.createSourceFile(
    repoRelativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    repoRelativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const lines = text.split('\n');

  let count = 0;
  let exemptions = 0;

  function isExemptAtLine(lineIndex: number): boolean {
    const sameLine = lines[lineIndex] || '';
    const previousLine = lineIndex > 0 ? lines[lineIndex - 1] || '' : '';
    for (const candidate of [sameLine, previousLine]) {
      const match = EXEMPT_COMMENT_PATTERN.exec(candidate);
      if (match && match[1].trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  function visitLiteral(node: ts.Node, literalText: string): void {
    if (!KANA_PATTERN.test(literalText)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    if (isExemptAtLine(line)) {
      exemptions += 1;
      return;
    }
    count += 1;
  }

  function visit(node: ts.Node): void {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      visitLiteral(node, node.text);
    } else if (
      node.kind === ts.SyntaxKind.TemplateHead ||
      node.kind === ts.SyntaxKind.TemplateMiddle ||
      node.kind === ts.SyntaxKind.TemplateTail
    ) {
      visitLiteral(node, (node as ts.TemplateLiteralToken).text);
    } else if (ts.isJsxText(node)) {
      visitLiteral(node, node.getText(sourceFile));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { count, exemptions };
}

function scanTree(scanRoots: string[]): {
  currentCounts: Record<string, number>;
  scannedFiles: Set<string>;
  checkedFiles: number;
  exemptionCount: number;
} {
  const currentCounts: Record<string, number> = {};
  const scannedFiles = new Set<string>();
  let checkedFiles = 0;
  let exemptionCount = 0;

  for (const root of scanRoots) {
    if (!safeExistsSync(root)) continue;
    for (const filePath of getAllFiles(root)) {
      if (!/\.(?:ts|tsx)$/u.test(filePath)) continue;
      const repoRelativePath = path.relative(ROOT, filePath).split(path.sep).join('/');
      if (isExcludedFile(repoRelativePath)) continue;

      checkedFiles += 1;
      scannedFiles.add(repoRelativePath);
      const text = readI18nHardcodingTextFile(filePath);
      const { count, exemptions } = scanFileForKanaLiterals(text, repoRelativePath);
      exemptionCount += exemptions;
      if (count > 0) currentCounts[repoRelativePath] = count;
    }
  }

  return { currentCounts, scannedFiles, checkedFiles, exemptionCount };
}

function loadBaseline(baselinePath: string): I18nHardcodingBaseline | null {
  return loadI18nHardcodingBaselineAtPath(baselinePath);
}

function writeBaselineFile(
  baselinePath: string,
  baseline: I18nHardcodingBaseline,
  relativeScanRootsForNote: string[]
): void {
  withExecutionContext('ecosystem_architect', () => {
    writeI18nHardcodingBaselineAtPath(baselinePath, {
      ...baseline,
      scan_roots: relativeScanRootsForNote,
    });
  });
}

export function checkI18nHardcoding(
  options: {
    baselinePath?: string;
    scanRoots?: string[];
    updateBaseline?: boolean;
  } = {}
): I18nHardcodingReport {
  const baselinePath = options.baselinePath || DEFAULT_BASELINE_PATH;
  const scanRoots = options.scanRoots || resolveDefaultScanRoots();
  const relativeScanRoots = scanRoots.map((root) =>
    path.relative(ROOT, root).split(path.sep).join('/')
  );

  const { currentCounts, scannedFiles, checkedFiles, exemptionCount } = scanTree(scanRoots);
  const totalViolationsInTree = Object.values(currentCounts).reduce((sum, n) => sum + n, 0);

  if (options.updateBaseline) {
    const nextBaseline: I18nHardcodingBaseline = {
      version: 1,
      generated_at: nowIso(),
      scan_roots: relativeScanRoots,
      files: currentCounts,
    };
    writeBaselineFile(baselinePath, nextBaseline, relativeScanRoots);
    return {
      status: 'pass',
      checked_at: nextBaseline.generated_at,
      checked_files: checkedFiles,
      baseline_path: path.relative(ROOT, baselinePath),
      total_violations: totalViolationsInTree,
      exemption_count: exemptionCount,
      violations: [],
      stale_entries: [],
      updated_baseline: true,
    };
  }

  const checkedAt = nowIso();
  const baseline = loadBaseline(baselinePath);
  if (!baseline) {
    return {
      status: 'fail',
      checked_at: checkedAt,
      checked_files: checkedFiles,
      baseline_path: path.relative(ROOT, baselinePath),
      total_violations: totalViolationsInTree,
      exemption_count: exemptionCount,
      violations: [
        `baseline missing: ${path.relative(ROOT, baselinePath)} (run with --update-baseline to initialize)`,
      ],
      stale_entries: [],
      updated_baseline: false,
    };
  }

  const violations: string[] = [];
  const staleEntries: string[] = [];

  for (const [file, currentCount] of Object.entries(currentCounts)) {
    const baselineCount = baseline.files[file];
    if (baselineCount === undefined) {
      violations.push(`${file}: new file with ${currentCount} violation(s) (absent from baseline)`);
    } else if (currentCount > baselineCount) {
      violations.push(`${file}: increased from ${baselineCount} to ${currentCount}`);
    } else if (currentCount < baselineCount) {
      staleEntries.push(
        `${file}: decreased from ${baselineCount} to ${currentCount} (baseline is stale, run --update-baseline)`
      );
    }
  }

  for (const [file, baselineCount] of Object.entries(baseline.files)) {
    if (file in currentCounts) continue;
    if (!scannedFiles.has(file)) {
      // File no longer exists (or moved out of scan scope) — drop silently.
      continue;
    }
    // File still exists and was scanned, but now has zero violations.
    staleEntries.push(
      `${file}: decreased from ${baselineCount} to 0 (baseline is stale, run --update-baseline)`
    );
  }

  violations.sort();
  staleEntries.sort();

  return {
    status: violations.length === 0 && staleEntries.length === 0 ? 'pass' : 'fail',
    checked_at: checkedAt,
    checked_files: checkedFiles,
    baseline_path: path.relative(ROOT, baselinePath),
    total_violations: totalViolationsInTree,
    exemption_count: exemptionCount,
    violations,
    stale_entries: staleEntries,
    updated_baseline: false,
  };
}

function formatHumanReport(report: I18nHardcodingReport): string {
  if (report.updated_baseline) {
    return `[check:i18n] baseline updated: ${report.baseline_path} (${report.total_violations} violation(s) across ${report.checked_files} files scanned, ${report.exemption_count} exemption(s))`;
  }

  if (report.status === 'pass') {
    return `[check:i18n] OK (${report.checked_files} files scanned, ${report.total_violations} baseline-frozen violation(s), ${report.exemption_count} exemption(s))`;
  }

  const lines = ['violations detected:', ...report.violations.map((violation) => `- ${violation}`)];
  if (report.stale_entries.length > 0) {
    lines.push(
      '[check:i18n] baseline is stale, run --update-baseline:',
      ...report.stale_entries.map((entry) => `- ${entry}`)
    );
  }
  return lines.join('\n');
}

export const runCheckI18nHardcoding = defineScript({
  name: 'check:i18n',
  flags: ['json'],
  run(context) {
    const updateBaseline = context.argv.includes('--update-baseline');
    const asJson = context.json;
    const report = checkI18nHardcoding({ updateBaseline });

    if (asJson) {
      context.print(report);
    } else {
      const output = formatHumanReport(report);
      if (report.status === 'fail') throw new ScriptExitError(1, output);
      context.print(output);
    }

    if (report.status === 'fail') {
      throw new ScriptExitError(1);
    }
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'check_i18n_hardcoding.ts') ||
  isDirectScript(import.meta.url, 'check_i18n_hardcoding.js')
)
  void runCheckI18nHardcoding();
