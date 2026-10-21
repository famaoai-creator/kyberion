/** AST-based, per-file budgets for the CX consolidation rollout. */
import ts from 'typescript';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeReaddir, safeLstat } from '@agent/core/secure-io';
import { isDirectScript, ScriptExitError } from './lib/harness.js';
import { defineCheck } from '@agent/core/check-harness';
import { readSafeJsonFile } from './lib/json-input.js';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';

export const METRICS = [
  'env_direct_read_budget',
  'json_state_write_budget',
  'runtime_path_literal_budget',
  'rate_limiter_impl_budget',
  'exported_type_name_duplication_budget',
  'bespoke_cli_parser_budget',
] as const;
export type ConceptMetric = (typeof METRICS)[number];
export type ConceptCounts = Record<ConceptMetric, number>;
export interface ConceptBaseline {
  version: 1;
  files: Record<string, Partial<ConceptCounts>>;
  exported_types?: Record<string, string[]>;
}
// Canonical implementations contain these concepts by design. No consumer exemption.
const CANONICAL: Partial<Record<ConceptMetric, readonly string[]>> = {
  runtime_path_literal_budget: ['libs/core/foundation/runtime-state-roots.ts'],
  rate_limiter_impl_budget: ['libs/core/foundation/rate-limit.ts', 'libs/core/failure-tracker.ts'],
  bespoke_cli_parser_budget: [
    'libs/core/cli-guard.ts',
    'libs/core/command-harness.ts',
    'libs/core/check-harness.ts',
  ],
};
const CONTEXT_ENV = new Set(['KYBERION_TENANT', 'KYBERION_PERSONA', 'MISSION_ROLE', 'MISSION_ID']);
export function countConcepts(source: string, filename = 'input.ts'): ConceptCounts {
  const result = Object.fromEntries(METRICS.map((k) => [k, 0])) as ConceptCounts;
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const declarations = new Map<ts.Node, Map<string, ts.Expression>>();
  const scopeFor = (node: ts.Node): ts.Node => {
    let parent = node.parent;
    while (parent && !ts.isBlock(parent) && !ts.isSourceFile(parent)) parent = parent.parent;
    return parent ?? file;
  };
  const index = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const scope = scopeFor(node);
      const entries = declarations.get(scope) ?? new Map<string, ts.Expression>();
      entries.set(node.name.text, node.initializer);
      declarations.set(scope, entries);
    }
    ts.forEachChild(node, index);
  };
  index(file);
  const callName = (node: ts.CallExpression) =>
    ts.isIdentifier(node.expression)
      ? node.expression.text
      : ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name.text
        : '';
  const containsStringify = (node: ts.Node, seen = new Set<ts.Node>()): boolean => {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      let scope: ts.Node | undefined = scopeFor(node);
      while (scope) {
        const value = declarations.get(scope)?.get(node.text);
        if (value) return containsStringify(value, seen);
        scope = scope === file ? undefined : scopeFor(scope);
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(file) === 'JSON' &&
      node.expression.name.text === 'stringify'
    )
      return true;
    return ts.forEachChild(node, (child) => containsStringify(child, seen)) === true;
  };
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer?.getText(file) === 'process.env'
    ) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        if ((ts.isIdentifier(key) || ts.isStringLiteralLike(key)) && CONTEXT_ENV.has(key.text))
          result.env_direct_read_budget++;
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(file) === 'process.env' &&
      CONTEXT_ENV.has(node.name.text)
    )
      result.env_direct_read_budget++;
    if (
      ts.isElementAccessExpression(node) &&
      node.expression.getText(file) === 'process.env' &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      CONTEXT_ENV.has(node.argumentExpression.text)
    )
      result.env_direct_read_budget++;
    if (ts.isCallExpression(node)) {
      const name = callName(node);
      if (
        /^getRegisteredEnv(?:Text|Value|Boolean)?$/.test(name) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        CONTEXT_ENV.has(node.arguments[0].text)
      )
        result.env_direct_read_budget++;
      // Serialization at a write site is an indicator, not proof that the target is state.
      if (
        /^(?:safeWriteFile|writeFile|writeFileSync)$/.test(name) &&
        node.arguments.slice(1).some((arg) => containsStringify(arg))
      )
        result.json_state_write_budget++;
      if (
        (name === 'indexOf' || name === 'includes') &&
        ts.isPropertyAccessExpression(node.expression) &&
        /(?:argv|args)(?:\b|\.)/.test(node.expression.expression.getText(file)) &&
        node.arguments[0] &&
        ts.isStringLiteralLike(node.arguments[0]) &&
        node.arguments[0].text.startsWith('--')
      )
        result.bespoke_cli_parser_budget++;
    }
    if (ts.isStringLiteralLike(node) && node.text.includes('active/shared/' + 'runtime/'))
      result.runtime_path_literal_budget++;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        (ts.isVariableDeclaration(node) &&
          node.initializer &&
          (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)))) &&
      node.name &&
      /(?:rateLimit|RateLimit|fixedWindow|FixedWindow|FailureTracker|failureTracker)/.test(
        node.name.getText(file)
      )
    )
      result.rate_limiter_impl_budget++;
    // Track canonical vocabulary declarations, not unrelated same-name domain contracts.
    if (
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      ['MissionStatus', 'KnowledgeTier', 'PipelineStep'].includes(node.name.text) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      result.exported_type_name_duplication_budget++;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return result;
}

