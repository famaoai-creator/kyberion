/**
 * OW-07: orphan ratchet. Fails when a NEW orphan appears:
 *
 *   (a) a libs/core module no non-test, non-barrel source imports (resolved
 *       specifier) and none of whose exported symbols another source imports
 *       by name (`import { name }`, `ns.name` on a namespace import, a
 *       destructured dynamic import or a non-barrel re-export) — a bare
 *       identifier that merely shares the name does not count;
 *   (b) a top-level scripts/*.ts nothing invokes — package.json, cli-commands,
 *       ci-gates, .github, pipelines, governance data or another source;
 *   (c) a top-level pipelines/*.json with no schedule and no reference from a
 *       source, data file or package.json. A declared `schedule` counts even
 *       when it ships `enabled: false`: such schedules are opt-in per host via
 *       KYBERION_CHRONOS_SCHEDULES, so they stay an operator-reachable entry
 *       point;
 *   (c') `documented_only`: a pipeline whose only mentions are Markdown docs
 *       (including its pipelines/README.md row) — runnable by hand, but no
 *       code, data or schedule invokes it, so each one carries a reason;
 *   (d) a registered actuator op referenced nowhere outside its own actuator,
 *       the op registry / discovery catalog and manifests — unless it is
 *       agent-callable: advertised in the agent-facing op catalog
 *       (actuator-op-discovery.json, rendered into CAPABILITIES_GUIDE.md) AND
 *       exercised by a unit test, or resolved at runtime by the pipeline
 *       provider bridge to a `cli_native` harness capability
 *       (harness-capabilities/*.json). A reference is a quoted `domain:op`, a
 *       bare `op: 'x'` / `action: 'x'` of a name only one domain registers,
 *       or a bare literal of a shared name in a file that targets that domain
 *       (names its `<domain>-actuator`, `actuator: '<domain>'` or a
 *       `<domain>:` op, or is a fragment file named `<domain>-*`). A test
 *       exercises an op through a quoted `domain:op` or, in the actuator's
 *       own tests, a step/action literal (`op: 'x'`, `action: 'x'`,
 *       `type: 'x'`) or a `dispatch*('x'` / `handleAction('x'` / `runOp('x'`
 *       call — any other quoted string equal to the op name does not count.
 *
 * A side-effect import (`import './x.js'`) counts as a caller even inside a
 * barrel: self-registering modules are loaded that way.
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
 * Placeholder "backlog" reasons are rejected too: every entry is a reviewed decision.
 */
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineCatalog, readTextFile, writeJson } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { withExecutionContext } from '@agent/core/governance';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

export const ORPHAN_KINDS = [
  'libs_core_modules',
  'scripts',
  'pipelines',
  'documented_only',
  'actuator_ops',
] as const;
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
  documented_only: OrphanBaselineEntry[];
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
/** Test-only roots: their test files can prove an op is exercised, never that code is used. */
const TEST_ROOTS = ['tests'];
const DATA_ROOTS = ['pipelines', '.github', 'knowledge/product'];
/** Markdown that may document how to run a pipeline (plans and archives excluded). */
const DOC_ROOTS = ['docs', 'knowledge/product', 'pipelines'];
const DOC_EXCLUDED = /^docs\/developer\/improvement-plans/u;
const ROOT_FILES = ['package.json'];
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?)$/u;
const DATA_EXT = /\.(?:json|ya?ml)$/u;
const TEST_FILE = /(?:\.test|\.spec)\.[cm]?[jt]sx?$|(?:^|\/)__tests__\//u;
const OP_DISCOVERY_PATH = 'knowledge/product/orchestration/actuator-op-discovery.json';
const OP_CATALOG_FILES = new Set([
  'knowledge/product/governance/actuator-op-registry.json',
  OP_DISCOVERY_PATH,
  ORPHAN_BASELINE_PATH,
]);
/** Ratchet inventories list paths to freeze them; a listing is not a caller. */
const INVENTORY_LEDGER_FILES = new Set(['knowledge/product/governance/shared-tmp-allowlist.json']);
const HARNESS_CAPABILITY_FILE =
  /^knowledge\/product\/governance\/harness-capabilities\/[^/]+\.json$/u;

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
/** `import './x.js';` — loads a module for its side effect (self-registration). */
const SIDE_EFFECT_IMPORT = /^\s*import\s*['"]([^'"\n]+)['"]/gmu;

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

