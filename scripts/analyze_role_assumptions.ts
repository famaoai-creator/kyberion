/**
 * RN-02: call-level static analysis of in-process role assumption.
 *
 * role-assumption-policy.json bounds which roles a SYSTEM_ROLE process may
 * assume with withExecutionContext / withExecutionContextAsync. Its first
 * lists came from module-level reachability, so every surface was granted the
 * broad roles any libs/core module assumes. This script narrows the evidence
 * to top-level declarations:
 *
 *  1. It collects every withExecutionContext* call and resolves the role
 *     argument (a literal, a union of literals via the type checker, or a role
 *     forwarded through wrapper parameters such as the governed-artifact
 *     writers). Anything it cannot resolve is an "any role" site.
 *  2. It builds a reference graph between top-level declarations (functions,
 *     classes, function-valued consts) and module initialisation code,
 *     following imports, re-exports, function references and class members.
 *  3. From each surface entry point (surface manifests, surface_runtime,
 *     config_mission / run_pipeline) it walks the graph, plus the child
 *     processes those entry points spawn with an inherited SYSTEM_ROLE, and
 *     reports per system role the reachable roles (with one example path) and
 *     the policy roles that are not reachable.
 *
 * It errs towards reachability: a referenced declaration is reachable whether
 * it is called or passed around, a referenced class brings all its members,
 * nested functions follow their container, module initialisation code runs
 * whenever the module is imported, all exports of an entry file and of a
 * dynamically imported or namespace-used module are reachable, and an
 * unresolved dynamic import or an unresolved child process that inherits
 * SYSTEM_ROLE is reported as an "any role" site.
 *
 * The report is checked in at docs/developer/role-assumption-reachability.json.
 * `--check` (the `role-assumption-reachability` CI gate) fails when it is
 * stale; scripts/analyze_role_assumptions.contract.test.ts fails when a
 * reachable role is missing from role-assumption-policy.json.
 */
import * as path from 'node:path';
import * as ts from 'typescript';
import { parseSafeJsonInput, readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir, safeStat } from '@agent/core/secure-io';
import { defineGenerator, isDirectScript } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

export const REACHABILITY_REPORT_PATH = 'docs/developer/role-assumption-reachability.json';
const POLICY_PATH = 'knowledge/product/governance/role-assumption-policy.json';
const SURFACE_MANIFEST_DIR = 'knowledge/product/governance/surfaces';

/** System roles set by launchers other than the surface manifests (AUTHORITY_MODEL.md 3.B2). */
const EXTRA_SYSTEM_ROLE_ENTRIES: Record<string, string[]> = {
  surface_runtime: ['scripts/surface_runtime.ts'],
  system_configurator: ['scripts/config_mission.ts', 'scripts/run_pipeline.ts'],
};

const ASSUMPTION_FUNCTIONS = new Set(['withExecutionContext', 'withExecutionContextAsync']);
const AUTHORITY_FILE = 'libs/core/authority.ts';

/**
 * Spawn helpers: where their options argument is and whether a call without
 * an explicit env inherits process.env (the secure-io helpers build an
 * allowlisted env that drops SYSTEM_ROLE unless the caller passes one back in).
 */
const CORE_SPAWN_HELPERS: Record<
  string,
  { file: string; inheritsByDefault: boolean; optionsIndex: number }
> = {
  safeExec: { file: 'libs/core/secure-io.ts', inheritsByDefault: false, optionsIndex: 2 },
  safeExecResult: { file: 'libs/core/secure-io.ts', inheritsByDefault: false, optionsIndex: 2 },
  safeExecResultAsync: {
    file: 'libs/core/secure-io.ts',
    inheritsByDefault: false,
    optionsIndex: 2,
  },
  safeExecShellScript: {
    file: 'libs/core/secure-io.ts',
    inheritsByDefault: false,
    optionsIndex: 2,
  },
  safeExecShellScriptResult: {
    file: 'libs/core/secure-io.ts',
    inheritsByDefault: false,
    optionsIndex: 2,
  },
  safeSpawn: { file: 'libs/core/secure-io.ts', inheritsByDefault: false, optionsIndex: 2 },
  spawnManagedProcess: {
    file: 'libs/core/managed-process.ts',
    inheritsByDefault: true,
    optionsIndex: 0,
  },
};
/** Modules whose spawn functions start a process that inherits process.env by default. */
const PROCESS_SPAWN_MODULES = new Set(['child_process', 'node:child_process', 'node-pty']);
const CHILD_PROCESS_FUNCTIONS = new Set([
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]);
/** Commands that can start Kyberion code; anything else is an external binary. */
const KYBERION_CAPABLE_COMMANDS = new Set(['node', 'pnpm', 'npm', 'npx', 'tsx', 'bash', 'sh']);

/**
 * Dynamic imports whose specifier is computed at runtime, reviewed by hand:
 * the modules they can load (repo-relative, `*` matches one path segment).
 * An unreviewed computed import is reported as an "any role" site.
 */
export const REVIEWED_DYNAMIC_IMPORTS: Record<string, { modules: string[]; rationale: string }> =
  {};

/**
 * Child processes whose command is computed at runtime and that may inherit
 * SYSTEM_ROLE, reviewed by hand. `targets` lists the Kyberion entry points the
 * child can run (walked as entries of the same system role); an empty list
 * means the child only runs external binaries. An unreviewed site whose
 * entry point cannot be resolved is reported as an "any role" site.
 */
/**
 * Assumptions the reference graph reaches but that cannot run for a system
 * role because of data flow the graph does not model. Each entry names the
 * test that pins the infeasibility; the report lists them separately and they
 * are not counted as reachable.
 */
export const REVIEWED_INFEASIBLE_ASSUMPTIONS: Array<{
  systemRoles: string[];
  role: string;
  site: string;
  rationale: string;
}> = [
  {
    systemRoles: ['computer_surface', 'presence_studio'],
    role: 'chronos_token_registry_reader',
    site: 'libs/core/authn-providers.ts#loadRegistrations',
    rationale:
      'TR-01: computer-surface/auth.ts and presence-studio/security.ts resolve viewers with `registrations: null`, so the registry-token provider never reads the Chronos token registry; pinned by libs/core/chronos-token-registry-reader.test.ts',
  },
];

export interface ReviewedChildProcess {
  /** Repo-relative entry points (`*` matches one path segment) or a data-driven resolver. */
  targets: string[] | ((ws: Workspace) => string[]);
  rationale: string;
}

const EXTERNAL_BINARY = 'runs an external binary, never a Kyberion entry point';

export const REVIEWED_CHILD_PROCESSES: Record<string, ReviewedChildProcess> = {
  'libs/core/service-engine-execution.ts#executeServicePresetAlternative': {
    targets: [],
    rationale:
      'runs a service preset CLI alternative through safeExec with an env built only from the preset (buildChildEnv), so buildSafeExecEnv never passes SYSTEM_ROLE on',
  },
  'libs/actuators/service-actuator/src/service-actuator-helpers.ts#startService': {
    targets: ['libs/actuators/*/src/index.ts'],
    rationale:
      'starts `node dist/libs/actuators/<id>/src/index.js` for the ids of a caller-supplied service manifest with process.env: any actuator entry',
  },
  'libs/core/apple-intelligence-bridge.ts#defaultRunner': {
    targets: [],
    rationale: `Apple Foundation Models helper; ${EXTERNAL_BINARY}`,
  },
  'libs/core/src/pfc/PhysicalLayer.ts#checkBinary': {
    targets: [],
    rationale: `\`command -v\` / \`where\` probe; ${EXTERNAL_BINARY}`,
  },
  'libs/core/virtual-camera-bridge.ts#isAvailableCommand': {
    targets: [],
    rationale: `camera capture tool probe (imagesnap / ffmpeg); ${EXTERNAL_BINARY}`,
  },
  'libs/core/virtual-camera-bridge.ts#ensureBuiltinVirtualCameraCaptureBackends': {
    targets: [],
    rationale: `camera capture tools (imagesnap / ffmpeg / sips / cp); ${EXTERNAL_BINARY}`,
  },
  'presence/bridge/nexus-daemon.ts#dispatchFeedback': {
    targets: (ws) =>
      readSafeJsonFile<{ channels?: Array<{ connector_skill?: string }> }>(
        ws.abs('presence/bridge/channel-registry.json'),
        'channel registry'
      )
        .channels?.map((channel) => channel.connector_skill)
        .filter((skill): skill is string => !!skill)
        .map((skill) => `libs/actuators/${skill}/src/index.ts`) ?? [],
    rationale:
      'runs `node dist/libs/actuators/<connector_skill>/src/index.js` with process.env for the connector skills of presence/bridge/channel-registry.json',
  },
};

