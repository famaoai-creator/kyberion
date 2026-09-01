import path from 'node:path';
import { readJson } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReadFile, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type Layer = 'foundation' | 'contracts' | 'domain' | 'orchestration';
type BoundaryConfig = {
  layers: Layer[];
  patterns: Array<{ layer: Layer; pattern: string }>;
  facade_patterns?: string[];
  direction_exceptions?: Array<{
    source: string;
    target: string;
    reason: string;
  }>;
  default_layer: Layer;
};
type BoundaryBaseline = {
  version: 1;
  cycles: number;
  runtime_cycles?: number;
  max_runtime_scc_size?: number;
  direction_violations: number;
};
type DynamicImportEdge = { source: string; target: string };

const ROOT = pathResolver.rootDir();
const CONFIG_PATH = pathResolver.knowledge('product/governance/module-layer-boundaries.json');
const BASELINE_PATH = pathResolver.rootResolve('scripts/check_module_boundaries.baseline.json');
const SOURCE_ROOTS = ['libs', 'presence', 'satellites', 'scripts'];

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

function isFacade(filePath: string, manifest: BoundaryConfig): boolean {
  const repoPath = relative(filePath);
  return (manifest.facade_patterns || []).some((pattern) => matchesPattern(repoPath, pattern));
}

function directionExceptionFor(
  source: string,
  target: string,
  manifest: BoundaryConfig
): BoundaryConfig['direction_exceptions'][number] | undefined {
  return manifest.direction_exceptions?.find(
    (exception) =>
      matchesPattern(source, exception.source) && matchesPattern(target, exception.target)
  );
}

function sourceFiles(): string[] {
  return SOURCE_ROOTS.flatMap((root) => getAllFiles(pathResolver.rootResolve(root))).filter(
    (filePath) =>
      /\.[cm]?tsx?$/.test(filePath) &&
      !filePath.endsWith('.d.ts') &&
      !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(filePath) &&
      !filePath.includes(`${path.sep}dist${path.sep}`) &&
      !filePath.includes(`${path.sep}.next${path.sep}`)
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

/** Keep source offsets stable while removing comment text from import scans. */
export function maskComments(source: string): string {
  const chars = [...source];
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  let escaped = false;
  for (let index = 0; index < chars.length; index += 1) {
    const current = chars[index];
    const next = chars[index + 1];
    if (state === 'line') {
      if (current === '\n' || current === '\r') state = 'code';
      else chars[index] = ' ';
      continue;
    }
    if (state === 'block') {
      if (current === '*' && next === '/') {
        chars[index] = ' ';
        chars[index + 1] = ' ';
        index += 1;
        state = 'code';
      } else if (current !== '\n' && current !== '\r') {
        chars[index] = ' ';
      }
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'template') {
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (
        (state === 'single' && current === "'") ||
        (state === 'double' && current === '"') ||
        (state === 'template' && current === '`')
      ) {
        state = 'code';
      }
      continue;
    }
    if (current === '/' && next === '/') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'line';
    } else if (current === '/' && next === '*') {
      chars[index] = ' ';
      chars[index + 1] = ' ';
      index += 1;
      state = 'block';
    } else if (current === "'") {
      state = 'single';
    } else if (current === '"') {
      state = 'double';
    } else if (current === '`') {
      state = 'template';
    }
  }
  return chars.join('');
}

function importsFor(filePath: string, includeDynamic = false, includeTypeOnly = false): string[] {
  const text = maskComments(String(safeReadFile(filePath, { encoding: 'utf8' })));
  const imports: string[] = [];
  const staticPattern = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  const dynamicPattern = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of text.matchAll(staticPattern)) {
    // Type-only imports do not create runtime module edges or initialization
    // cycles. Keep mixed `export { type X, value }` statements as runtime
    // edges, but exclude the dedicated `import type` form.
    if (!includeTypeOnly && /\bimport\s+type\b/u.test(match[0])) continue;
    imports.push(match[1]);
  }
  // Test-only lazy imports exercise fixtures and optional dependencies rather
  // than production module boundaries; keep the ratchet focused on runtime
  // edges while still accounting for lazy imports in production code.
  if (includeDynamic && !filePath.endsWith('.test.ts') && !filePath.endsWith('.test.tsx')) {
    for (const match of text.matchAll(dynamicPattern)) {
      // `typeof import('...')` is a type query, not a runtime dependency. It
      // must not manufacture a runtime cycle (or a dynamic edge) for the
      // module that owns the type.
      const prefix = text.slice(0, match.index ?? 0);
      if (/typeof\s*$/u.test(prefix.slice(-12))) continue;
      imports.push(match[1]);
    }
  }
  return [...new Set(imports)];
}

