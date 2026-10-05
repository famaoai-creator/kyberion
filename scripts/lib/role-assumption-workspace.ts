/**
 * RN-02 workspace model for scripts/analyze_role_assumptions.ts: repository
 * file discovery, module resolution (relative, workspace packages, the
 * Next.js `@/` alias), system role entry points and the TypeScript program.
 * Reads go through secure-io; nothing outside the repository is resolved.
 */
import * as path from 'node:path';
import * as ts from 'typescript';
import { readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeReaddir, safeStat } from '@agent/core/secure-io';
import { readSafeJsonFile } from './json-input.js';

const SURFACE_MANIFEST_DIR = 'knowledge/product/governance/surfaces';

/** System roles set by launchers other than the surface manifests (AUTHORITY_MODEL.md 3.B2). */
const EXTRA_SYSTEM_ROLE_ENTRIES: Record<string, string[]> = {
  surface_runtime: ['scripts/surface_runtime.ts'],
  system_configurator: ['scripts/config_mission.ts', 'scripts/run_pipeline.ts'],
};

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

export function createWorkspace(root: string): Workspace {
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

export function isProjectSource(ws: Workspace, file: string): boolean {
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

export function collectSources(ws: Workspace, dir: string): string[] {
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

/** Resolve a module specifier from `containingFile` to a project source, or null. */
export type ModuleResolver = (specifier: string, containingFile: string) => string | null;

/** Deterministic, locale-independent ordering (UTF-16 code units). */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Is `dir` (POSIX-normalised) the workspace root or below it? */
function isWithinRoot(root: string, dir: string): boolean {
  const posixRoot = toPosix(root);
  const posixDir = toPosix(dir);
  return posixDir === posixRoot || posixDir.startsWith(`${posixRoot}/`);
}

export function createResolver(ws: Workspace): ModuleResolver {
  const packages = loadWorkspacePackages(ws);
  const appRootCache = new Map<string, string | null>();
  const appRootFor = (file: string): string | null => {
    let dir = path.dirname(file);
    const visited: string[] = [];
    while (isWithinRoot(ws.root, dir) && toPosix(dir) !== toPosix(ws.root)) {
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
  cwd?: string;
}

function nextAppEntries(ws: Workspace, appDir: string): string[] {
  return collectSources(ws, appDir).filter((file) => {
    const rel = ws.rel(file);
    return !rel.includes('/test/') && !rel.endsWith('next-env.d.ts');
  });
}

/** Root package.json script body for `pnpm <script>` surface commands. */
function rootPackageScript(ws: Workspace, name: string): string | null {
  const manifestPath = ws.abs('package.json');
  if (!ws.isFile(manifestPath)) return null;
  const manifest = readSafeJsonFile<{ scripts?: Record<string, string> }>(
    manifestPath,
    'root package manifest'
  );
  const script = manifest.scripts?.[name];
  return typeof script === 'string' ? script : null;
}

function entriesForCommand(ws: Workspace, entry: SurfaceManifestEntry): string[] {
  const args = entry.args ?? [];
  // Workspace Next.js launchers execute dependency code, but authority belongs
  // to the app sources in their declared working directory.
  if (
    entry.command === 'node' &&
    args[0]?.replace(/\\/g, '/') === 'node_modules/next/dist/bin/next' &&
    entry.cwd
  ) {
    return nextAppEntries(ws, ws.abs(entry.cwd));
  }
  if (entry.command === 'pnpm') {
    const dirIndex = args.indexOf('--dir');
    if (dirIndex >= 0 && args[dirIndex + 1]) {
      return nextAppEntries(ws, ws.abs(args[dirIndex + 1]));
    }
    // `pnpm <script>`: follow the root package.json script to its entry file.
    const script = args[0] ? rootPackageScript(ws, args[0]) : null;
    if (script) {
      return script
        .split(/\s+/u)
        .map((token) => sourceForScriptReference(ws, token))
        .filter((source): source is string => Boolean(source));
    }
  }
  const files: string[] = [];
  for (const arg of args) {
    const source = sourceForScriptReference(ws, arg);
    if (source) files.push(source);
  }
  return files;
}

/**
 * `dist/x/y.js`, `x/y.ts`, `./x/y.js`, `pkg/dist/y.js` → the TypeScript
 * source, when it exists (a workspace package's `dist/` maps to its `src/`).
 */
export function sourceForScriptReference(ws: Workspace, reference: string): string | null {
  const cleaned = reference.replace(/^\.\//, '').replace(/^dist\//, '');
  if (!/\.(m?[jt]s|tsx)$/.test(cleaned)) return null;
  const candidates = [cleaned];
  if (cleaned.includes('/dist/')) candidates.push(cleaned.replace('/dist/', '/src/'));
  for (const candidate of candidates) {
    const found = tryFile(ws, ws.abs(candidate));
    if (found && isProjectSource(ws, found)) return found;
  }
  return null;
}

export function collectSystemRoleEntries(ws: Workspace): Map<string, string[]> {
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
  return new Map([...entries.entries()].sort(([a], [b]) => compareCodeUnits(a, b)));
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

export function createProgram(
  ws: Workspace,
  rootNames: string[],
  resolve: ModuleResolver = createResolver(ws)
): ts.Program {
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

/** Expand repo-relative patterns where `*` matches one path segment. */
export function expandModuleGlobs(ws: Workspace, patterns: readonly string[]): string[] {
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