function expandModuleGlobs(ws: Workspace, patterns: readonly string[]): string[] {
  const files: string[] = [];
  for (const pattern of patterns) {
    const segments = pattern.split('/');
    let current = [ws.root];
    for (const segment of segments) {
      const next: string[] = [];
      for (const dir of current) {
        if (segment === '*') {
          for (const entry of ws.list(dir)) {
            if (!entry.startsWith('.') && entry !== 'node_modules')
              next.push(path.join(dir, entry));
          }
        } else {
          next.push(path.join(dir, segment));
        }
      }
      current = next;
    }
    for (const candidate of current) if (ws.isFile(candidate)) files.push(candidate);
  }
  return files.sort();
}

export interface ReachableRole {
  example_path: string[];
}

export interface ChildProcessEntry {
  site: string;
  targets: string[];
}

export interface ReviewedInfeasible {
  role: string;
  site: string;
  rationale: string;
}

export interface SystemRoleReachability {
  entries: string[];
  reviewed_infeasible: ReviewedInfeasible[];
  child_process_entries: ChildProcessEntry[];
  reachable_roles: Record<string, ReachableRole>;
  /** Reachable sites that may assume any role (keys of the report's `unresolved_sites`). */
  unresolved_sites: string[];
  policy_roles_not_reachable: string[];
}

export interface AssumptionSiteReport {
  site: string;
  roles: string[];
  unresolved: string[];
}

export interface RoleAssumptionReachabilityReport {
  version: 1;
  generated_by: string;
  description: string;
  assumption_sites: AssumptionSiteReport[];
  /** Sites treated as "may assume any role", with the reasons. */
  unresolved_sites: Record<string, string[]>;
  system_roles: Record<string, SystemRoleReachability>;
}

// ---------------------------------------------------------------------------
// File discovery and module resolution
// ---------------------------------------------------------------------------

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

export interface Workspace {
  root: string;
  rel(file: string): string;
  abs(rel: string): string;
  exists(file: string): boolean;
  isFile(file: string): boolean;
  isDirectory(file: string): boolean;
  read(file: string): string;
  list(dir: string): string[];
}