const NAMED_IMPORT = /\bimport\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\b/gu;
const NAMESPACE_IMPORT = /\bimport\s+(?:type\s+)?\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/gu;
const REEXPORT_LIST = /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\b/gu;
const DYNAMIC_DESTRUCTURE =
  /\{([^{}]*)\}\s*=\s*(?:await\s+)?import\s*\(|\.then\s*\(\s*\(\s*\{([^{}]*)\}\s*\)\s*=>/gu;

function bindingNames(list: string): string[] {
  return list
    .split(',')
    .map((part) =>
      part
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+|\s*:\s*/u)[0]!
        .trim()
    )
    .filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name) && name !== 'default');
}

/**
 * Names a source imports from other modules: named imports, members read off a
 * namespace import, destructured dynamic imports and re-export lists.
 */
export function importedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(NAMED_IMPORT)) {
    for (const name of bindingNames(match[1]!)) names.add(name);
  }
  for (const match of source.matchAll(REEXPORT_LIST)) {
    for (const name of bindingNames(match[1]!)) names.add(name);
  }
  for (const match of source.matchAll(DYNAMIC_DESTRUCTURE)) {
    for (const name of bindingNames(match[1] ?? match[2] ?? '')) names.add(name);
  }
  for (const match of source.matchAll(NAMESPACE_IMPORT)) {
    const namespace = match[1]!.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const member = new RegExp(`(?<![\\w$])${namespace}\\.([A-Za-z_$][\\w$]*)`, 'gu');
    for (const access of source.matchAll(member)) names.add(access[1]!);
  }
  return names;
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

/** `domain:op` ids the agent-facing discovery catalog advertises (CAPABILITIES_GUIDE.md source). */
export function advertisedOps(discoveryJson: string | undefined): Set<string> {
  const ids = new Set<string>();
  try {
    const discovery = JSON.parse(discoveryJson ?? '{}') as {
      actuators?: Array<{ n?: unknown; ops?: Array<{ op?: unknown }> }>;
    };
    for (const actuator of discovery.actuators ?? []) {
      const domain = String(actuator.n ?? '').replace(/-actuator$/u, '');
      for (const entry of actuator.ops ?? []) {
        if (domain && typeof entry.op === 'string') ids.add(`${domain}:${entry.op}`);
      }
    }
  } catch {
    // Unreadable catalog: nothing is advertised, so nothing is excused.
  }
  return ids;
}

/**
 * `domain:op` ids the pipeline provider bridge resolves to a `cli_native`
 * harness capability (mirrors `resolveProviderCapabilityId`).
 */
