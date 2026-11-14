/**
 * Foundation weight ratchet.
 *
 * The modules almost every file imports (secure-io, path-resolver, logger,
 * libs/core/foundation/**, libs/core/contracts/**) must stay light: whatever
 * they import at runtime is loaded by everything above them. This gate
 * measures, from the compiled output (libs/core/dist — type-only imports are
 * already erased there), how many core modules each watched module pulls in
 * transitively, and fails when one grows past its baseline. A security or
 * domain rule added to a foundation module therefore has to raise the
 * baseline visibly in review. Lower counts print a hint to ratchet down.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { readTextFile, writeJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir, safeStat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from '../lib/harness.js';
import { resolveCiGateBaselinePath } from '../lib/ci-gate-baseline.js';
import { readSafeJsonFile } from '../lib/json-input.js';

export interface FoundationWeightBaseline {
  version: 1;
  /** Module path under libs/core (no extension) → maximum transitive runtime imports. */
  modules: Record<string, number>;
}

const DIST = 'libs/core/dist';
/** Individually watched flat modules; every module under these directories is watched too. */
const WATCHED_FILES = [
  'secure-io',
  'path-resolver',
  'logger',
  'fs-primitives',
  'platform-facts',
  'entity-scope',
];
const WATCHED_DIRS = ['foundation', 'contracts'];
const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\s*(?:[^'";]*?\s+from\s*)?['"](\.{1,2}\/[^'"]+)['"]/gu;
const BARREL = /^index(?:-part-\d+)?\.js$/u;

function listJs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const full = path.join(dir, entry);
    if (safeStat(full).isDirectory()) out.push(...listJs(full));
    else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) out.push(full);
  }
  return out;
}

/** Runtime import graph of the compiled core package, keyed by path relative to dist. */
export function buildRuntimeGraph(distRoot: string, read = readTextFile): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of listJs(distRoot)) {
    const rel = path.relative(distRoot, file).split(path.sep).join('/');
    const deps = new Set<string>();
    for (const match of read(file).matchAll(IMPORT_RE)) {
      const target = path.normalize(path.join(path.dirname(file), match[1]));
      const targetRel = path.relative(distRoot, target).split(path.sep).join('/');
      if (!BARREL.test(targetRel) && safeExistsSync(target)) deps.add(targetRel);
    }
    graph.set(rel, [...deps]);
  }
  return graph;
}

export function transitiveCount(graph: Map<string, string[]>, start: string): number {
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    for (const next of graph.get(queue.pop() as string) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  seen.delete(start);
  return seen.size;
}

export function measureFoundationWeight(graph: Map<string, string[]>): Record<string, number> {
  const watched = [...graph.keys()].filter(
    (rel) =>
      !BARREL.test(path.posix.basename(rel)) &&
      (WATCHED_FILES.includes(rel.replace(/\.js$/u, '')) ||
        WATCHED_DIRS.some((dir) => rel.startsWith(dir + '/')))
  );
  return Object.fromEntries(
    watched.sort().map((rel) => [rel.replace(/\.js$/u, ''), transitiveCount(graph, rel)] as const)
  );
}

export function compareFoundationWeight(
  counts: Record<string, number>,
  baseline: FoundationWeightBaseline
): { violations: string[]; lighter: string[] } {
  const violations: string[] = [];
  const lighter: string[] = [];
  for (const [module, count] of Object.entries(counts)) {
    const limit = baseline.modules[module];
    if (limit === undefined)
      violations.push(
        `${module}: pulls ${count} core modules but has no baseline entry — add it with --write-baseline`
      );
    else if (count > limit)
      violations.push(
        `${module}: now pulls ${count} core modules at runtime, baseline ${limit} (+${count - limit}) — keep domain rules out of foundation modules or raise the baseline in this change`
      );
    else if (count < limit) lighter.push(`${module}: ${count} < baseline ${limit}`);
  }
  return { violations: violations.sort(), lighter: lighter.sort() };
}

export const runCheckFoundationWeight = defineScript({
  name: 'check:foundation-weight',
  flags: [],
  run(context) {
    const distRoot = pathResolver.rootResolve(DIST);
    if (!safeExistsSync(path.join(distRoot, 'secure-io.js'))) {
      throw new ScriptExitError(
        1,
        `${DIST} is missing — foundation weight is measured on compiled output; run pnpm build first`
      );
    }
    const counts = measureFoundationWeight(buildRuntimeGraph(distRoot));
    const baselinePath = resolveCiGateBaselinePath('foundation-weight');
    if (context.unknownFlags.includes('--write-baseline')) {
      const next: FoundationWeightBaseline = { version: 1, modules: counts };
      withExecutionContext('ecosystem_architect', () => writeJson(baselinePath, next));
      context.print(
        `[check:foundation-weight] baseline written (${Object.keys(counts).length} modules)`
      );
      return { counts, violations: [], lighter: [] };
    }
    const baseline = readSafeJsonFile<FoundationWeightBaseline>(
      baselinePath,
      'foundation weight baseline'
    );
    const report = compareFoundationWeight(counts, baseline);
    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['foundation modules got heavier:', ...report.violations.map((line) => `- ${line}`)].join(
          '\n'
        )
      );
    }
    context.print(
      `[check:foundation-weight] OK (${Object.keys(counts).length} modules; secure-io pulls ${counts['secure-io'] ?? '?'})`
    );
    if (report.lighter.length > 0) {
      context.print(
        `[check:foundation-weight] lighter than baseline; lower it with --write-baseline:\n${report.lighter
          .map((line) => `- ${line}`)
          .join('\n')}`
      );
    }
    return { counts, ...report };
  },
});

if (
  isDirectScript(import.meta.url, 'check_foundation_weight.ts') ||
  isDirectScript(import.meta.url, 'check_foundation_weight.js')
)
  void runCheckFoundationWeight();