function createWorkspace(root: string): Workspace {
  const exists = (file: string): boolean => safeExistsSync(file);
  return {
    root,
    rel: (file) => toPosix(path.relative(root, file)),
    abs: (rel) => path.join(root, rel),
    exists,
    isFile: (file) => exists(file) && safeStat(file).isFile(),
    isDirectory: (file) => exists(file) && safeStat(file).isDirectory(),
    read: (file) => readTextFile(file),
    list: (dir) => (exists(dir) ? safeReaddir(dir).sort() : []),
  };
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts'];

function isProjectSource(ws: Workspace, file: string): boolean {
  const rel = ws.rel(file);
  return (
    !rel.startsWith('..') &&
    !rel.includes('node_modules/') &&
    !rel.includes('/dist/') &&
    !rel.startsWith('dist/') &&
    !rel.endsWith('.d.ts') &&
    SOURCE_EXTENSIONS.some((ext) => rel.endsWith(ext))
  );
}

function isTestFile(rel: string): boolean {
  return /\.(test|spec)\.tsx?$/.test(rel) || /(^|\/)(__tests__|test|tests)\//.test(rel);
}

function collectSources(ws: Workspace, dir: string): string[] {
  const files: string[] = [];
  for (const entry of ws.list(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist') continue;
    const absolute = path.join(dir, entry);
    if (ws.isDirectory(absolute)) files.push(...collectSources(ws, absolute));
    else if (isProjectSource(ws, absolute) && !isTestFile(ws.rel(absolute))) files.push(absolute);
  }
  return files;
}

/** Map a package `exports` / dist path back to its TypeScript source. */
function sourceForDistTarget(ws: Workspace, packageDir: string, target: string): string | null {
  const cleaned = target.replace(/^\.\//, '');
  const withoutDist = cleaned.replace(/^dist\//, '');
  const stem = withoutDist.replace(/\.(m?js|d\.ts)$/, '');
  for (const candidate of [stem, `src/${stem}`]) {
    for (const ext of SOURCE_EXTENSIONS) {
      const file = path.join(packageDir, `${candidate}${ext}`);
      if (ws.isFile(file)) return file;
    }
  }
  return null;
}

interface WorkspacePackage {
  dir: string;
  entryPoints: Map<string, string>;
}

function loadWorkspacePackages(ws: Workspace): Map<string, WorkspacePackage> {
  const packages = new Map<string, WorkspacePackage>();
  const roots = ['libs', 'libs/actuators', 'satellites', 'presence/displays', 'presence/bridge'];
  for (const rootRel of roots) {
    for (const entry of ws.list(ws.abs(rootRel))) {
      const dir = path.join(ws.abs(rootRel), entry);
      const manifest = path.join(dir, 'package.json');
      if (!ws.isFile(manifest)) continue;
      const pkg = readSafeJsonFile<{
        name?: string;
        main?: string;
        exports?: Record<string, unknown> | string;
      }>(manifest, 'workspace package manifest');
      if (!pkg.name) continue;
      const entryPoints = new Map<string, string>();
      const add = (key: string, value: unknown): void => {
        const target =
          typeof value === 'string'
            ? value
            : value && typeof value === 'object'
              ? ((value as Record<string, unknown>).import ??
                (value as Record<string, unknown>).default ??
                (value as Record<string, unknown>).types)
              : undefined;
        if (typeof target !== 'string') return;
        const source = sourceForDistTarget(ws, dir, target);
        if (source) entryPoints.set(key, source);
      };
      if (typeof pkg.exports === 'string') add('.', pkg.exports);
      else if (pkg.exports) for (const [key, value] of Object.entries(pkg.exports)) add(key, value);
      if (!entryPoints.has('.') && pkg.main) add('.', pkg.main);
      packages.set(pkg.name, { dir, entryPoints });
    }
  }
  return packages;
}

function tryFile(ws: Workspace, base: string): string | null {
  if (SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext)) && ws.isFile(base)) return base;
  const stripped = base.replace(/\.(m?js|cjs|jsx)$/, '');
  for (const ext of SOURCE_EXTENSIONS) {
    if (ws.isFile(`${stripped}${ext}`)) return `${stripped}${ext}`;
  }
  if (ws.isDirectory(base)) {
    for (const ext of SOURCE_EXTENSIONS) {
      const index = path.join(base, `index${ext}`);
      if (ws.isFile(index)) return index;
    }
  }
  return null;
}

function createResolver(ws: Workspace) {
  const packages = loadWorkspacePackages(ws);
  const appRootCache = new Map<string, string | null>();
  const appRootFor = (file: string): string | null => {
    let dir = path.dirname(file);
    const visited: string[] = [];
    while (dir.startsWith(ws.root) && dir !== ws.root) {
      if (appRootCache.has(dir)) {
        const hit = appRootCache.get(dir) ?? null;
        for (const seen of visited) appRootCache.set(seen, hit);
        return hit;
      }
      visited.push(dir);
      if (
        ws.isFile(path.join(dir, 'next-env.d.ts')) ||
        ws.isFile(path.join(dir, 'tsconfig.json'))
      ) {
        const hit = ws.isDirectory(path.join(dir, 'src')) ? dir : null;
        if (hit || ws.isFile(path.join(dir, 'next-env.d.ts'))) {
          for (const seen of visited) appRootCache.set(seen, hit);
          return hit;
        }
      }
      dir = path.dirname(dir);
    }
    for (const seen of visited) appRootCache.set(seen, null);
    return null;
  };
  const cache = new Map<string, string | null>();
  return (specifier: string, containingFile: string): string | null => {
    const key = `${specifier}\u0000${specifier.startsWith('.') || specifier.startsWith('@/') ? containingFile : ''}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    let resolved: string | null = null;
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      resolved = tryFile(ws, path.resolve(path.dirname(containingFile), specifier));
    } else if (specifier.startsWith('@/')) {
      const appRoot = appRootFor(containingFile);
      if (appRoot) resolved = tryFile(ws, path.join(appRoot, 'src', specifier.slice(2)));
    } else {
      const parts = specifier.split('/');
      const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const pkg = packages.get(name);
      if (pkg) {
        const sub = specifier.slice(name.length);
        const exportKey = sub ? `.${sub}` : '.';
        resolved =
          pkg.entryPoints.get(exportKey) ??
          pkg.entryPoints.get(`${exportKey}.js`) ??
          tryFile(ws, path.join(pkg.dir, sub || 'index.ts')) ??
          tryFile(ws, path.join(pkg.dir, 'src', sub || 'index.ts'));
      }
    }
    if (resolved && !isProjectSource(ws, resolved)) resolved = null;
    cache.set(key, resolved);
    return resolved;
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

interface SurfaceManifestEntry {
  id?: string;
  command?: string;
  args?: string[];
}

function nextAppEntries(ws: Workspace, appDir: string): string[] {
  return collectSources(ws, appDir).filter((file) => {
    const rel = ws.rel(file);
    return !rel.includes('/test/') && !rel.endsWith('next-env.d.ts');
  });
}

function entriesForCommand(ws: Workspace, entry: SurfaceManifestEntry): string[] {
  const args = entry.args ?? [];
  if (entry.command === 'pnpm') {
    const dirIndex = args.indexOf('--dir');
    if (dirIndex >= 0 && args[dirIndex + 1]) {
      return nextAppEntries(ws, ws.abs(args[dirIndex + 1]));
    }
  }
  const files: string[] = [];
  for (const arg of args) {
    const source = sourceForScriptReference(ws, arg);
    if (source) files.push(source);
  }
  return files;
}

/** `dist/x/y.js`, `x/y.ts`, `./x/y.js` → the TypeScript source, when it exists. */
function sourceForScriptReference(ws: Workspace, reference: string): string | null {
  const cleaned = reference.replace(/^\.\//, '').replace(/^dist\//, '');
  if (!/\.(m?[jt]s|tsx)$/.test(cleaned)) return null;
  const found = tryFile(ws, ws.abs(cleaned));
  return found && isProjectSource(ws, found) ? found : null;
}

function collectSystemRoleEntries(ws: Workspace): Map<string, string[]> {
  const entries = new Map<string, string[]>();
  const manifestDir = ws.abs(SURFACE_MANIFEST_DIR);
  for (const name of ws.list(manifestDir)) {
    if (!name.endsWith('.json')) continue;
    const manifest = readSafeJsonFile<{ surfaces?: SurfaceManifestEntry[] }>(
      path.join(manifestDir, name),
      'surface manifest'
    );
    for (const surface of manifest.surfaces ?? []) {
      if (!surface.id) continue;
      const files = entriesForCommand(ws, surface);
      if (files.length === 0) {
        throw new Error(`surface ${surface.id}: could not resolve an entry point from its command`);
      }
      entries.set(surface.id.replace(/-/g, '_'), files);
    }
  }
  for (const [systemRole, rels] of Object.entries(EXTRA_SYSTEM_ROLE_ENTRIES)) {
    const files = rels.map((rel) => ws.abs(rel)).filter((file) => ws.isFile(file));
    if (files.length > 0) entries.set(systemRole, files);
  }
  return new Map([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

function createProgram(ws: Workspace, rootNames: string[]): ts.Program {
  const resolve = createResolver(ws);
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    noLib: true,
    noEmit: true,
    allowJs: false,
    resolveJsonModule: false,
    skipLibCheck: true,
    types: [],
  };
  const sourceFiles = new Map<string, ts.SourceFile | undefined>();
  const host: ts.CompilerHost = {
    getSourceFile(fileName, languageVersion) {
      if (sourceFiles.has(fileName)) return sourceFiles.get(fileName);
      let sourceFile: ts.SourceFile | undefined;
      if (ws.isFile(fileName)) {
        const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
        sourceFile = ts.createSourceFile(fileName, ws.read(fileName), languageVersion, true, kind);
      }
      sourceFiles.set(fileName, sourceFile);
      return sourceFile;
    },
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => ws.root,
    getDirectories: () => [],
    fileExists: (fileName) => ws.isFile(fileName),
    readFile: (fileName) => (ws.isFile(fileName) ? ws.read(fileName) : undefined),
    getCanonicalFileName: (fileName) => fileName,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    resolveModuleNameLiterals(literals, containingFile) {
      return literals.map((literal) => {
        const resolvedFileName = resolve(literal.text, containingFile);
        return {
          resolvedModule: resolvedFileName
            ? {
                resolvedFileName,
                extension: resolvedFileName.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts,
                isExternalLibraryImport: false,
              }
            : undefined,
        };
      });
    },
  };
  return ts.createProgram({ rootNames, options, host });
}

// ---------------------------------------------------------------------------
// Units: module initialisation code and top-level declarations
// ---------------------------------------------------------------------------

interface Unit {
  id: string;
  file: string;
  lazy: boolean;
  exported: boolean;
  /** A direct-entry guarded block: runs only when the file is the process entry point. */
  entryOnly?: boolean;
  roots: ts.Node[];
}

const DIRECT_ENTRY_GUARDS = new Set(['isDirectEntry', 'isDirectScript', 'isMainModule']);

/** `if (isDirectEntry(import.meta.url, ...)) { ... }` and its equivalents. */
function isDirectEntryGuard(statement: ts.Statement): boolean {
  if (!ts.isIfStatement(statement) || statement.elseStatement) return false;
  let guarded = false;
  const visit = (node: ts.Node): void => {
    if (guarded) return;
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      DIRECT_ENTRY_GUARDS.has(node.expression.text)
    ) {
      guarded = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(statement.expression);
  if (guarded) {
    // Only a pure disjunction of guard calls qualifies; `guard || other` would
    // also run for other reasons.
    const onlyGuards = (node: ts.Expression): boolean => {
      const expr = unwrapExpression(node);
      if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        return onlyGuards(expr.left) && onlyGuards(expr.right);
      }
      return (
        ts.isCallExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        DIRECT_ENTRY_GUARDS.has(expr.expression.text)
      );
    };
    return onlyGuards(statement.expression);
  }
  return false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionLikeExpression(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  const inner = unwrapExpression(expression);
  return ts.isArrowFunction(inner) || ts.isFunctionExpression(inner);
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

function classNeedsEagerEvaluation(node: ts.ClassDeclaration): boolean {
  return node.members.some(
    (member) =>
      ts.isClassStaticBlockDeclaration(member) ||
      (ts.isPropertyDeclaration(member) &&
        !!member.initializer &&
        (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword))
  );
}

class UnitIndex {
  readonly units = new Map<string, Unit>();
  private readonly rootToUnit = new Map<ts.Node, Unit>();
  private readonly moduleUnits = new Map<ts.SourceFile, Unit>();

  constructor(
    private readonly ws: Workspace,
    sourceFiles: readonly ts.SourceFile[]
  ) {
    for (const sourceFile of sourceFiles) this.index(sourceFile);
  }

  private add(unit: Unit): Unit {
    this.units.set(unit.id, unit);
    for (const root of unit.roots) this.rootToUnit.set(root, unit);
    return unit;
  }

  private index(sourceFile: ts.SourceFile): void {
    const rel = this.ws.rel(sourceFile.fileName);
    const moduleUnit: Unit = {
      id: `${rel}#<module>`,
      file: rel,
      lazy: false,
      exported: false,
      roots: [],
    };
    this.units.set(moduleUnit.id, moduleUnit);
    this.moduleUnits.set(sourceFile, moduleUnit);
    const named = new Map<string, number>();
    const unitId = (name: string): string => {
      const count = named.get(name) ?? 0;
      named.set(name, count + 1);
      return `${rel}#${count === 0 ? name : `${name}~${count + 1}`}`;
    };
    for (const statement of sourceFile.statements) {
      if (
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isImportDeclaration(statement) ||
        ts.isExportDeclaration(statement) ||
        ts.isImportEqualsDeclaration(statement)
      ) {
        continue;
      }
      if (ts.isFunctionDeclaration(statement) && statement.body) {
        const name = statement.name?.text ?? 'default';
        this.add({
          id: unitId(name),
          file: rel,
          lazy: true,
          exported: hasExportModifier(statement),
          roots: [statement],
        });
        continue;
      }
      if (ts.isClassDeclaration(statement) && !classNeedsEagerEvaluation(statement)) {
        const name = statement.name?.text ?? 'default';
        this.add({
          id: unitId(name),
          file: rel,
          lazy: true,
          exported: hasExportModifier(statement),
          roots: [statement],
        });
        continue;
      }
      if (ts.isVariableStatement(statement)) {
        const exported = hasExportModifier(statement);
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            isFunctionLikeExpression(declaration.initializer)
          ) {
            this.add({
              id: unitId(declaration.name.text),
              file: rel,
              lazy: true,
              exported,
              roots: [declaration],
            });
          } else {
            moduleUnit.roots.push(declaration);
            this.rootToUnit.set(declaration, moduleUnit);
          }
        }
        continue;
      }
      if (ts.isExportAssignment(statement) && isFunctionLikeExpression(statement.expression)) {
        this.add({
          id: unitId('default'),
          file: rel,
          lazy: true,
          exported: true,
          roots: [statement],
        });
        continue;
      }
      if (isDirectEntryGuard(statement)) {
        this.add({
          id: unitId('<main>'),
          file: rel,
          lazy: true,
          exported: false,
          entryOnly: true,
          roots: [statement],
        });
        continue;
      }
      moduleUnit.roots.push(statement);
      this.rootToUnit.set(statement, moduleUnit);
    }
  }

  moduleUnit(sourceFile: ts.SourceFile): Unit | undefined {
    return this.moduleUnits.get(sourceFile);
  }

  /** The unit that owns `node`, or undefined when `node` is outside the project. */
  unitOf(node: ts.Node): Unit | undefined {
    let current: ts.Node | undefined = node;
    while (current) {
      const unit = this.rootToUnit.get(current);
      if (unit) return unit;
      if (ts.isSourceFile(current)) return this.moduleUnits.get(current);
      current = current.parent;
    }
    return undefined;
  }

  unitsOfFile(rel: string): Unit[] {
    return [...this.units.values()].filter((unit) => unit.file === rel);
  }
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

