#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { pathResolver, safeExistsSync, safeMkdir, safeReadFile, safeWriteFile } from '@agent/core';
import { getAllFiles } from '@agent/core/fs-utils';

const ROOT = pathResolver.rootDir();
const DEFAULT_BASELINE_PATH = pathResolver.rootResolve('scripts/check_type_ratchet.baseline.json');
const DEFAULT_SCAN_ROOTS = ['libs', 'scripts', 'satellites', 'presence', 'tests'];

// OP-03: the ratchet baselines are computed against the git-tracked tree.
// A Docker build context contains locally generated files the baseline has
// never seen, so counts diverge for environmental reasons, not type-safety
// regressions. Image builds skip with a loud notice; CI keeps enforcing.
if (process.env.KYBERION_SKIP_TYPE_RATCHET === '1') {
  console.log(
    '[check:type-ratchet] skipped (KYBERION_SKIP_TYPE_RATCHET=1 — image/context build; CI enforces the ratchet on the git tree)'
  );
  process.exit(0);
}

type RatchetBucket = {
  any_keywords: number;
  as_any: number;
  ts_ignore: number;
  files: number;
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

function emptyBucket(): RatchetBucket {
  return {
    any_keywords: 0,
    as_any: 0,
    ts_ignore: 0,
    files: 0,
  };
}

function incrementBucket(target: RatchetBucket, source: RatchetBucket): void {
  target.any_keywords += source.any_keywords;
  target.as_any += source.as_any;
  target.ts_ignore += source.ts_ignore;
  target.files += source.files;
}

function countFile(filePath: string, repoRelativePath: string): RatchetBucket {
  const bucket = emptyBucket();
  const text = String(safeReadFile(filePath, { encoding: 'utf8' }) as string);
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
  return JSON.parse(safeReadFile(baselinePath, { encoding: 'utf8' }) as string) as RatchetBaseline;
}

function compareBuckets(current: RatchetBucket, baseline: RatchetBucket, label: string): string[] {
  const violations: string[] = [];
  for (const key of ['any_keywords', 'as_any', 'ts_ignore', 'files'] as const) {
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
    safeMkdir(path.dirname(baselinePath), { recursive: true });
    safeWriteFile(baselinePath, JSON.stringify(current, null, 2));
    return {
      ...current,
      baseline_path: baselinePath,
      violations: [],
    };
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

export function main(): void {
  const writeBaseline = process.argv.includes('--write-baseline');
  const report = checkTypeRatchet({ writeBaseline });

  if (report.violations.length > 0) {
    console.error('[check:type-ratchet] violations detected:');
    for (const violation of report.violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log('[check:type-ratchet] OK');
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