export function providerBridgeOps(files: Iterable<readonly [string, string]>): Set<string> {
  const ids = new Set<string>();
  for (const [file, text] of files) {
    if (!HARNESS_CAPABILITY_FILE.test(file)) continue;
    try {
      const parsed = JSON.parse(text) as {
        capabilities?: Array<{ source?: { type?: unknown; provider?: unknown; name?: unknown } }>;
      };
      for (const capability of parsed.capabilities ?? []) {
        const source = capability.source;
        if (source?.type !== 'cli_native') continue;
        if (typeof source.provider !== 'string' || typeof source.name !== 'string') continue;
        ids.add(`${source.provider}:${source.name}`);
        ids.add(`${source.provider.replace('-cli', '')}:${source.name}`);
      }
    } catch {
      // A malformed capability file is the catalog gate's finding.
    }
  }
  return ids;
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
    // A barrel's re-exports are not callers, but its side-effect imports are.
    if (isCoreBarrel(file)) {
      for (const match of text.matchAll(SIDE_EFFECT_IMPORT)) {
        const resolved = resolveSpecifier(file, match[1]!, coreSubpaths);
        if (resolved && resolved !== file) importedPaths.add(resolved);
      }
    }
    if (isCoreBarrel(file)) continue;
    for (const name of importedNames(text)) {
      symbolDocs.set(name, (symbolDocs.get(name) ?? 0) + 1);
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
      const ownImports = importedNames(text);
      return !exportedSymbols(text).some(
        (symbol) => (symbolDocs.get(symbol) ?? 0) - (ownImports.has(symbol) ? 1 : 0) > 0
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
  //     in a source, data file or package.json; (c') docs-only mentions
  //     (Markdown, including the pipelines README) are reported separately.
  const pipelineRefs = new TokenIndex();
  for (const [file, text] of entries) {
    if (isTest(file) || INVENTORY_LEDGER_FILES.has(file)) continue;
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
  const pipelines: string[] = [];
  const documentedOnly: string[] = [];
  for (const file of usage.map(([candidate]) => candidate)) {
    if (!/^pipelines\/[^/]+\.json$/u.test(file)) continue;
    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(snapshot.files.get(file) ?? '') as Record<string, unknown>;
    } catch {
      // An unparsable pipeline is another gate's finding; treat it as unscheduled.
    }
    if (parsed.schedule && typeof parsed.schedule === 'object') continue;
    const name = path.posix.basename(file, '.json');
    const ids = [name, parsed.pipeline_id, parsed.id].filter(
      (value): value is string => typeof value === 'string' && value.length > 0
    );
    const referrers = [`${name}.json`, ...ids].flatMap((token) =>
      pipelineRefs.files(token).filter((other) => other !== file)
    );
    if (referrers.some((other) => !other.endsWith('.md'))) continue;
    (referrers.length > 0 ? documentedOnly : pipelines).push(file);
  }

  // (d) actuator ops: `"domain:op"` anywhere, or a bare `op: "name"` / `action: 'name'`
  //     (actuator-scoped ADF and payloads), outside the op's own actuator and catalogs.
  const qualifiedRefs = new TokenIndex();
  const bareRefs = new TokenIndex();
  const bareRefText = new Map<string, string>();
  for (const [file, text] of usage) {
    if (OP_CATALOG_FILES.has(file)) continue;
    if (/^libs\/actuators\/[^/]+\/(?:manifest\.json|src\/op-catalog\.ts)$/u.test(file)) continue;
    if (!(isSource(file) || DATA_EXT.test(file))) continue;
    for (const match of text.matchAll(QUALIFIED_OP_LITERAL)) qualifiedRefs.add(match[1]!, file);
    for (const match of text.matchAll(BARE_OP_LITERAL)) {
      bareRefs.add(match[1]!, file);
      bareRefText.set(file, text);
    }
  }
  // Agent-callable ops: advertised in the discovery catalog and exercised by a test.
  const advertised = advertisedOps(snapshot.files.get(OP_DISCOVERY_PATH));
  const bridged = providerBridgeOps(entries);
  const testQualifiedRefs = new TokenIndex();
  const testBareRefs = new TokenIndex();
  for (const [file, text] of entries) {
    if (!isTest(file)) continue;
    for (const match of text.matchAll(QUALIFIED_OP_LITERAL)) testQualifiedRefs.add(match[1]!, file);
    for (const match of text.matchAll(BARE_OP_LITERAL)) testBareRefs.add(match[1]!, file);
    for (const match of text.matchAll(DISPATCH_LITERAL)) {
      testBareRefs.add((match[1] ?? match[2])!, file);
    }
  }
  // How many domains register each op name: a bare literal of a name only one
  // domain registers is unambiguous; a shared name (`status`, `log`) is not.
  const opNameDomains = new Map<string, number>();
  for (const kinds of Object.values(snapshot.opDomains)) {
    for (const op of new Set(Object.values(kinds).flat())) {
      opNameDomains.set(op, (opNameDomains.get(op) ?? 0) + 1);
    }
  }
  const actuatorOps: string[] = [];
  for (const [domain, kinds] of Object.entries(snapshot.opDomains)) {
    const ownPrefix = `libs/actuators/${domain}-actuator/`;
    for (const op of sortUnique(Object.values(kinds).flat())) {
      const id = `${domain}:${op}`;
      const qualifiedOutside = qualifiedRefs.files(id).some((file) => !file.startsWith(ownPrefix));
      const bareOutside = bareRefs
        .files(op)
        .some(
          (file) =>
            !file.startsWith(ownPrefix) &&
            (opNameDomains.get(op) === 1 ||
              fileTargetsDomain(bareRefText.get(file) ?? '', domain, file))
        );
      if (qualifiedOutside || bareOutside || bridged.has(id)) continue;
      const tested =
        testQualifiedRefs.files(id).length > 0 ||
        testBareRefs.files(op).some((file) => file.startsWith(ownPrefix));
      if (advertised.has(id) && tested) continue;
      actuatorOps.push(id);
    }
  }

  return {
    libs_core_modules: sortUnique(libsCore),
    scripts: sortUnique(scripts),
    pipelines: sortUnique(pipelines),
    documented_only: sortUnique(documentedOnly),
    actuator_ops: sortUnique(actuatorOps),
  };
}

/** A quoted `domain:op` literal. */
const QUALIFIED_OP_LITERAL = /['"`]([\w-]+:[\w-]+)['"`]/gu;
/** A step / action literal: `op: 'x'`, `"action": "x"`. */
const BARE_OP_LITERAL = /\b(?:op|action)['"]?\s*:\s*['"]([\w-]+)['"]/gu;
/**
 * Test-side exercise of an op: an actuator dispatch / action handler call with
 * the op as its first argument (`dispatch('x'`, `handleAction('x'`, or the
 * test's `runOp('x'` / `runApply('x'` wrapper), or a computer-interaction
 * action literal (`type: 'x'`).
 */
const DISPATCH_LITERAL =
  /\b(?:dispatch\w*|handleAction|handle[A-Z]\w*Action|run(?:Op|Apply|Capture|Transform|Action))\s*\(\s*['"`]([\w-]+)['"`]|\btype['"]?\s*:\s*['"]([\w-]+)['"]/gu;

/**
 * True when a file addresses this actuator domain, so its bare `op: 'x'`
 * literals can be attributed to it: it names `<domain>-actuator`, declares
 * `actuator: '<domain>'`, uses a qualified `<domain>:` op, or is an
 * actuator-scoped fragment named `<domain>-*`.
 */
export function fileTargetsDomain(text: string, domain: string, file = ''): boolean {
  if (!text) return false;
  // Actuator-scoped ADF fragments are named after their actuator
  // (pipelines/fragments/browser-session-start.json → browser).
  if (path.posix.basename(file).startsWith(`${domain}-`)) return true;
  const escaped = domain.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return (
    text.includes(`${domain}-actuator`) ||
    new RegExp(`\\bactuator['"]?\\s*:\\s*['"]${escaped}['"]`, 'u').test(text) ||
    new RegExp(`['"\`]${escaped}:[\\w-]+['"\`]`, 'u').test(text)
  );
}

export interface OrphanComparison {
  added: OrphanReport;
  stale: OrphanReport;
  invalid: string[];
}

function emptyReport(): OrphanReport {
  return {
    libs_core_modules: [],
    scripts: [],
    pipelines: [],
    documented_only: [],
    actuator_ops: [],
  };
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
      } else if (/\bbacklog\b/iu.test(reason)) {
        comparison.invalid.push(
          `${kind}: ${entry.id} has a placeholder backlog reason — wire, retire or record the reviewed decision`
        );
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
  for (const root of TEST_ROOTS) {
    for (const file of getAllFiles(pathResolver.rootResolve(root))) {
      if (isSource(file) && isTest(file)) add(file);
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