interface RoleResolution {
  roles: Set<string>;
  unresolved: string[];
  forwards: Forward[];
}

interface Forward {
  fn: ts.SignatureDeclaration;
  index: number;
  property?: string;
  /** The literal union of the parameter's declared type, when it has one. */
  declared?: string[];
}

interface CallRef {
  unit: Unit;
  call: ts.CallExpression | ts.NewExpression;
}

interface RoleRecord {
  unit: Unit;
  site: string;
  roles: Set<string>;
  unresolved: string[];
}

interface SpawnRecord {
  unit: Unit;
  site: string;
  inheritsSystemRole: boolean;
  kyberionCapable: boolean;
  targets: string[];
}

function emptyResolution(): RoleResolution {
  return { roles: new Set(), unresolved: [], forwards: [] };
}

function mergeResolution(into: RoleResolution, from: RoleResolution): RoleResolution {
  for (const role of from.roles) into.roles.add(role);
  into.unresolved.push(...from.unresolved);
  into.forwards.push(...from.forwards);
  return into;
}

function isInTypePosition(node: ts.Node): boolean {
  return ts.isTypeNode(node) && !ts.isExpressionWithTypeArguments(node);
}

function functionLikeOf(declaration: ts.Declaration): ts.SignatureDeclaration | undefined {
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isMethodDeclaration(declaration) ||
    ts.isArrowFunction(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return declaration;
  }
  if (
    (ts.isVariableDeclaration(declaration) ||
      ts.isPropertyAssignment(declaration) ||
      ts.isPropertyDeclaration(declaration)) &&
    declaration.initializer
  ) {
    const inner = unwrapExpression(declaration.initializer);
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) return inner;
  }
  return undefined;
}

class Analyzer {
  readonly checker: ts.TypeChecker;
  readonly units: UnitIndex;
  readonly edges = new Map<Unit, Set<Unit>>();
  readonly unresolvedEdges = new Map<Unit, string[]>();
  readonly roleRecords: RoleRecord[] = [];
  readonly spawnRecords: SpawnRecord[] = [];
  private readonly callRefs = new Map<ts.SignatureDeclaration, CallRef[]>();
  private readonly valueRefs = new Map<ts.SignatureDeclaration, Unit[]>();
  private readonly pendingForwards: Array<{
    unit: Unit;
    site: string;
    resolution: RoleResolution;
  }> = [];
  private readonly assumptionDeclarations = new Set<ts.Declaration>();
  private readonly spawnHelperDeclarations = new Map<
    ts.Declaration,
    { inheritsByDefault: boolean; optionsIndex: number }
  >();
  private readonly projectFiles: readonly ts.SourceFile[];

  constructor(
    private readonly ws: Workspace,
    readonly program: ts.Program,
    private readonly packageScripts: Record<string, string>
  ) {
    this.checker = program.getTypeChecker();
    this.projectFiles = program
      .getSourceFiles()
      .filter((sourceFile) => isProjectSource(ws, sourceFile.fileName));
    this.units = new UnitIndex(ws, this.projectFiles);
    this.indexKnownDeclarations();
    for (const sourceFile of this.projectFiles) this.scanFile(sourceFile);
    this.resolveForwards();
  }

  private indexKnownDeclarations(): void {
    for (const sourceFile of this.projectFiles) {
      const rel = this.ws.rel(sourceFile.fileName);
      for (const statement of sourceFile.statements) {
        if (!ts.isFunctionDeclaration(statement) || !statement.name) continue;
        const name = statement.name.text;
        if (rel === AUTHORITY_FILE && ASSUMPTION_FUNCTIONS.has(name)) {
          this.assumptionDeclarations.add(statement);
        }
        const helper = CORE_SPAWN_HELPERS[name];
        if (helper && helper.file === rel) {
          this.spawnHelperDeclarations.set(statement, helper);
        }
      }
    }
  }

  private addEdge(from: Unit, to: Unit | undefined): void {
    if (!to || to === from) return;
    let targets = this.edges.get(from);
    if (!targets) this.edges.set(from, (targets = new Set()));
    targets.add(to);
  }

  private addUnresolvedEdge(from: Unit, reason: string): void {
    const list = this.unresolvedEdges.get(from) ?? [];
    list.push(reason);
    this.unresolvedEdges.set(from, list);
  }

