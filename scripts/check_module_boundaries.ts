import path from 'node:path';
import { readJson } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import {
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  withExecutionContext,
} from '@agent/core';

type Layer = 'foundation' | 'contracts' | 'domain' | 'orchestration';
type BoundaryConfig = {
  layers: Layer[];
  patterns: Array<{ layer: Layer; pattern: string }>;
  default_layer: Layer;
};
type BoundaryBaseline = { version: 1; cycles: number; direction_violations: number };

const ROOT = pathResolver.rootDir();
const CONFIG_PATH = pathResolver.knowledge('product/governance/module-layer-boundaries.json');
const BASELINE_PATH = pathResolver.rootResolve('scripts/check_module_boundaries.baseline.json');

function relative(filePath: string): string {
  return path.relative(ROOT, filePath).split(path.sep).join('/');
}

function matchesPattern(value: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) return value.startsWith(pattern.slice(0, -2));
  if (!pattern.includes('*')) return value === pattern;
  const expression = new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]*')}$`
  );
  return expression.test(value);
}

function config(): BoundaryConfig {
  return readJson<BoundaryConfig>(CONFIG_PATH);
}

function classify(filePath: string, manifest: BoundaryConfig): Layer {
  const repoPath = relative(filePath);
  return (
    manifest.patterns.find((entry) => matchesPattern(repoPath, entry.pattern))?.layer ||
    manifest.default_layer
  );
}

function sourceFiles(): string[] {
  return getAllFiles(pathResolver.rootResolve('libs/core')).filter(
    (filePath) => /\.[cm]?tsx?$/.test(filePath) && !filePath.endsWith('.d.ts')
  );
}

function resolveImport(importer: string, specifier: string): string | undefined {
  let base: string;
  if (specifier.startsWith('.')) base = path.resolve(path.dirname(importer), specifier);
  else if (specifier === '@agent/core') base = pathResolver.rootResolve('libs/core/index');
  else if (specifier.startsWith('@agent/core/')) {
    base = pathResolver.rootResolve(`libs/core/${specifier.slice('@agent/core/'.length)}`);
  } else return undefined;

  const sourceBase = base.replace(/\.(?:[cm]?js|[cm]?ts|tsx)$/, '');
  const candidates = [
    base,
    sourceBase,
    `${sourceBase}.ts`,
    `${sourceBase}.tsx`,
    `${sourceBase}.mts`,
    path.join(sourceBase, 'index.ts'),
  ];
  return candidates.find((candidate) => safeExistsSync(candidate));
}

function importsFor(filePath: string): string[] {
  const text = String(safeReadFile(filePath, { encoding: 'utf8' }));
  const imports: string[] = [];
  const pattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function buildGraph(files: string[]): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const targets = importsFor(file)
      .map((specifier) => resolveImport(file, specifier))
      .filter((target): target is string => Boolean(target));
    graph.set(file, targets);
  }
  return graph;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles = new Set<string>();
  const stack: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      const cycle = stack.slice(start).concat(node).map(relative);
      const rotations = cycle
        .slice(0, -1)
        .map((_, index) => cycle.slice(index, -1).concat(cycle.slice(0, index)));
      const key = rotations.sort().at(0)?.join(' -> ');
      if (key) cycles.add(key);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const target of graph.get(node) || []) visit(target);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };
  for (const file of graph.keys()) visit(file);
  return Array.from(cycles).map((cycle) => cycle.split(' -> '));
}

function findDirectionViolations(graph: Map<string, string[]>, manifest: BoundaryConfig): string[] {
  const rank = new Map(manifest.layers.map((layer, index) => [layer, index]));
  const violations: string[] = [];
  for (const [source, targets] of graph) {
    const sourceLayer = classify(source, manifest);
    for (const target of targets) {
      const targetLayer = classify(target, manifest);
      if ((rank.get(targetLayer) || 0) > (rank.get(sourceLayer) || 0)) {
        violations.push(
          `${relative(source)} [${sourceLayer}] -> ${relative(target)} [${targetLayer}]`
        );
      }
    }
  }
  return violations.sort();
}

export function checkModuleBoundaries(): {
  cycles: string[][];
  directionViolations: string[];
  baseline: BoundaryBaseline;
  violations: string[];
} {
  const manifest = config();
  const graph = buildGraph(sourceFiles());
  const cycles = findCycles(graph);
  const directionViolations = findDirectionViolations(graph, manifest);
  const baseline = safeExistsSync(BASELINE_PATH)
    ? readJson<BoundaryBaseline>(BASELINE_PATH)
    : {
        version: 1 as const,
        cycles: cycles.length,
        direction_violations: directionViolations.length,
      };
  const violations: string[] = [];
  if (cycles.length > baseline.cycles)
    violations.push(`cycles increased from ${baseline.cycles} to ${cycles.length}`);
  if (directionViolations.length > baseline.direction_violations) {
    violations.push(
      `direction violations increased from ${baseline.direction_violations} to ${directionViolations.length}`
    );
  }
  return { cycles, directionViolations, baseline, violations };
}

export function main(): void {
  const writeBaseline = process.argv.includes('--write-baseline');
  const report = checkModuleBoundaries();
  if (writeBaseline) {
    withExecutionContext('ecosystem_architect', () =>
      safeWriteFile(
        BASELINE_PATH,
        JSON.stringify(
          {
            version: 1,
            cycles: report.cycles.length,
            direction_violations: report.directionViolations.length,
          },
          null,
          2
        ) + '\n'
      )
    );
    console.log(
      `[check:module-boundaries] baseline written (${report.cycles.length} cycles, ${report.directionViolations.length} direction violations)`
    );
    return;
  }
  if (report.violations.length > 0) {
    console.error('[check:module-boundaries] FAILED');
    for (const violation of report.violations) console.error(`- ${violation}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `[check:module-boundaries] OK (${report.cycles.length} cycles, ${report.directionViolations.length} direction violations)`
  );
}

if (process.argv[1]?.endsWith('check_module_boundaries.ts')) main();
