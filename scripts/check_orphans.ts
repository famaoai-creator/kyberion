/**
 * OW-07: orphan ratchet. Fails when a NEW orphan appears:
 *
 *   (a) a libs/core module no non-test, non-barrel source imports (resolved
 *       specifier) and whose exported symbols no other source uses;
 *   (b) a top-level scripts/*.ts nothing invokes — package.json, cli-commands,
 *       ci-gates, .github, pipelines, governance data or another source;
 *   (c) a top-level pipelines/*.json with no schedule, no reference and no
 *       pipelines/README.md row;
 *   (d) a registered actuator op referenced nowhere outside its own actuator,
 *       the op registry / discovery catalog and manifests.
 *
 * Known exceptions live in knowledge/product/governance/orphan-baseline.json,
 * one entry per orphan with a reason. A baseline entry that is no longer an
 * orphan is stale and fails too, so the list only shrinks.
 *
 *   pnpm check -- --only orphans
 *   node --import ./scripts/ts-loader.mjs scripts/check_orphans.ts [--json] [--update-baseline]
 *
 * `--update-baseline` keeps existing reasons, drops stale entries and adds new
 * orphans with a `TODO` reason, which the check rejects until a human writes one.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineCatalog, readTextFile, writeJson } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { withExecutionContext } from '@agent/core/governance';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const ORPHAN_KINDS = ['libs_core_modules', 'scripts', 'pipelines', 'actuator_ops'] as const;
export type OrphanKind = (typeof ORPHAN_KINDS)[number];
export type OrphanReport = Record<OrphanKind, string[]>;

export interface OrphanBaselineEntry {
  id: string;
  reason: string;
}

export interface OrphanBaseline {
  $schema?: string;
  version: number;
  description?: string;
  libs_core_modules: OrphanBaselineEntry[];
  scripts: OrphanBaselineEntry[];
  pipelines: OrphanBaselineEntry[];
  actuator_ops: OrphanBaselineEntry[];
}

/** Repository-relative POSIX path → text, for every file the analysis reads. */
export interface OrphanSnapshot {
  files: ReadonlyMap<string, string>;
  /** Actuator op registry `domains` (domain → capture/transform/apply op names). */
  opDomains: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>>;
}

export const ORPHAN_BASELINE_PATH = 'knowledge/product/governance/orphan-baseline.json';
const BASELINE_SCHEMA_PATH = 'knowledge/product/schemas/orphan-baseline.schema.json';
const TODO_REASON = 'TODO: explain why this orphan is kept, or wire/retire it';

const SOURCE_ROOTS = ['libs', 'scripts', 'satellites', 'presence', 'plugins'];
const DATA_ROOTS = ['pipelines', '.github', 'knowledge/product'];
/** Markdown that may document how to run a pipeline (plans and archives excluded). */
const DOC_ROOTS = ['docs', 'knowledge/product', 'pipelines'];
const DOC_EXCLUDED = /^docs\/developer\/improvement-plans/u;
const ROOT_FILES = ['package.json'];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/u;
const DATA_EXT = /\.(?:json|ya?ml)$/u;
const TEST_FILE = /(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//u;
const OP_CATALOG_FILES = new Set([
  'knowledge/product/governance/actuator-op-registry.json',
  'knowledge/product/orchestration/actuator-op-discovery.json',
  ORPHAN_BASELINE_PATH,
]);

function isSource(file: string): boolean {
  return SOURCE_EXT.test(file) && !file.endsWith('.d.ts');
}

function isTest(file: string): boolean {
  return TEST_FILE.test(file);
}

function isCoreBarrel(file: string): boolean {
  return /^libs\/core\/(?:.*\/)?index(?:-part-\d+)?\.ts$/u.test(file);
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bexport\s+\*\s+from\s*)['"]([^'"\n]+)['"]/gu;

/** `@agent/core/<subpath>` → source path, from the libs/core package exports. */
export function coreSubpathSources(packageJson: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const exports = (JSON.parse(packageJson ?? '{}') as { exports?: Record<string, unknown> })
      .exports;
    for (const [key, value] of Object.entries(exports ?? {})) {
      const target =
        typeof value === 'string'
          ? value
          : typeof (value as { default?: unknown })?.default === 'string'
            ? String((value as { default: string }).default)
            : undefined;
      if (!key.startsWith('./') || !target?.startsWith('./dist/')) continue;
      map.set(
        `@agent/core/${key.slice(2)}`,
        `libs/core/${target.slice('./dist/'.length).replace(/\.js$/u, '.ts')}`
      );
    }
  } catch {
    // Unreadable exports: fall back to the path-shaped mapping below.
  }
  return map;
}

