/**
 * Resolve an import captured by tree-sitter to files inside the analyzed
 * source (internal edge), a third-party name (external dependency), or neither
 * (unresolved — reported, never guessed). Paths are POSIX, relative to the
 * source root.
 */
import * as path from 'node:path';
import type { CodeGraphImportRule } from '@agent/core/source-analysis';

export interface ImportResolutionContext {
  files: ReadonlySet<string>;
  /** C# namespace → files declaring it. */
  namespaces: ReadonlyMap<string, string[]>;
  readText(relative: string): string;
}

export type ImportResolution =
  | { kind: 'internal'; files: string[] }
  | { kind: 'external'; name: string }
  | { kind: 'unresolved' };

const posix = path.posix;

function pushTo(index: Map<string, string[]>, key: string, value: string): void {
  const list = index.get(key);
  if (list) list.push(value);
  else index.set(key, [value]);
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"`<]|['"`>]$/gu, '');
}

function normalize(candidate: string): string | null {
  const normalized = posix.normalize(candidate);
  return normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)
    ? null
    : normalized;
}

function firstExisting(candidates: string[], files: ReadonlySet<string>): string | undefined {
  return candidates
    .map(normalize)
    .find((candidate): candidate is string => !!candidate && files.has(candidate));
}

function packageName(source: string): string {
  const parts = source.split('/');
  return source.startsWith('@') && parts.length > 1 ? `${parts[0]}/${parts[1]}` : parts[0];
}

function resolveRelativePath(
  rule: CodeGraphImportRule,
  from: string,
  source: string,
  ctx: ImportResolutionContext
): ImportResolution {
  const spec = stripQuotes(source);
  const suffixes = rule.candidates?.length ? rule.candidates : [''];
  const dir = posix.dirname(from);
  const relative = spec.startsWith('./') || spec.startsWith('../');
  // `bare_specifier: package` (JS/TS): `react` names a package. `path` (C/C++,
  // PHP, Ruby require_relative): a bare include is a file path relative to the
  // including file, then to the source root.
  if (!relative && rule.bare_specifier !== 'path') {
    return spec ? { kind: 'external', name: packageName(spec) } : { kind: 'unresolved' };
  }
  const bases = relative ? [posix.join(dir, spec)] : [posix.join(dir, spec), spec];
  // TypeScript ESM imports name the emitted file: `./x.js` is `./x.ts` in source.
  const emitted = spec.match(/\.(m|c)?jsx?$/u);
  if (emitted && relative) {
    const stem = posix.join(dir, spec.slice(0, -emitted[0].length));
    const sourceExts = emitted[0] === '.jsx' ? ['.tsx'] : [`.${emitted[1] ?? ''}ts`, '.tsx'];
    bases.push(...sourceExts.map((ext) => stem + ext));
  }
  const found = firstExisting(
    bases.flatMap((base) => suffixes.map((suffix) => base + suffix)),
    ctx.files
  );
  if (found) return { kind: 'internal', files: [found] };
  // A path-style include/require that names no file is a gap to report, not a dependency.
  return { kind: 'unresolved' };
}

function resolvePythonModule(
  from: string,
  source: string,
  ctx: ImportResolutionContext
): ImportResolution {
  const spec = source.trim();
  const moduleCandidates = (base: string): string[] => [`${base}.py`, `${base}/__init__.py`];
  if (spec.startsWith('.')) {
    const level = spec.match(/^\.+/u)![0].length;
    let dir = posix.dirname(from);
    for (let i = 1; i < level; i += 1) dir = posix.dirname(dir);
    const rest = spec.slice(level).replaceAll('.', '/');
    const found = firstExisting(
      rest ? moduleCandidates(posix.join(dir, rest)) : [posix.join(dir, '__init__.py')],
      ctx.files
    );
    return found ? { kind: 'internal', files: [found] } : { kind: 'unresolved' };
  }
  const asPath = spec.replaceAll('.', '/');
  const roots = ['', 'src/', 'lib/', 'app/'];
  const found = firstExisting(
    roots.flatMap((root) => moduleCandidates(root + asPath)),
    ctx.files
  );
  if (found) return { kind: 'internal', files: [found] };
  // `from pkg.mod import name` where pkg/mod.py does not exist but pkg/__init__.py does.
  const parent = asPath.includes('/') ? asPath.slice(0, asPath.lastIndexOf('/')) : '';
  const parentFound =
    parent &&
    firstExisting(
      roots.flatMap((root) => moduleCandidates(root + parent)),
      ctx.files
    );
  if (parentFound) return { kind: 'internal', files: [parentFound] };
  return { kind: 'external', name: spec.split('.')[0] };
}

interface JvmIndex {
  byBase: Map<string, string[]>;
  byDirBase: Map<string, string[]>;
}

const JVM_SOURCE = /\.(java|scala|kt)$/u;
const jvmIndexes = new WeakMap<ImportResolutionContext, JvmIndex>();

function jvmIndex(ctx: ImportResolutionContext): JvmIndex {
  let index = jvmIndexes.get(ctx);
  if (!index) {
    index = { byBase: new Map(), byDirBase: new Map() };
    for (const file of ctx.files) {
      if (!JVM_SOURCE.test(file)) continue;
      const base = posix.basename(file).replace(JVM_SOURCE, '');
      pushTo(index.byBase, base, file);
      pushTo(index.byDirBase, posix.basename(posix.dirname(file)), file);
    }
    jvmIndexes.set(ctx, index);
  }
  return index;
}

function resolveQualifiedName(
  from: string,
  source: string,
  ctx: ImportResolutionContext
): ImportResolution {
  // Java `import [static] a.b.C[.member|.*];` and Scala `import a.b.{C, D}` / `a.b._`.
  const spec = source
    .replace(/^import\s+/u, '')
    .replace(/^static\s+/u, '')
    .replace(/;$/u, '')
    .replace(/\.\{[^}]*\}$/u, '')
    .replace(/\.(\*|_)$/u, '')
    .trim();
  if (!spec) return { kind: 'unresolved' };
  const index = jvmIndex(ctx);
  const segments = spec.split('.');
  // Mixed JVM trees: prefer targets in the importing file's own language.
  const ownExt = posix.extname(from);
  const preferOwn = (hits: string[]): string[] => {
    const own = hits.filter((file) => posix.extname(file) === ownExt);
    return (own.length ? own : hits).sort();
  };
  // Longest prefix first: a.b.C.member → a/b/C, then the package a/b as a directory.
  for (let length = segments.length; length >= 2; length -= 1) {
    const suffix = segments.slice(0, length).join('/');
    const last = segments[length - 1];
    const fileHits = (index.byBase.get(last) ?? []).filter((file) =>
      `/${file.replace(JVM_SOURCE, '')}`.endsWith(`/${suffix}`)
    );
    if (fileHits.length) return { kind: 'internal', files: preferOwn(fileHits) };
    if (length === segments.length) {
      const dirHits = (index.byDirBase.get(last) ?? []).filter((file) =>
        `/${posix.dirname(file)}`.endsWith(`/${suffix}`)
      );
      if (dirHits.length) return { kind: 'internal', files: preferOwn(dirHits) };
    }
  }
  return { kind: 'external', name: segments.slice(0, 2).join('.') };
}

function resolveNamespace(source: string, ctx: ImportResolutionContext): ImportResolution {
  const spec = source.trim();
  const files = ctx.namespaces.get(spec);
  if (files?.length) return { kind: 'internal', files: [...new Set(files)].sort() };
  return { kind: 'external', name: spec.split('.')[0] };
}

const goModules = new WeakMap<ImportResolutionContext, { dir: string; module: string }[]>();

function goModuleRoots(ctx: ImportResolutionContext): { dir: string; module: string }[] {
  let roots = goModules.get(ctx);
  if (!roots) {
    roots = [...ctx.files]
      .filter((file) => posix.basename(file) === 'go.mod')
      .flatMap((file) => {
        const match = ctx.readText(file).match(/^module\s+(\S+)/mu);
        return match ? [{ dir: posix.dirname(file), module: match[1] }] : [];
      })
      .sort((left, right) => right.module.length - left.module.length);
    goModules.set(ctx, roots);
  }
  return roots;
}

const goDirs = new WeakMap<ImportResolutionContext, Map<string, string[]>>();

function goDirIndex(ctx: ImportResolutionContext): Map<string, string[]> {
  let index = goDirs.get(ctx);
  if (!index) {
    index = new Map();
    for (const file of ctx.files) {
      if (!file.endsWith('.go') || file.endsWith('_test.go')) continue;
      const dir = posix.dirname(file);
      pushTo(index, dir, file);
    }
    goDirs.set(ctx, index);
  }
  return index;
}

function resolveGoPackage(source: string, ctx: ImportResolutionContext): ImportResolution {
  const spec = stripQuotes(source);
  const root = goModuleRoots(ctx).find(
    (entry) => spec === entry.module || spec.startsWith(`${entry.module}/`)
  );
  if (!root) return { kind: 'external', name: spec };
  const rel = spec.slice(root.module.length).replace(/^\//u, '');
  const dir = normalize(posix.join(root.dir, rel)) ?? '';
  const files = goDirIndex(ctx).get(dir || '.') ?? [];
  return files.length ? { kind: 'internal', files: [...files].sort() } : { kind: 'unresolved' };
}

function rustModuleDir(from: string): string {
  const base = posix.basename(from);
  const dir = posix.dirname(from);
  return base === 'mod.rs' || base === 'main.rs' || base === 'lib.rs'
    ? dir
    : posix.join(dir, base.replace(/\.rs$/u, ''));
}

function rustCrateRoot(from: string, ctx: ImportResolutionContext): string {
  let dir = posix.dirname(from);
  while (dir && dir !== '.') {
    if (ctx.files.has(posix.join(dir, 'main.rs')) || ctx.files.has(posix.join(dir, 'lib.rs'))) {
      if (
        posix.basename(dir) === 'src' ||
        !ctx.files.has(posix.join(posix.dirname(dir), 'src/lib.rs'))
      )
        return dir;
    }
    dir = posix.dirname(dir);
  }
  return ctx.files.has('src/lib.rs') || ctx.files.has('src/main.rs') ? 'src' : '.';
}

function resolveRustModule(
  from: string,
  source: string,
  ctx: ImportResolutionContext
): ImportResolution {
  const spec = source.trim();
  const candidates = (dir: string, segments: string[]): string[] => {
    const out: string[] = [];
    for (let length = segments.length; length >= 1; length -= 1) {
      const joined = posix.join(dir, ...segments.slice(0, length));
      out.push(`${joined}.rs`, `${joined}/mod.rs`);
    }
    return out;
  };
  if (!spec.includes('::')) {
    // `mod name;` declares a child module file.
    const found = firstExisting(candidates(rustModuleDir(from), [spec]), ctx.files);
    return found ? { kind: 'internal', files: [found] } : { kind: 'unresolved' };
  }
  const segments = spec
    .split('::')
    .map((segment) => segment.trim())
    .filter(Boolean);
  const head = segments[0];
  let base: string;
  if (head === 'crate') base = rustCrateRoot(from, ctx);
  else if (head === 'self') base = rustModuleDir(from);
  else if (head === 'super') base = posix.dirname(rustModuleDir(from));
  else return { kind: 'external', name: head };
  const found = firstExisting(candidates(base, segments.slice(1)), ctx.files);
  return found ? { kind: 'internal', files: [found] } : { kind: 'unresolved' };
}

export function resolveImport(
  rule: CodeGraphImportRule,
  from: string,
  source: string,
  ctx: ImportResolutionContext
): ImportResolution {
  switch (rule.resolver) {
    case 'relative_path':
      return resolveRelativePath(rule, from, source, ctx);
    case 'python_module':
      return resolvePythonModule(from, source, ctx);
    case 'qualified_name':
      return resolveQualifiedName(from, source, ctx);
    case 'namespace':
      return resolveNamespace(source, ctx);
    case 'go_package':
      return resolveGoPackage(source, ctx);
    case 'rust_module':
      return resolveRustModule(from, source, ctx);
  }
}