export function collectConceptCounts(root: string): ConceptBaseline {
  const files: ConceptBaseline['files'] = {};
  const declarations = new Map<string, Set<string>>();
  const walk = (dir: string): string[] =>
    safeReaddir(dir).flatMap((entry) => {
      if (['dist', 'node_modules', '.next', 'coverage', '.git'].includes(entry)) return [];
      const p = path.join(dir, entry);
      const stat = safeLstat(p);
      return stat.isSymbolicLink() ? [] : stat.isDirectory() ? walk(p) : [p];
    });
  for (const dir of ['libs', 'scripts', 'presence', 'satellites']) {
    for (const filename of walk(path.join(root, dir))) {
      if (
        !/\.[cm]?[jt]sx?$/.test(filename) ||
        /(?:^|\/)(?:dist|node_modules|\.next|coverage)(?:\/|$)/.test(filename) ||
        /\.(?:test|spec)\.|\.d\.ts$|\.generated\./.test(filename)
      )
        continue;
      const relative = path.relative(root, filename).split(path.sep).join('/');
      const source = String(safeReadFile(filename, { encoding: 'utf8' }));
      if (
        /This file was automatically generated|DO NOT EDIT.*generated/i.test(source.slice(0, 600))
      )
        continue;
      const counts = countConcepts(source, filename);
      counts.exported_type_name_duplication_budget = 0;
      const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
      for (const node of ast.statements) {
        if (
          (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
          node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
        ) {
          const sites = declarations.get(node.name.text) ?? new Set<string>();
          sites.add(relative);
          declarations.set(node.name.text, sites);
        }
      }
      for (const key of METRICS) if (CANONICAL[key]?.includes(relative)) counts[key] = 0;
      if (METRICS.some((k) => counts[k] > 0)) files[relative] = counts;
    }
  }
  for (const [name, sites] of declarations) {
    const threshold = ['MissionStatus', 'KnowledgeTier', 'PipelineStep'].includes(name) ? 2 : 3;
    if (sites.size < threshold) continue;
    for (const file of sites) {
      files[file] ??= {};
      files[file].exported_type_name_duplication_budget =
        (files[file].exported_type_name_duplication_budget ?? 0) + 1;
    }
  }
  return {
    version: 1,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
    exported_types: Object.fromEntries(
      [...declarations]
        .filter(
          ([name, sites]) =>
            sites.size >=
            (['MissionStatus', 'KnowledgeTier', 'PipelineStep'].includes(name) ? 2 : 3)
        )
        .map(([name, sites]) => [name, [...sites].sort()])
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
    ),
  };
}

export function conceptViolations(
  current: ConceptBaseline,
  baseline: ConceptBaseline,
  metric?: ConceptMetric
): string[] {
  const violations: string[] = [];
  for (const [file, counts] of Object.entries(current.files)) {
    for (const key of metric ? [metric] : METRICS) {
      const budget = baseline.files[file]?.[key] ?? 0;
      if ((counts[key] ?? 0) > budget)
        violations.push(`${file}: ${key} ${counts[key]} exceeds ${budget}`);
    }
  }
  if (!metric || metric === 'exported_type_name_duplication_budget') {
    for (const [name, sites] of Object.entries(current.exported_types ?? {})) {
      const allowed = new Set(baseline.exported_types?.[name] ?? []);
      for (const site of sites)
        if (!allowed.has(site)) violations.push(`${site}: new duplicated exported type ${name}`);
    }
  }
  return violations;
}

const run = defineCheck({
  id: 'concept-consolidation',
  options: [{ flag: '--metric', value: 'id' }],
  collect(context) {
    const metric = context.options['--metric'] as ConceptMetric | undefined;
    if (metric !== undefined && !METRICS.includes(metric))
      throw new ScriptExitError(2, 'Unknown consolidation metric');
    const baselinePath = resolveCiGateBaselinePath(metric ?? 'env_direct_read_budget');
    const baseline = readSafeJsonFile<ConceptBaseline>(
      baselinePath,
      'concept consolidation baseline'
    );
    if (baseline.version !== 1 || !baseline.files)
      throw new Error('Invalid concept consolidation baseline');
    const findings = conceptViolations(
      collectConceptCounts(pathResolver.rootDir()),
      baseline,
      metric
    );
    return findings.map((message) => ({ code: 'CX_BUDGET_EXCEEDED', message }));
  },
});
if (
  isDirectScript(import.meta.url, 'check_concept_consolidation.ts') ||
  isDirectScript(import.meta.url, 'check_concept_consolidation.js')
)
  void run();