  private resolveAlias(symbol: ts.Symbol | undefined): ts.Symbol | undefined {
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) {
      try {
        const aliased = this.checker.getAliasedSymbol(symbol);
        if (aliased && !(aliased.flags & ts.SymbolFlags.Alias)) return aliased;
        return aliased;
      } catch {
        return undefined;
      }
    }
    return symbol;
  }

  private moduleSourceFile(specifier: ts.Expression): ts.SourceFile | undefined {
    const symbol = this.checker.getSymbolAtLocation(specifier);
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    return declaration && ts.isSourceFile(declaration) ? declaration : undefined;
  }

  /** Every declaration exported by `sourceFile` (following re-exports). */
  private exportedUnits(sourceFile: ts.SourceFile): Unit[] {
    const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
    const result: Unit[] = [];
    const moduleUnit = this.units.moduleUnit(sourceFile);
    if (moduleUnit) result.push(moduleUnit);
    if (!moduleSymbol) return result;
    for (const exported of this.checker.getExportsOfModule(moduleSymbol)) {
      const target = this.resolveAlias(exported);
      for (const declaration of target?.declarations ?? []) {
        const unit = this.units.unitOf(declaration);
        if (unit) result.push(unit);
      }
    }
    return result;
  }

  private importedModuleOf(symbol: ts.Symbol): ts.SourceFile | undefined {
    const declaration = symbol.declarations?.[0];
    if (!declaration) return undefined;
    if (ts.isNamespaceImport(declaration)) {
      return this.moduleSourceFile(declaration.parent.parent.moduleSpecifier);
    }
    if (ts.isNamespaceExport(declaration)) {
      const specifier = declaration.parent.moduleSpecifier;
      return specifier ? this.moduleSourceFile(specifier) : undefined;
    }
    return undefined;
  }

  private importModuleSpecifierOf(symbol: ts.Symbol): string | undefined {
    const declaration = symbol.declarations?.[0];
    if (!declaration) return undefined;
    let current: ts.Node | undefined = declaration;
    while (current && !ts.isSourceFile(current)) {
      if (ts.isImportDeclaration(current)) {
        return ts.isStringLiteral(current.moduleSpecifier)
          ? current.moduleSpecifier.text
          : undefined;
      }
      current = current.parent;
    }
    return undefined;
  }

  private scanFile(sourceFile: ts.SourceFile): void {
    const moduleUnit = this.units.moduleUnit(sourceFile);
    if (!moduleUnit) return;
    // Module loading: imports and re-exports load the target module.
    for (const statement of sourceFile.statements) {
      if (
        (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly) ||
        (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier)
      ) {
        const specifier = statement.moduleSpecifier;
        if (!specifier) continue;
        const target = this.moduleSourceFile(specifier);
        if (target) this.addEdge(moduleUnit, this.units.moduleUnit(target));
      }
    }
    for (const unit of this.units.unitsOfFile(this.ws.rel(sourceFile.fileName))) {
      for (const root of unit.roots) this.scanNode(unit, root);
    }
  }

  private scanNode(unit: Unit, node: ts.Node): void {
    if (isInTypePosition(node)) return;
    if (
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    ) {
      return;
    }
    if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
      this.scanIdentifier(unit, node);
    } else if (ts.isCallExpression(node)) {
      this.scanCall(unit, node);
    }
    ts.forEachChild(node, (child) => this.scanNode(unit, child));
  }

  private scanCall(unit: Unit, call: ts.CallExpression): void {
    if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = call.arguments;
      if (argument && ts.isStringLiteralLike(argument)) {
        const target = this.moduleSourceFile(argument);
        if (target) for (const exported of this.exportedUnits(target)) this.addEdge(unit, exported);
        return;
      }
      // A computed specifier built from a repo path literal (rootResolve('dist/...js')).
      const sources = argument
        ? this.collectStrings(argument)
            .map((value) => sourceForScriptReference(this.ws, value))
            .filter((value): value is string => !!value)
        : [];
      const reviewed = REVIEWED_DYNAMIC_IMPORTS[unit.id];
      const modules = [
        ...sources,
        ...(reviewed ? expandModuleGlobs(this.ws, reviewed.modules) : []),
      ];
      for (const file of modules) {
        const target = this.program.getSourceFile(file);
        if (target) for (const exported of this.exportedUnits(target)) this.addEdge(unit, exported);
      }
      if (sources.length === 0 && !reviewed) {
        this.addUnresolvedEdge(
          unit,
          `dynamic import with a computed specifier at ${this.position(call)}`
        );
      }
      return;
    }
    if (ts.isIdentifier(call.expression) && call.expression.text === 'require') {
      const [argument] = call.arguments;
      if (argument && ts.isStringLiteralLike(argument)) {
        const target = this.moduleSourceFile(argument);
        if (target) for (const exported of this.exportedUnits(target)) this.addEdge(unit, exported);
      } else {
        this.addUnresolvedEdge(unit, `require with a computed specifier at ${this.position(call)}`);
      }
      return;
    }
    const callee = this.calleeDeclaration(call);
    if (callee && this.assumptionDeclarations.has(callee)) {
      const [roleArgument] = call.arguments;
      const resolution = roleArgument
        ? this.resolveRoleExpression(roleArgument)
        : { ...emptyResolution(), unresolved: ['missing role argument'] };
      this.pendingForwards.push({ unit, site: this.position(call), resolution });
      return;
    }
    const spawnKind = this.spawnKind(call, callee);
    if (spawnKind)
      this.recordSpawn(unit, call, spawnKind.inheritsByDefault, spawnKind.optionsIndex);
  }

  private calleeDeclaration(
    call: ts.CallExpression | ts.NewExpression
  ): ts.Declaration | undefined {
    const expression = unwrapExpression(call.expression);
    const nameNode = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(nameNode));
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }

  private spawnKind(
    call: ts.CallExpression,
    callee: ts.Declaration | undefined
  ): { inheritsByDefault: boolean; optionsIndex?: number } | undefined {
    const helper = callee ? this.spawnHelperDeclarations.get(callee) : undefined;
    if (helper) return helper;
    const expression = unwrapExpression(call.expression);
    const nameNode = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    if (!ts.isIdentifier(nameNode) || !CHILD_PROCESS_FUNCTIONS.has(nameNode.text)) return undefined;
    const ownerNode = ts.isPropertyAccessExpression(expression) ? expression.expression : nameNode;
    const owner = this.checker.getSymbolAtLocation(ownerNode);
    const specifier = owner ? this.importModuleSpecifierOf(owner) : undefined;
    return specifier && PROCESS_SPAWN_MODULES.has(specifier)
      ? { inheritsByDefault: true }
      : undefined;
  }

  private position(node: ts.Node): string {
    const sourceFile = node.getSourceFile();
    const unit = this.units.unitOf(node);
    return unit ? unit.id : this.ws.rel(sourceFile.fileName);
  }

  private scanIdentifier(unit: Unit, node: ts.Identifier | ts.PrivateIdentifier): void {
    const parent = node.parent;
    let symbol: ts.Symbol | undefined;
    if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
      symbol = this.checker.getShorthandAssignmentValueSymbol(parent);
    } else {
      symbol = this.checker.getSymbolAtLocation(node);
    }
    if (!symbol) return;
    // A namespace import used as a value (not `ns.member`) exposes every export.
    if (symbol.flags & ts.SymbolFlags.Alias) {
      const namespaceModule = this.importedModuleOf(symbol);
      if (namespaceModule) {
        const isMemberAccess =
          (ts.isPropertyAccessExpression(parent) && parent.expression === node) ||
          (ts.isElementAccessExpression(parent) &&
            parent.expression === node &&
            ts.isStringLiteralLike(parent.argumentExpression));
        if (!isMemberAccess) {
          for (const exported of this.exportedUnits(namespaceModule)) this.addEdge(unit, exported);
        }
        return;
      }
    }
    const target = this.resolveAlias(symbol);
    for (const declaration of target?.declarations ?? []) {
      if (!isProjectSource(this.ws, declaration.getSourceFile().fileName)) continue;
      const targetUnit = this.units.unitOf(declaration);
      this.addEdge(unit, targetUnit);
      if (
        this.assumptionDeclarations.has(declaration) &&
        !this.isCallee(node) &&
        !this.isDeclarationName(node)
      ) {
        this.addUnresolvedEdge(
          unit,
          `withExecutionContext passed as a value at ${this.position(node)}`
        );
      }
      const fn = functionLikeOf(declaration);
      if (!fn) continue;
      const call = this.enclosingCallForCallee(node);
      if (call) {
        const refs = this.callRefs.get(fn) ?? [];
        refs.push({ unit, call });
        this.callRefs.set(fn, refs);
      } else if (!this.isDeclarationName(node)) {
        const refs = this.valueRefs.get(fn) ?? [];
        refs.push(unit);
        this.valueRefs.set(fn, refs);
      }
    }
  }

  private isDeclarationName(node: ts.Node): boolean {
    const parent = node.parent;
    return (
      !!parent &&
      (ts.isFunctionDeclaration(parent) ||
        ts.isVariableDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isPropertyAssignment(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isClassDeclaration(parent) ||
        ts.isParameter(parent) ||
        ts.isExportSpecifier(parent) ||
        ts.isImportSpecifier(parent)) &&
      (parent as ts.NamedDeclaration).name === node
    );
  }

  private isCallee(node: ts.Node): boolean {
    return this.enclosingCallForCallee(node) !== undefined;
  }

  private enclosingCallForCallee(node: ts.Node): ts.CallExpression | ts.NewExpression | undefined {
    let current: ts.Node = node;
    if (ts.isPropertyAccessExpression(current.parent) && current.parent.name === current) {
      current = current.parent;
    }
    while (
      ts.isParenthesizedExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isAsExpression(current.parent)
    ) {
      current = current.parent;
    }
    const parent = current.parent;
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent)) &&
      parent.expression === current
    ) {
      return parent;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Role argument resolution
  // -------------------------------------------------------------------------

  private literalStrings(type: ts.Type): string[] | undefined {
    const members = type.isUnion() ? type.types : [type];
    const values: string[] = [];
    for (const member of members) {
      if (member.isStringLiteral()) values.push(member.value);
      else if (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) continue;
      else return undefined;
    }
    return values.length > 0 ? values : undefined;
  }

  resolveRoleExpression(expression: ts.Expression, depth = 0): RoleResolution {
    const result = emptyResolution();
    const expr = unwrapExpression(expression);
    if (depth > 8) {
      result.unresolved.push(`role expression too deep at ${this.position(expr)}`);
      return result;
    }
    if (ts.isStringLiteralLike(expr)) {
      result.roles.add(expr.text);
      return result;
    }
    if (ts.isBinaryExpression(expr)) {
      const operator = expr.operatorToken.kind;
      if (
        operator === ts.SyntaxKind.QuestionQuestionToken ||
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.AmpersandAmpersandToken
      ) {
        if (operator !== ts.SyntaxKind.AmpersandAmpersandToken) {
          mergeResolution(result, this.resolveRoleExpression(expr.left, depth + 1));
        }
        return mergeResolution(result, this.resolveRoleExpression(expr.right, depth + 1));
      }
    }
    if (ts.isConditionalExpression(expr)) {
      mergeResolution(result, this.resolveRoleExpression(expr.whenTrue, depth + 1));
      return mergeResolution(result, this.resolveRoleExpression(expr.whenFalse, depth + 1));
    }
    // A role taken from a parameter is attributed to each call site (below),
    // which is more precise than the parameter's declared union.
    if (ts.isIdentifier(expr)) {
      const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(expr));
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isParameter(declaration)) {
        return this.forwardParameter(declaration, undefined, result, depth, expr);
      }
      if (declaration && ts.isBindingElement(declaration)) {
        const forwarded = this.forwardBindingElement(declaration, result, depth, expr);
        if (forwarded) return forwarded;
      }
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const owner = unwrapExpression(expr.expression);
      if (ts.isIdentifier(owner)) {
        const ownerSymbol = this.resolveAlias(this.checker.getSymbolAtLocation(owner));
        const ownerDeclaration = ownerSymbol?.valueDeclaration ?? ownerSymbol?.declarations?.[0];
        if (ownerDeclaration && ts.isParameter(ownerDeclaration)) {
          return this.forwardParameter(ownerDeclaration, expr.name.text, result, depth, expr);
        }
      }
    }
    const literal = this.literalStrings(this.checker.getTypeAtLocation(expr));
    if (literal) {
      for (const value of literal) result.roles.add(value);
      return result;
    }
    if (ts.isIdentifier(expr)) {
      const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(expr));
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer) {
        return mergeResolution(
          result,
          this.resolveRoleExpression(declaration.initializer, depth + 1)
        );
      }
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const owner = unwrapExpression(expr.expression);
      const fromObject = this.propertyInitializerOfConstObject(owner, expr.name.text);
      if (fromObject) {
        return mergeResolution(result, this.resolveRoleExpression(fromObject, depth + 1));
      }
      const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(expr.name));
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (
        declaration &&
        (ts.isPropertyAssignment(declaration) || ts.isPropertyDeclaration(declaration)) &&
        declaration.initializer
      ) {
        return mergeResolution(
          result,
          this.resolveRoleExpression(declaration.initializer, depth + 1)
        );
      }
    }
    result.unresolved.push(
      `role argument \`${expr.getText().slice(0, 80)}\` could not be resolved at ${this.position(expr)}`
    );
    return result;
  }

  /** `CONST.prop` where CONST is a (possibly Object.freeze-wrapped) object literal. */
  private propertyInitializerOfConstObject(
    owner: ts.Expression,
    property: string
  ): ts.Expression | undefined {
    const initializer = this.initializerOf(owner);
    if (!initializer || initializer === 'parameter') return undefined;
    let objectExpression = unwrapExpression(initializer);
    if (ts.isCallExpression(objectExpression) && objectExpression.arguments.length === 1) {
      objectExpression = unwrapExpression(objectExpression.arguments[0]);
    }
    if (!ts.isObjectLiteralExpression(objectExpression)) return undefined;
    for (const entry of objectExpression.properties) {
      if (
        ts.isPropertyAssignment(entry) &&
        (ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) &&
        entry.name.text === property
      ) {
        return entry.initializer;
      }
    }
    return undefined;
  }

  private forwardParameter(
    parameter: ts.ParameterDeclaration,
    property: string | undefined,
    result: RoleResolution,
    depth: number,
    reference?: ts.Expression
  ): RoleResolution {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    if (parameter.dotDotDotToken || index < 0) {
      result.unresolved.push(`role taken from a rest parameter at ${this.position(parameter)}`);
      return result;
    }
    const declared = reference
      ? this.literalStrings(this.checker.getTypeAtLocation(reference))
      : undefined;
    result.forwards.push({
      fn,
      index,
      ...(property ? { property } : {}),
      ...(declared ? { declared } : {}),
    });
    if (!property && parameter.initializer) {
      mergeResolution(result, this.resolveRoleExpression(parameter.initializer, depth + 1));
    }
    return result;
  }

  private forwardBindingElement(
    element: ts.BindingElement,
    result: RoleResolution,
    depth: number,
    reference?: ts.Expression
  ): RoleResolution | undefined {
    const pattern = element.parent;
    if (!ts.isObjectBindingPattern(pattern) || !ts.isParameter(pattern.parent)) return undefined;
    const propertyName = element.propertyName ?? element.name;
    if (!ts.isIdentifier(propertyName)) return undefined;
    if (element.initializer) {
      mergeResolution(result, this.resolveRoleExpression(element.initializer, depth + 1));
    }
    return this.forwardParameter(pattern.parent, propertyName.text, result, depth, reference);
  }

  private resolveArgument(
    call: ts.CallExpression | ts.NewExpression,
    forward: Forward
  ): RoleResolution {
    const args = call.arguments ?? ts.factory.createNodeArray<ts.Expression>();
    const spreadIndex = args.findIndex((arg) => ts.isSpreadElement(arg));
    if (spreadIndex >= 0 && spreadIndex <= forward.index) {
      return { ...emptyResolution(), unresolved: [`spread argument at ${this.position(call)}`] };
    }
    const argument = args[forward.index];
    if (!argument) return emptyResolution();
    if (!forward.property) return this.resolveRoleExpression(argument);
    const inner = unwrapExpression(argument);
    if (ts.isObjectLiteralExpression(inner)) {
      let found: RoleResolution | undefined;
      for (const property of inner.properties) {
        if (ts.isSpreadAssignment(property)) {
          return {
            ...emptyResolution(),
            unresolved: [`spread options object at ${this.position(call)}`],
          };
        }
        const name =
          property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
        if (name !== forward.property) continue;
        if (ts.isPropertyAssignment(property))
          found = this.resolveRoleExpression(property.initializer);
        else if (ts.isShorthandPropertyAssignment(property))
          found = this.resolveRoleExpression(property.name);
        else {
          found = {
            ...emptyResolution(),
            unresolved: [
              `role option \`${forward.property}\` is not a value at ${this.position(call)}`,
            ],
          };
        }
      }
      return found ?? emptyResolution();
    }
    const type = this.checker.getTypeAtLocation(inner);
    const property = type.getProperty(forward.property);
    if (property) {
      const literal = this.literalStrings(this.checker.getTypeOfSymbolAtLocation(property, inner));
      if (literal) return { ...emptyResolution(), roles: new Set(literal) };
    }
    if (ts.isIdentifier(inner)) {
      const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(inner));
      const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
      if (declaration && ts.isParameter(declaration)) {
        return this.forwardParameter(declaration, forward.property, emptyResolution(), 0);
      }
    }
    return {
      ...emptyResolution(),
      unresolved: [
        `role option \`${forward.property}\` of \`${inner.getText().slice(0, 60)}\` could not be resolved at ${this.position(call)}`,
      ],
    };
  }

  private isDispatchableMethod(fn: ts.SignatureDeclaration): boolean {
    if (ts.isMethodDeclaration(fn)) return true;
    const parent = fn.parent;
    return (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      !!parent &&
      (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))
    );
  }

  /** Attribute forwarded roles to the call sites of role-forwarding wrappers. */
  private resolveForwards(): void {
    const queue = [...this.pendingForwards];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { unit, site, resolution } = item;
      if (resolution.roles.size > 0 || resolution.unresolved.length > 0) {
        this.roleRecords.push({
          unit,
          site: unit.id === site ? site : `${unit.id} (via ${site})`,
          roles: new Set(resolution.roles),
          unresolved: [...resolution.unresolved],
        });
      }
      for (const forward of resolution.forwards) {
        const key = `${unit.id}|${site}|${forward.fn.pos}:${forward.fn.getSourceFile().fileName}|${forward.index}|${forward.property ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const ref of this.callRefs.get(forward.fn) ?? []) {
          queue.push({
            unit: ref.unit,
            site: `${site}`,
            resolution: this.resolveArgument(ref.call, forward),
          });
        }
        const fallback = (reason: string): RoleResolution =>
          forward.declared
            ? { ...emptyResolution(), roles: new Set(forward.declared) }
            : { ...emptyResolution(), unresolved: [reason] };
        const wrapperUnit = this.units.unitOf(forward.fn);
        for (const valueUnit of this.valueRefs.get(forward.fn) ?? []) {
          if (valueUnit === wrapperUnit) continue;
          queue.push({
            unit: valueUnit,
            site,
            resolution: fallback(
              `role-forwarding function ${wrapperUnit?.id ?? '?'} is passed as a value in ${valueUnit.id}`
            ),
          });
        }
        // A method can also be invoked through an interface or `this`-less
        // dispatch the checker does not bind to it: attribute its declared
        // role type (or "any") to the method's own unit as well.
        if (wrapperUnit && this.isDispatchableMethod(forward.fn)) {
          queue.push({
            unit: wrapperUnit,
            site,
            resolution: fallback(
              `role-forwarding method at ${wrapperUnit.id} may be invoked through dynamic dispatch`
            ),
          });
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Child processes
  // -------------------------------------------------------------------------

  private collectStrings(node: ts.Node, depth = 0, out: string[] = []): string[] {
    if (depth > 3) return out;
    const visit = (current: ts.Node): void => {
      if (ts.isStringLiteralLike(current)) {
        out.push(current.text);
        for (const token of current.text.split(/[\s'"`=;&|()]+/)) if (token) out.push(token);
      } else if (ts.isCallExpression(current)) {
        const parts = current.arguments.filter(ts.isStringLiteralLike).map((arg) => arg.text);
        if (parts.length > 1) out.push(parts.join('/'));
      } else if (ts.isIdentifier(current) && depth < 3) {
        const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(current));
        const declaration = symbol?.valueDeclaration;
        if (
          declaration &&
          ts.isVariableDeclaration(declaration) &&
          declaration.initializer &&
          isProjectSource(this.ws, declaration.getSourceFile().fileName)
        ) {
          this.collectStrings(declaration.initializer, depth + 1, out);
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(node);
    return out;
  }

  /** Resolve an identifier to its variable initializer (project sources only). */
  private initializerOf(node: ts.Expression): ts.Expression | 'parameter' | undefined {
    const inner = unwrapExpression(node);
    if (!ts.isIdentifier(inner)) return undefined;
    const symbol = this.resolveAlias(this.checker.getSymbolAtLocation(inner));
    const declaration = symbol?.valueDeclaration;
    if (!declaration || !isProjectSource(this.ws, declaration.getSourceFile().fileName)) {
      return undefined;
    }
    if (ts.isParameter(declaration) || ts.isBindingElement(declaration)) return 'parameter';
    if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
      return declaration.initializer;
    }
    return undefined;
  }

  /**
   * Could the env built by `expression` carry the parent's SYSTEM_ROLE?
   * process.env and anything derived from it do, unless it is filtered by
   * buildProviderChildEnv (which drops SYSTEM_ROLE) or sets SYSTEM_ROLE itself.
   * Anything opaque (a parameter, an unknown call) is assumed to.
   */
  private envInherits(expression: ts.Expression, depth = 0): boolean {
    const expr = unwrapExpression(expression);
    if (depth > 4) return true;
    if (
      ts.isPropertyAccessExpression(expr) &&
      expr.name.text === 'env' &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'process'
    ) {
      return true;
    }
    if (ts.isObjectLiteralExpression(expr)) {
      if (this.objectHasOwnProperty(expr, 'SYSTEM_ROLE')) return false;
      return expr.properties.some((property) => {
        if (ts.isSpreadAssignment(property))
          return this.envInherits(property.expression, depth + 1);
        return false;
      });
    }
    if (ts.isConditionalExpression(expr)) {
      return (
        this.envInherits(expr.whenTrue, depth + 1) || this.envInherits(expr.whenFalse, depth + 1)
      );
    }
    if (ts.isBinaryExpression(expr)) {
      return this.envInherits(expr.left, depth + 1) || this.envInherits(expr.right, depth + 1);
    }
    if (ts.isCallExpression(expr)) {
      const callee = unwrapExpression(expr.expression);
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee)
          ? callee.text
          : '';
      if (name === 'buildProviderChildEnv') return false;
      if (name === 'buildSafeExecEnv') {
        return expr.arguments.some((arg) => this.envInherits(arg, depth + 1));
      }
      return true;
    }
    if (expr.kind === ts.SyntaxKind.UndefinedKeyword) return false;
    if (ts.isIdentifier(expr) && expr.text === 'undefined') return false;
    const initializer = this.initializerOf(expr);
    if (initializer === 'parameter' || initializer === undefined) return true;
    return this.envInherits(initializer, depth + 1);
  }

  private objectHasOwnProperty(node: ts.ObjectLiteralExpression, name: string): boolean {
    return node.properties.some(
      (property) =>
        (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
        property.name.text === name
    );
  }

  /**
   * The `env` value of a spawn call's options: the expression, 'absent', or
   * 'opaque' when the options object cannot be inspected.
   */
  private spawnEnv(
    call: ts.CallExpression,
    optionsIndex: number | undefined
  ): ts.Expression | 'absent' | 'opaque' {
    let opaque = false;
    const search = (expression: ts.Expression, depth: number): ts.Expression | undefined => {
      const expr = unwrapExpression(expression);
      if (ts.isObjectLiteralExpression(expr)) {
        for (const property of expr.properties) {
          if (ts.isSpreadAssignment(property)) {
            opaque = true;
            continue;
          }
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
            continue;
          }
          const name =
            ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
              ? property.name.text
              : undefined;
          const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;
          if (name === 'env') return value;
          if (name === 'spawnOptions' || name === 'options') {
            const nested = search(value, depth + 1);
            if (nested) return nested;
          }
        }
        return undefined;
      }
      if (ts.isArrayLiteralExpression(expr) || ts.isStringLiteralLike(expr)) return undefined;
      if (depth < 3) {
        const initializer = this.initializerOf(expr);
        if (initializer && initializer !== 'parameter') return search(initializer, depth + 1);
      }
      opaque = true;
      return undefined;
    };
    // Known helpers name their options argument; for child_process the options
    // follow the command and an optional argv array.
    const optionArgs =
      optionsIndex !== undefined
        ? call.arguments.slice(optionsIndex, optionsIndex + 1)
        : call.arguments.slice(1).filter((arg) => !this.isArgvArgument(arg));
    for (const arg of optionArgs) {
      const found = search(arg, 0);
      if (found) return found;
    }
    return opaque ? 'opaque' : 'absent';
  }

  private isArgvArgument(arg: ts.Expression): boolean {
    const expr = unwrapExpression(arg);
    if (ts.isArrayLiteralExpression(expr) || ts.isStringLiteralLike(expr)) return true;
    if (ts.isIdentifier(expr) && /^(args|argv|.*Args)$/.test(expr.text)) return true;
    const initializer = this.initializerOf(expr);
    return (
      !!initializer &&
      initializer !== 'parameter' &&
      ts.isArrayLiteralExpression(unwrapExpression(initializer))
    );
  }

  private recordSpawn(
    unit: Unit,
    call: ts.CallExpression,
    inheritsByDefault: boolean,
    optionsIndex?: number
  ): void {
    // The helpers themselves are modelled at their call sites.
    const enclosing = unit.roots[0];
    if (
      enclosing &&
      ts.isFunctionDeclaration(enclosing) &&
      this.spawnHelperDeclarations.has(enclosing)
    ) {
      return;
    }
    const env = this.spawnEnv(call, optionsIndex);
    const inheritsSystemRole =
      env === 'absent' ? inheritsByDefault : env === 'opaque' ? true : this.envInherits(env);
    const strings = call.arguments.flatMap((arg) => this.collectStrings(arg));
    const targets = new Set<string>();
    const [command] = call.arguments;
    const commandExpression = command ? unwrapExpression(command) : undefined;
    const commandText =
      commandExpression && ts.isStringLiteralLike(commandExpression)
        ? commandExpression.text
        : undefined;
    const packageRunner = commandText === 'pnpm' || commandText === 'npm';
    for (const value of strings) {
      const source = sourceForScriptReference(this.ws, value);
      if (source) targets.add(this.ws.rel(source));
      const script = packageRunner ? this.packageScripts[value] : undefined;
      if (script) {
        for (const token of script.split(/\s+/)) {
          const scriptSource = sourceForScriptReference(this.ws, token);
          if (scriptSource) targets.add(this.ws.rel(scriptSource));
        }
      }
    }
    const reviewed = REVIEWED_CHILD_PROCESSES[unit.id];
    let reviewedExternal = false;
    if (reviewed && inheritsSystemRole) {
      const reviewedTargets =
        typeof reviewed.targets === 'function' ? reviewed.targets(this.ws) : reviewed.targets;
      for (const file of expandModuleGlobs(this.ws, reviewedTargets))
        targets.add(this.ws.rel(file));
      reviewedExternal = reviewedTargets.length === 0;
    }
    const kyberionCapable =
      !reviewedExternal &&
      (commandText === undefined ||
        KYBERION_CAPABLE_COMMANDS.has(commandText.split(/\s+/)[0] ?? '') ||
        targets.size > 0);
    this.spawnRecords.push({
      unit,
      site: this.position(call),
      inheritsSystemRole,
      kyberionCapable,
      targets: [...targets].sort(),
    });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface PolicyFile {
  shared_core_roles: { roles: string[] };
  system_roles: Record<string, { may_assume: string[] }>;
}

function bfs(analyzer: Analyzer, entryUnits: Unit[]): Map<Unit, Unit | null> {
  const parents = new Map<Unit, Unit | null>();
  const queue: Unit[] = [];
  for (const unit of entryUnits) {
    if (parents.has(unit)) continue;
    parents.set(unit, null);
    queue.push(unit);
  }
  for (let index = 0; index < queue.length; index += 1) {
    const unit = queue[index];
    for (const next of analyzer.edges.get(unit) ?? []) {
      if (parents.has(next)) continue;
      parents.set(next, unit);
      queue.push(next);
    }
  }
  return parents;
}

/**
 * The BFS path to `unit`. A child-process entry continues through the unit
 * that spawned it (`childOrigins`, keyed by the child entry file).
 */
function pathTo(
  parents: Map<Unit, Unit | null>,
  unit: Unit,
  childOrigins: Map<string, Unit> = new Map()
): string[] {
  const chain: string[] = [];
  const seen = new Set<Unit>();
  let current: Unit | null | undefined = unit;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = parents.get(current);
    const origin = parent === null ? childOrigins.get(current.file) : undefined;
    chain.unshift(origin ? `${current.id} [child process]` : current.id);
    current = origin ?? parent;
  }
  return chain;
}