function buildGraph(files: string[], includeDynamic = false): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const targets = importsFor(file, includeDynamic)
      .map((specifier) => resolveImport(file, specifier))
      .filter((target): target is string => Boolean(target));
    graph.set(file, targets);
  }
  return graph;
}

function collectDynamicImportEdges(files: string[]): DynamicImportEdge[] {
  const allGraph = buildGraph(files, true);
  const edges: DynamicImportEdge[] = [];
  for (const [source, targets] of allGraph) {
    // Compare against every static import, including type-only imports. The
    // runtime graph intentionally excludes type-only edges, but they are not
    // dynamic edges and must not be reported as such here.
    const staticTargets = new Set(
      importsFor(source, false, true)
        .map((specifier) => resolveImport(source, specifier))
        .filter((target): target is string => Boolean(target))
    );
    for (const target of targets) {
      if (!staticTargets.has(target)) {
        edges.push({ source: relative(source), target: relative(target) });
      }
    }
  }
  return edges.sort((left, right) =>
    `${left.source}->${left.target}`.localeCompare(`${right.source}->${right.target}`)
  );
}

function findCycles(graph: Map<string, string[]>): string[][] {
  // Tarjan's algorithm reports strongly connected components instead of
  // depending on whichever DFS path happened to encounter a cycle first.
  // This keeps static and dynamic graphs comparable and catches multi-node
  // cycles without enumerating exponentially many simple paths.
  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];

  const visit = (node: string): void => {
    indices.set(node, nextIndex);
    lowLinks.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of graph.get(node) || []) {
      if (!indices.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(target)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    let member: string | undefined;
    do {
      member = stack.pop();
      if (!member) break;
      onStack.delete(member);
      component.push(relative(member));
    } while (member !== node);

    const isSelfLoop = component.length === 1 && (graph.get(node) || []).includes(node);
    if (component.length > 1 || isSelfLoop) components.push(component.sort());
  };

  for (const file of graph.keys()) {
    if (!indices.has(file)) visit(file);
  }
  return components.sort((left, right) => left.join('|').localeCompare(right.join('|')));
}

function maxComponentSize(components: string[][]): number {
  return components.reduce((maximum, component) => Math.max(maximum, component.length), 0);
}

function findDirectionViolations(graph: Map<string, string[]>, manifest: BoundaryConfig): string[] {
  const rank = new Map(manifest.layers.map((layer, index) => [layer, index]));
  const violations: string[] = [];
  for (const [source, targets] of graph) {
    // Public API barrels intentionally compose every lower layer. Treating
    // those re-exports as implementation dependencies makes the boundary
    // checker report the facade itself as an inversion; consumers still get
    // checked at their actual implementation edges.
    if (isFacade(source, manifest)) continue;
    const sourceLayer = classify(source, manifest);
    for (const target of targets) {
      const targetLayer = classify(target, manifest);
      if (
        (rank.get(targetLayer) || 0) > (rank.get(sourceLayer) || 0) &&
        !directionExceptionFor(relative(source), relative(target), manifest)
      ) {
        violations.push(
          `${relative(source)} [${sourceLayer}] -> ${relative(target)} [${targetLayer}]`
        );
      }
    }
  }
  return violations.sort();
}

function findDirectionExceptions(
  graph: Map<string, string[]>,
  manifest: BoundaryConfig
): { active: string[]; stale: string[] } {
  const configured = manifest.direction_exceptions || [];
  const active = new Set<string>();
  const rank = new Map(manifest.layers.map((layer, index) => [layer, index]));

  for (const [source, targets] of graph) {
    const sourceRelative = relative(source);
    const sourceLayer = classify(source, manifest);
    for (const target of targets) {
      const targetRelative = relative(target);
      const targetLayer = classify(target, manifest);
      if ((rank.get(targetLayer) || 0) <= (rank.get(sourceLayer) || 0)) continue;
      const exception = directionExceptionFor(sourceRelative, targetRelative, manifest);
      if (exception) {
        active.add(`${exception.source} -> ${exception.target}`);
      }
    }
  }

  return {
    active: [...active].sort(),
    stale: configured
      .filter((exception) => !active.has(`${exception.source} -> ${exception.target}`))
      .map((exception) => `${exception.source} -> ${exception.target}: ${exception.reason}`)
      .sort(),
  };
}