/** Import specifiers resolved to repository paths (libs/core targets only). */
function resolveSpecifier(
  importer: string,
  specifier: string,
  coreSubpaths: ReadonlyMap<string, string>
): string | undefined {
  if (specifier.startsWith('@agent/core/')) {
    return coreSubpaths.get(specifier) ?? `libs/core/${specifier.slice('@agent/core/'.length)}.ts`;
  }
  if (!specifier.startsWith('.')) return undefined;
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(importer), specifier));
  return joined.replace(/\.(?:[cm]?js)$/u, '.ts').replace(/^(?!.*\.[cm]?tsx?$)(.*)$/u, '$1.ts');
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/gu;
const EXPORT_DECLARATION =
  /\bexport\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gu;
const EXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from)/gu;

export function exportedSymbols(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(EXPORT_DECLARATION)) names.add(match[1]!);
  for (const match of source.matchAll(EXPORT_LIST)) {
    for (const part of match[1]!.split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+/u)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/u.test(name) && name !== 'default') names.add(name);
    }
  }
  return [...names];
}

function sortUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/** token → files that mention it; built once so each lookup is O(1). */
class TokenIndex {
  private readonly index = new Map<string, Set<string>>();

  add(token: string, file: string): void {
    let files = this.index.get(token);
    if (!files) this.index.set(token, (files = new Set()));
    files.add(file);
  }

  files(token: string): string[] {
    return [...(this.index.get(token) ?? [])];
  }

  usedOutside(token: string, file: string): boolean {
    return this.files(token).some((other) => other !== file);
  }
}