function entryUnitsFor(analyzer: Analyzer, ws: Workspace, files: string[]): Unit[] {
  const units: Unit[] = [];
  for (const file of files) {
    const rel = ws.rel(file);
    for (const unit of analyzer.units.unitsOfFile(rel)) {
      if (!unit.lazy || unit.exported || unit.entryOnly) units.push(unit);
    }
  }
  return units;
}

export function buildReachabilityReport(
  root: string = pathResolver.rootDir()
): RoleAssumptionReachabilityReport {
  const ws = createWorkspace(root);
  const entries = collectSystemRoleEntries(ws);
  const packageJson = readSafeJsonFile<{ scripts?: Record<string, string> }>(
    path.join(root, 'package.json'),
    'package.json'
  );
  const allRoots = new Set<string>();
  for (const files of entries.values()) for (const file of files) allRoots.add(file);
  // Child-process targets are added lazily; include every script so the program
  // already holds them (they are only walked when a spawn reaches them).
  for (const dir of ['scripts', 'libs/actuators']) {
    for (const file of collectSources(ws, ws.abs(dir))) allRoots.add(file);
  }
  const program = createProgram(ws, [...allRoots].sort());
  const analyzer = new Analyzer(ws, program, packageJson.scripts ?? {});
  const policy = readSafeJsonFile<PolicyFile>(
    path.join(root, POLICY_PATH),
    'role assumption policy'
  );

  const recordsByUnit = new Map<Unit, RoleRecord[]>();
  for (const record of analyzer.roleRecords) {
    const list = recordsByUnit.get(record.unit) ?? [];
    list.push(record);
    recordsByUnit.set(record.unit, list);
  }
  const spawnsByUnit = new Map<Unit, SpawnRecord[]>();
  for (const record of analyzer.spawnRecords) {
    const list = spawnsByUnit.get(record.unit) ?? [];
    list.push(record);
    spawnsByUnit.set(record.unit, list);
  }

  const systemRoles: Record<string, SystemRoleReachability> = {};
  const unresolvedSites = new Map<string, Set<string>>();
  for (const [systemRole, files] of entries) {
    const entryFiles = new Set(files.map((file) => ws.rel(file)));
    const childEntries: ChildProcessEntry[] = [];
    const childOrigins = new Map<string, Unit>();
    let parents = new Map<Unit, Unit | null>();
    // Iterate: spawned children that inherit SYSTEM_ROLE add their own entries.
    for (;;) {
      parents = bfs(
        analyzer,
        entryUnitsFor(
          analyzer,
          ws,
          [...entryFiles].map((rel) => ws.abs(rel))
        )
      );
      let added = false;
      for (const unit of parents.keys()) {
        for (const spawn of spawnsByUnit.get(unit) ?? []) {
          if (!spawn.inheritsSystemRole || spawn.targets.length === 0) continue;
          for (const target of spawn.targets) {
            if (!entryFiles.has(target)) {
              entryFiles.add(target);
              childOrigins.set(target, unit);
              added = true;
            }
          }
          const existing = childEntries.find((entry) => entry.site === spawn.site);
          if (existing) {
            existing.targets = [...new Set([...existing.targets, ...spawn.targets])].sort();
          } else {
            childEntries.push({ site: spawn.site, targets: spawn.targets });
          }
        }
      }
      if (!added) break;
    }
    const reachable: Record<string, ReachableRole> = {};
    const reviewedInfeasible: ReviewedInfeasible[] = [];
    const unresolved = new Set<string>();
    const addUnresolved = (site: string, reason: string): void => {
      unresolved.add(site);
      const reasons = unresolvedSites.get(site) ?? new Set<string>();
      reasons.add(reason);
      unresolvedSites.set(site, reasons);
    };
    for (const unit of [...parents.keys()].sort((a, b) => a.id.localeCompare(b.id))) {
      for (const record of recordsByUnit.get(unit) ?? []) {
        for (const role of [...record.roles].sort()) {
          const infeasible = REVIEWED_INFEASIBLE_ASSUMPTIONS.find(
            (entry) =>
              entry.role === role &&
              entry.systemRoles.includes(systemRole) &&
              (record.site === entry.site || record.site.startsWith(`${entry.site} `))
          );
          if (infeasible) {
            if (
              !reviewedInfeasible.some(
                (item) => item.role === role && item.site === infeasible.site
              )
            ) {
              reviewedInfeasible.push({
                role,
                site: infeasible.site,
                rationale: infeasible.rationale,
              });
            }
            continue;
          }
          if (!reachable[role]) {
            reachable[role] = { example_path: pathTo(parents, unit, childOrigins) };
          }
        }
        for (const reason of record.unresolved) addUnresolved(record.site, reason);
      }
      for (const reason of analyzer.unresolvedEdges.get(unit) ?? []) {
        addUnresolved(unit.id, reason);
      }
      for (const spawn of spawnsByUnit.get(unit) ?? []) {
        if (spawn.inheritsSystemRole && spawn.kyberionCapable && spawn.targets.length === 0) {
          addUnresolved(
            spawn.site,
            'child process may inherit SYSTEM_ROLE and its entry point could not be resolved'
          );
        }
      }
    }
    // A child entry the program does not hold cannot be walked: any role.
    for (const rel of entryFiles) {
      if (!program.getSourceFile(ws.abs(rel))) {
        addUnresolved(rel, 'child process entry point is outside the analysed program');
      }
    }
    const allowed = new Set([
      ...(policy.shared_core_roles?.roles ?? []),
      ...(policy.system_roles?.[systemRole]?.may_assume ?? []),
    ]);
    systemRoles[systemRole] = {
      entries: files.map((file) => ws.rel(file)).sort(),
      reviewed_infeasible: reviewedInfeasible.sort((a, b) =>
        `${a.role}|${a.site}`.localeCompare(`${b.role}|${b.site}`)
      ),
      child_process_entries: childEntries.sort((a, b) => a.site.localeCompare(b.site)),
      reachable_roles: Object.fromEntries(
        Object.entries(reachable).sort(([a], [b]) => a.localeCompare(b))
      ),
      unresolved_sites: [...unresolved].sort(),
      // An unresolved site may assume any role: nothing is provably unreachable.
      policy_roles_not_reachable:
        unresolved.size > 0
          ? []
          : [...allowed].filter((role) => role !== systemRole && !reachable[role]).sort(),
    };
  }

  const siteMap = new Map<string, AssumptionSiteReport>();
  for (const record of analyzer.roleRecords) {
    const existing = siteMap.get(record.site) ?? { site: record.site, roles: [], unresolved: [] };
    existing.roles = [...new Set([...existing.roles, ...record.roles])].sort();
    existing.unresolved = [...new Set([...existing.unresolved, ...record.unresolved])].sort();
    siteMap.set(record.site, existing);
  }

  return {
    version: 1,
    generated_by: 'scripts/analyze_role_assumptions.ts',
    description:
      'RN-02 call-level reachability of in-process role assumptions per SYSTEM_ROLE. Regenerate with `node --import ./scripts/ts-loader.mjs scripts/analyze_role_assumptions.ts`; see knowledge/product/governance/AUTHORITY_MODEL.md section 3.B2.',
    assumption_sites: [...siteMap.values()].sort((a, b) => a.site.localeCompare(b.site)),
    unresolved_sites: Object.fromEntries(
      [...unresolvedSites.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([site, reasons]) => [site, [...reasons].sort()])
    ),
    system_roles: systemRoles,
  };
}

export function renderReachabilityReport(report: RoleAssumptionReachabilityReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Compare reports by content so formatter (prettier) layout never reads as staleness. */
export function normalizeReachabilityReport(content: string): string {
  try {
    return JSON.stringify(parseSafeJsonInput(content, 'role assumption reachability report'));
  } catch {
    return content;
  }
}

export const main = defineGenerator({
  id: 'role-assumption-reachability',
  outputs: [REACHABILITY_REPORT_PATH],
  normalize: normalizeReachabilityReport,
  render() {
    return [
      {
        path: REACHABILITY_REPORT_PATH,
        content: renderReachabilityReport(buildReachabilityReport()),
      },
    ];
  },
});

if (
  isDirectScript(import.meta.url, 'analyze_role_assumptions.ts') ||
  isDirectScript(import.meta.url, 'analyze_role_assumptions.js')
) {
  void main();
}