export function checkModuleBoundaries(): {
  cycles: string[][];
  directionViolations: string[];
  directionExceptions: string[];
  staleDirectionExceptions: string[];
  dynamicImportEdges: DynamicImportEdge[];
  maxRuntimeSccSize: number;
  baseline: BoundaryBaseline;
  violations: string[];
} {
  const manifest = config();
  const files = sourceFiles();
  const graph = buildGraph(files);
  // Dynamic imports are runtime dependency edges too. Excluding them lets a
  // module hide a cycle behind `await import()` while the static graph stays
  // green. Test-only fixtures remain excluded by `buildGraph`'s production
  // edge policy.
  const runtimeGraph = buildGraph(files, true);
  const cycles = findCycles(graph);
  const runtimeCycles = findCycles(runtimeGraph);
  const maxRuntimeSccSize = maxComponentSize(runtimeCycles);
  const directionViolations = findDirectionViolations(runtimeGraph, manifest);
  const directionExceptions = findDirectionExceptions(runtimeGraph, manifest);
  const dynamicImportEdges = collectDynamicImportEdges(files);
  const baseline = safeExistsSync(BASELINE_PATH)
    ? readJson<BoundaryBaseline>(BASELINE_PATH)
    : {
        version: 1 as const,
        cycles: cycles.length,
        runtime_cycles: runtimeCycles.length,
        max_runtime_scc_size: maxRuntimeSccSize,
        direction_violations: directionViolations.length,
      };
  const violations: string[] = [];
  if (cycles.length > baseline.cycles)
    violations.push(`cycles increased from ${baseline.cycles} to ${cycles.length}`);
  if (baseline.runtime_cycles !== undefined && runtimeCycles.length > baseline.runtime_cycles) {
    violations.push(
      `runtime cycles increased from ${baseline.runtime_cycles} to ${runtimeCycles.length}`
    );
  }
  if (
    baseline.max_runtime_scc_size !== undefined &&
    maxRuntimeSccSize > baseline.max_runtime_scc_size
  ) {
    violations.push(
      `max runtime SCC size increased from ${baseline.max_runtime_scc_size} to ${maxRuntimeSccSize}`
    );
  }
  if (directionViolations.length > baseline.direction_violations) {
    violations.push(
      `direction violations increased from ${baseline.direction_violations} to ${directionViolations.length}`
    );
  }
  if (directionExceptions.stale.length > 0) {
    violations.push(
      `configured direction exceptions are stale or no longer forbidden: ${directionExceptions.stale.join('; ')}`
    );
  }
  return {
    cycles,
    directionViolations,
    directionExceptions: directionExceptions.active,
    staleDirectionExceptions: directionExceptions.stale,
    dynamicImportEdges,
    maxRuntimeSccSize,
    baseline,
    violations,
  };
}

export const runCheckModuleBoundaries = defineScript({
  name: 'check:module-boundaries',
  flags: [],
  run(context) {
    const writeBaseline = context.argv.includes('--write-baseline');
    const report = checkModuleBoundaries();
    if (writeBaseline) {
      withExecutionContext('ecosystem_architect', () =>
        safeWriteFile(
          BASELINE_PATH,
          JSON.stringify(
            {
              version: 1,
              cycles: report.cycles.length,
              runtime_cycles: findCycles(buildGraph(sourceFiles(), true)).length,
              max_runtime_scc_size: report.maxRuntimeSccSize,
              direction_violations: report.directionViolations.length,
            },
            null,
            2
          ) + '\n'
        )
      );
      context.print(
        `[check:module-boundaries] baseline written (${report.cycles.length} cycles, ${report.directionViolations.length} direction violations, ${report.directionExceptions.length} documented exceptions, max runtime SCC ${report.maxRuntimeSccSize})`
      );
      return;
    }
    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['FAILED', ...report.violations.map((violation) => `- ${violation}`)].join('\n')
      );
    }
    context.print(
      `[check:module-boundaries] OK (${report.cycles.length} cycles, ${report.directionViolations.length} direction violations, ${report.directionExceptions.length} documented exceptions, max runtime SCC ${report.maxRuntimeSccSize}, ${report.dynamicImportEdges.length} dynamic imports tracked)`
    );
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'check_module_boundaries.ts') ||
  isDirectScript(import.meta.url, 'check_module_boundaries.js')
)
  void runCheckModuleBoundaries();