export function findOrphans(snapshot: OrphanSnapshot): OrphanReport {
  // The baseline names every known orphan; it must never count as a reference.
  const entries = [...snapshot.files.entries()]
    .filter(([file]) => file !== ORPHAN_BASELINE_PATH)
    .map(([file, text]) => [file, text.replace(/\0/gu, '')] as const);
  const usage = entries.filter(([file]) => !isTest(file));

  // (a) libs/core modules.
  const coreSubpaths = coreSubpathSources(snapshot.files.get('libs/core/package.json'));
  const importedPaths = new Set<string>();
  const symbolDocs = new Map<string, number>();
  for (const [file, text] of usage) {
    if (!isSource(file)) continue;
    for (const match of text.matchAll(IMPORT_SPECIFIER)) {
      const resolved = resolveSpecifier(file, match[1]!, coreSubpaths);
      if (resolved && resolved !== file && !isCoreBarrel(file)) importedPaths.add(resolved);
    }
    if (isCoreBarrel(file)) continue;
    for (const identifier of new Set(text.match(IDENTIFIER) ?? [])) {
      symbolDocs.set(identifier, (symbolDocs.get(identifier) ?? 0) + 1);
    }
  }
  const coreModules = usage.filter(
    ([file]) =>
      file.startsWith('libs/core/') &&
      file.endsWith('.ts') &&
      !file.endsWith('.d.ts') &&
      !file.startsWith('libs/core/dist/') &&
      !isCoreBarrel(file)
  );
  const libsCore = coreModules
    .filter(([file, text]) => {
      if (importedPaths.has(file)) return false;
      const ownIdentifiers = new Set(text.match(IDENTIFIER) ?? []);
      return !exportedSymbols(text).some(
        (symbol) => (symbolDocs.get(symbol) ?? 0) - (ownIdentifiers.has(symbol) ? 1 : 0) > 0
      );
    })
    .map(([file]) => file);

  // (b) top-level scripts: referenced as `<name>.ts|.js|.mjs` or a `/…/<name>` specifier.
  const scriptRefs = new TokenIndex();
  for (const [file, text] of usage) {
    if (!(isSource(file) || DATA_EXT.test(file) || ROOT_FILES.includes(file))) continue;
    for (const match of text.matchAll(/([\w.-]+)\.(?:[cm]?[jt]s)\b/gu)) {
      scriptRefs.add(match[1]!, file);
    }
    for (const match of text.matchAll(/\/([\w.-]+)['"`]/gu)) scriptRefs.add(match[1]!, file);
  }
  const scripts = usage
    .map(([file]) => file)
    .filter((file) => /^scripts\/[^/]+\.ts$/u.test(file) && !file.endsWith('.d.ts'))
    .filter((file) => !scriptRefs.usedOutside(path.posix.basename(file, '.ts'), file));

  // (c) top-level pipelines: a schedule, a `<name>.json` mention, or a quoted id
  //     (sources, data, docs and the pipelines README).
  const pipelineRefs = new TokenIndex();
  for (const [file, text] of entries) {
    if (isTest(file)) continue;
    if (!(
      isSource(file) ||
      DATA_EXT.test(file) ||
      file.endsWith('.md') ||
      ROOT_FILES.includes(file)
    )) {
      continue;
    }
    for (const match of text.matchAll(/([\w.-]+)\.json\b/gu))
      pipelineRefs.add(`${match[1]!}.json`, file);
    for (const match of text.matchAll(/['"`]([\w.:-]+)['"`]/gu)) pipelineRefs.add(match[1]!, file);
  }
  const pipelines = usage
    .map(([file]) => file)
    .filter((file) => /^pipelines\/[^/]+\.json$/u.test(file))
    .filter((file) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(snapshot.files.get(file) ?? '') as Record<string, unknown>;
      } catch {
        // An unparsable pipeline is another gate's finding; treat it as unscheduled.
      }
      if (parsed.schedule && typeof parsed.schedule === 'object') return false;
      const name = path.posix.basename(file, '.json');
      const ids = [name, parsed.pipeline_id, parsed.id].filter(
        (value): value is string => typeof value === 'string' && value.length > 0
      );
      return ![`${name}.json`, ...ids].some((token) => pipelineRefs.usedOutside(token, file));
    });

  // (d) actuator ops: `"domain:op"` anywhere, or a bare `op: "name"` / `action: 'name'`
  //     (actuator-scoped ADF and payloads), outside the op's own actuator and catalogs.
  const qualifiedRefs = new TokenIndex();
  const bareRefs = new TokenIndex();
  for (const [file, text] of usage) {
    if (OP_CATALOG_FILES.has(file)) continue;
    if (/^libs\/actuators\/[^/]+\/(?:manifest\.json|src\/op-catalog\.ts)$/u.test(file)) continue;
    if (!(isSource(file) || DATA_EXT.test(file))) continue;
    for (const match of text.matchAll(/['"`]([\w-]+:[\w-]+)['"`]/gu))
      qualifiedRefs.add(match[1]!, file);
    for (const match of text.matchAll(/\b(?:op|action)['"]?\s*:\s*['"]([\w-]+)['"]/gu)) {
      bareRefs.add(match[1]!, file);
    }
  }
  const actuatorOps: string[] = [];
  for (const [domain, kinds] of Object.entries(snapshot.opDomains)) {
    const ownPrefix = `libs/actuators/${domain}-actuator/`;
    for (const op of sortUnique(Object.values(kinds).flat())) {
      const outside = (index: TokenIndex, token: string) =>
        index.files(token).some((file) => !file.startsWith(ownPrefix));
      if (!outside(qualifiedRefs, `${domain}:${op}`) && !outside(bareRefs, op)) {
        actuatorOps.push(`${domain}:${op}`);
      }
    }
  }

  return {
    libs_core_modules: sortUnique(libsCore),
    scripts: sortUnique(scripts),
    pipelines: sortUnique(pipelines),
    actuator_ops: sortUnique(actuatorOps),
  };
}

export interface OrphanComparison {
  added: OrphanReport;
  stale: OrphanReport;
  invalid: string[];
}

function emptyReport(): OrphanReport {
  return { libs_core_modules: [], scripts: [], pipelines: [], actuator_ops: [] };
}

export function compareWithBaseline(
  report: OrphanReport,
  baseline: OrphanBaseline
): OrphanComparison {
  const comparison: OrphanComparison = { added: emptyReport(), stale: emptyReport(), invalid: [] };
  for (const kind of ORPHAN_KINDS) {
    const listed = baseline[kind] ?? [];
    const ids = new Set<string>();
    for (const entry of listed) {
      if (ids.has(entry.id)) comparison.invalid.push(`${kind}: duplicate entry ${entry.id}`);
      ids.add(entry.id);
      const reason = String(entry.reason || '').trim();
      if (!reason || reason.startsWith('TODO')) {
        comparison.invalid.push(`${kind}: ${entry.id} needs a reason`);
      }
    }
    const current = new Set(report[kind]);
    comparison.added[kind] = report[kind].filter((id) => !ids.has(id));
    comparison.stale[kind] = sortUnique([...ids].filter((id) => !current.has(id)));
  }
  return comparison;
}

export function updatedBaseline(report: OrphanReport, baseline: OrphanBaseline): OrphanBaseline {
  const next: OrphanBaseline = { ...baseline };
  for (const kind of ORPHAN_KINDS) {
    const reasons = new Map((baseline[kind] ?? []).map((entry) => [entry.id, entry.reason]));
    next[kind] = report[kind].map((id) => ({ id, reason: reasons.get(id) ?? TODO_REASON }));
  }
  return next;
}

function relative(file: string): string {
  return path.relative(pathResolver.rootDir(), file).split(path.sep).join('/');
}

function readRegularFile(file: string): string | undefined {
  if (!safeExistsSync(file) || !safeLstat(file).isFile()) return undefined;
  return readTextFile(file);
}

export function loadOrphanSnapshot(): OrphanSnapshot {
  const files = new Map<string, string>();
  const add = (absolute: string) => {
    const repoPath = relative(absolute);
    if (repoPath.startsWith('retired/') || repoPath.includes('/node_modules/')) return;
    const text = readRegularFile(absolute);
    if (text !== undefined) files.set(repoPath, text);
  };
  for (const root of SOURCE_ROOTS) {
    for (const file of getAllFiles(pathResolver.rootResolve(root))) {
      if (isSource(file) || DATA_EXT.test(file)) add(file);
    }
  }
  for (const root of DATA_ROOTS) {
    for (const file of getAllFiles(pathResolver.rootResolve(root))) {
      if (DATA_EXT.test(file)) add(file);
    }
  }
  for (const root of DOC_ROOTS) {
    for (const file of getAllFiles(pathResolver.rootResolve(root))) {
      if (file.endsWith('.md') && !DOC_EXCLUDED.test(relative(file))) add(file);
    }
  }
  for (const file of ROOT_FILES) add(pathResolver.rootResolve(file));
  const registry = JSON.parse(
    files.get('knowledge/product/governance/actuator-op-registry.json') ?? '{}'
  ) as { domains?: OrphanSnapshot['opDomains'] };
  return { files, opDomains: registry.domains ?? {} };
}

const baselineCatalog = defineCatalog<OrphanBaseline>({
  id: 'orphan-baseline',
  path: () => pathResolver.rootResolve(ORPHAN_BASELINE_PATH),
  schema: pathResolver.rootResolve(BASELINE_SCHEMA_PATH),
});

export function loadOrphanBaseline(): OrphanBaseline {
  return baselineCatalog.load();
}

function formatList(title: string, report: OrphanReport): string[] {
  const lines: string[] = [];
  for (const kind of ORPHAN_KINDS) {
    for (const id of report[kind]) lines.push(`  ${title} ${kind}: ${id}`);
  }
  return lines;
}

export const runCheckOrphans = defineScript({
  name: 'check:orphans',
  flags: ['json'],
  run(context) {
    const report = findOrphans(loadOrphanSnapshot());
    const baseline = loadOrphanBaseline();
    if (context.argv.includes('--update-baseline')) {
      const next = updatedBaseline(report, baseline);
      withExecutionContext('ecosystem_architect', () =>
        writeJson(pathResolver.rootResolve(ORPHAN_BASELINE_PATH), next)
      );
      context.print(`[check:orphans] baseline written: ${ORPHAN_BASELINE_PATH}`);
      return next;
    }
    const comparison = compareWithBaseline(report, baseline);
    if (context.json) context.print(JSON.stringify({ report, comparison }, null, 2));
    const failures = [
      ...formatList('new', comparison.added),
      ...formatList('stale baseline', comparison.stale),
      ...comparison.invalid.map((line) => `  ${line}`),
    ];
    if (failures.length > 0) {
      throw new ScriptExitError(
        1,
        [
          '[check:orphans] orphan ratchet failed — wire the item to a caller, retire it to retired/ (README row), or record a reasoned exception in ' +
            `${ORPHAN_BASELINE_PATH}; remove stale baseline entries:`,
          ...failures,
        ].join('\n')
      );
    }
    const total = ORPHAN_KINDS.reduce((sum, kind) => sum + report[kind].length, 0);
    if (!context.json) {
      context.print(`[check:orphans] OK (${total} known exceptions, no new orphans)`);
    }
    return { report, comparison };
  },
});

if (
  isDirectScript(import.meta.url, 'check_orphans.ts') ||
  isDirectScript(import.meta.url, 'check_orphans.js')
)
  void runCheckOrphans();
