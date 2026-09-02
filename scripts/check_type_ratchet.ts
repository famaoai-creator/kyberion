#!/usr/bin/env node
import * as path from 'node:path';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import ts from 'typescript';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { withExecutionContext } from '@agent/core/governance';
import { getRegisteredEnvText, readJson } from '@agent/core/foundation';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';

const ROOT = pathResolver.rootDir();
const DEFAULT_BASELINE_PATH = resolveCiGateBaselinePath('type-ratchet');
const DEFAULT_SCAN_ROOTS = ['libs', 'scripts', 'satellites', 'presence', 'tests'];

// OP-03: the ratchet baselines are computed against the git-tracked tree.
// A Docker build context contains locally generated files the baseline has
// never seen, so counts diverge for environmental reasons, not type-safety
// regressions. Image builds skip with a loud notice; CI keeps enforcing.
type RatchetBucket = {
  any_keywords: number;
  as_any: number;
  ts_ignore: number;
  files: number;
  max_lines: number;
};

type RatchetBaseline = {
  version: 1;
  generated_at: string;
  counts: {
    src: RatchetBucket;
    test: RatchetBucket;
  };
};

type RatchetReport = RatchetBaseline & {
  baseline_path: string;
  violations: string[];
};

function isTestFile(repoRelativePath: string): boolean {
  return (
    /(^|\/)(?:__tests__|tests?)\//i.test(repoRelativePath) ||
    /\.test\.[cm]?[jt]sx?$/i.test(repoRelativePath)
  );
}

function isGeneratedFile(repoRelativePath: string): boolean {
  const segments = repoRelativePath.split('/');
  return (
    /^libs\/core\/index-part-\d+\.ts$/u.test(repoRelativePath) ||
    repoRelativePath === 'libs/core/vocabulary-keys.generated.ts' ||
    segments.some((segment) =>
      new Set(['.next', '.turbo', 'coverage', 'dist', 'node_modules', 'test-results']).has(segment)
    ) ||
    repoRelativePath.endsWith('/next-env.d.ts')
  );
}

function emptyBucket(): RatchetBucket {
  return {
    any_keywords: 0,
    as_any: 0,
    ts_ignore: 0,
    files: 0,
    max_lines: 0,
  };
}

function incrementBucket(target: RatchetBucket, source: RatchetBucket): void {
  target.any_keywords += source.any_keywords;
  target.as_any += source.as_any;
  target.ts_ignore += source.ts_ignore;
  target.files += source.files;
  target.max_lines = Math.max(target.max_lines, source.max_lines);
}

function countFile(filePath: string, repoRelativePath: string): RatchetBucket {
  const bucket = emptyBucket();
  const text = String(safeReadFile(filePath, { encoding: 'utf8' }) as string);
  bucket.max_lines = text.split(/\r?\n/u).length;
  const source = ts.createSourceFile(
    repoRelativePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    repoRelativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      bucket.any_keywords += 1;
    }
    if (ts.isAsExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword) {
      bucket.as_any += 1;
    }
    if (ts.isTypeAssertionExpression(node) && node.type.kind === ts.SyntaxKind.AnyKeyword) {
      bucket.as_any += 1;
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  bucket.ts_ignore = (text.match(/@ts-ignore\b/g) || []).length;
  bucket.files = 1;
  return bucket;
}

function scanCurrentCounts(scanRoots: string[]): RatchetBaseline {
  const src = emptyBucket();
  const test = emptyBucket();

  for (const root of scanRoots) {
    const absRoot = pathResolver.rootResolve(root);
    if (!safeExistsSync(absRoot)) continue;
    for (const file of getAllFiles(absRoot)) {
      if (!/\.[cm]?[jt]sx?$/.test(file) || file.endsWith('.d.ts')) continue;
      const repoRelativePath = path.relative(ROOT, file).split(path.sep).join('/');
      if (isGeneratedFile(repoRelativePath)) continue;
      const counts = countFile(file, repoRelativePath);
      if (isTestFile(repoRelativePath)) {
        incrementBucket(test, counts);
      } else {
        incrementBucket(src, counts);
      }
    }
  }

  return {
    version: 1,
    generated_at: new Date().toISOString(),
    counts: { src, test },
  };
}

function loadBaseline(baselinePath: string): RatchetBaseline | null {
  if (!safeExistsSync(baselinePath)) return null;
  return readJson<RatchetBaseline>(baselinePath);
}

function compareBuckets(current: RatchetBucket, baseline: RatchetBucket, label: string): string[] {
  const violations: string[] = [];
  // File count is descriptive, not a type-safety regression: a real
  // responsibility split necessarily adds modules. New-module size is
  // enforced independently by check:max-file-lines.
  for (const key of ['any_keywords', 'as_any', 'ts_ignore', 'max_lines'] as const) {
    if (current[key] > baseline[key]) {
      violations.push(`${label}.${key} increased from ${baseline[key]} to ${current[key]}`);
    }
  }
  return violations;
}

export function checkTypeRatchet(
  options: {
    baselinePath?: string;
    scanRoots?: string[];
    writeBaseline?: boolean;
  } = {}
): RatchetReport {
  const baselinePath = options.baselinePath || DEFAULT_BASELINE_PATH;
  const current = scanCurrentCounts(options.scanRoots || DEFAULT_SCAN_ROOTS);
  const baseline = loadBaseline(baselinePath);

  if (options.writeBaseline) {
    return withExecutionContext('ecosystem_architect', () => {
      safeMkdir(path.dirname(baselinePath), { recursive: true });
      safeWriteFile(baselinePath, JSON.stringify(current, null, 2));
      return {
        ...current,
        baseline_path: baselinePath,
        violations: [],
      };
    });
  }

  if (!baseline) {
    return {
      ...current,
      baseline_path: baselinePath,
      violations: [
        `baseline missing: ${path.relative(ROOT, baselinePath)} (run with --write-baseline to initialize)`,
      ],
    };
  }

  const violations = [
    ...compareBuckets(current.counts.src, baseline.counts.src, 'src'),
    ...compareBuckets(current.counts.test, baseline.counts.test, 'test'),
  ];

  return {
    ...current,
    baseline_path: baselinePath,
    violations,
  };
}

export const runCheckTypeRatchet = defineScript({
  name: 'check:type-ratchet',
  flags: [],
  run(context) {
    if (getRegisteredEnvText('KYBERION_SKIP_TYPE_RATCHET') === '1') {
      context.print(
        '[check:type-ratchet] skipped (KYBERION_SKIP_TYPE_RATCHET=1 — image/context build; CI enforces the ratchet on the git tree)'
      );
      return;
    }
    const writeBaseline = context.argv.includes('--write-baseline');
    const report = checkTypeRatchet({ writeBaseline });

    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['violations detected:', ...report.violations.map((violation) => `- ${violation}`)].join(
          '\n'
        )
      );
    }

    context.print('[check:type-ratchet] OK');
    return { report };
  },
});

if (
  isDirectScript(import.meta.url, 'check_type_ratchet.ts') ||
  isDirectScript(import.meta.url, 'check_type_ratchet.js')
)
  void runCheckTypeRatchet();
