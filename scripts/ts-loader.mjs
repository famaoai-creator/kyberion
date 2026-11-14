/**
 * TypeScript loader for `node --import ./scripts/ts-loader.mjs <script>.ts`.
 *
 * Bootstrap constraint: this file is what makes TypeScript importable, so it
 * cannot import `@agent/core/secure-io` (a TypeScript module whose import graph
 * would re-enter these hooks and load the tier-guard stack before the script
 * runs). It reads workspace sources with `node:fs` directly (listed in
 * tests/fixtures/governance-import-baseline.json). Transpiling, and the
 * transpile cache, live in ./ts-loader-cache.mjs.
 */
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { dirname, extname, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import {
  preservesSymlinks,
  transpileWithCache,
  tsLoaderFastResolveEnabled,
} from './ts-loader-cache.mjs';

const PRESERVE_SYMLINKS = preservesSymlinks();

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const JS_LIKE_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']);
const ROOT_DIR = process.cwd();
const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

function isWorkspacePath(filePath) {
  return (
    (filePath.startsWith(ROOT_DIR) || filePath.startsWith(PROJECT_ROOT)) &&
    !filePath.includes('/node_modules/')
  );
}

function isFileUrl(specifier) {
  return specifier.startsWith('file:');
}

function toFilePath(specifier, parentURL) {
  if (isFileUrl(specifier)) return fileURLToPath(specifier);
  if (specifier.startsWith('/')) return specifier;
  const parentPath = parentURL && isFileUrl(parentURL) ? fileURLToPath(parentURL) : process.cwd();
  return resolvePath(dirname(parentPath), specifier);
}

function resolveCandidatePath(candidate) {
  return existsSync(candidate) ? pathToFileURL(candidate).href : null;
}

const CORE_ROOT = resolvePath(PROJECT_ROOT, 'libs/core');
const CORE_DIST = resolvePath(CORE_ROOT, 'dist');

/**
 * One @agent/core per process: either its built dist or its source, never both.
 * Two copies of the same module mean two copies of every module-private
 * registry (opaque grants, seams, backends), so a grant issued by one copy is
 * not honoured by the other. The choice is made once, by whichever comes first:
 *   - the first `@agent/core` specifier: dist when libs/core/dist/index.js
 *     exists, source otherwise;
 *   - the first relative import of a libs/core TypeScript module (only the
 *     bootstrap scripts allowlisted by scripts/check/check_core_single_instance.ts
 *     do this): source.
 * After that, a `@agent/core` subpath whose dist file is missing (a stale or
 * partial build) is not quietly answered from source next to loaded dist
 * modules; it fails like any unbuilt export, and a dist built while a source
 * process runs (pnpm build) is not picked up by that process.
 */
let coreInstance = null;
function latchCoreInstance(kind) {
  if (coreInstance === null) coreInstance = kind;
  return coreInstance;
}

function isCoreSourceModule(filePath) {
  return (
    filePath.startsWith(CORE_ROOT + sep) &&
    !filePath.startsWith(CORE_DIST + sep) &&
    TS_EXTENSIONS.has(extname(filePath))
  );
}

let coreExportTargets = null;
/** Source file behind an aliased export (e.g. `./a2a-bridge` -> `./dist/mesh/a2a-bridge.js`). */
function coreExportSource(subpath) {
  if (coreExportTargets === null) {
    try {
      const manifest = JSON.parse(readFileSync(resolvePath(CORE_ROOT, 'package.json'), 'utf8'));
      coreExportTargets = manifest.exports ?? {};
    } catch {
      coreExportTargets = {};
    }
  }
  const entry = coreExportTargets[subpath === 'index' ? '.' : './' + subpath];
  const target = typeof entry === 'string' ? entry : (entry?.default ?? entry?.import);
  if (typeof target !== 'string' || !target.startsWith('./dist/') || !target.endsWith('.js'))
    return null;
  const stem = resolvePath(CORE_ROOT, target.slice('./dist/'.length, -'.js'.length));
  return resolveCandidatePath(stem + '.ts') ?? resolveCandidatePath(stem + '.mts');
}

function resolveWorkspacePackageToSource(specifier) {
  let subpath;
  if (specifier === '@agent/core') {
    subpath = 'index';
  } else if (specifier.startsWith('@agent/core/')) {
    subpath = specifier.slice('@agent/core/'.length);
  } else {
    return null;
  }

  const instance = latchCoreInstance(
    existsSync(resolvePath(CORE_DIST, 'index.js')) ? 'dist' : 'source'
  );
  if (instance === 'dist') return null;

  const candidates = [
    resolvePath(CORE_ROOT, `${subpath}.ts`),
    resolvePath(CORE_ROOT, subpath, 'index.ts'),
    resolvePath(CORE_ROOT, 'src', `${subpath}.ts`),
    resolvePath(CORE_ROOT, 'src', subpath, 'index.ts'),
  ];
  for (const candidate of candidates) {
    const resolved = resolveCandidatePath(candidate);
    if (resolved) return resolved;
  }
  return coreExportSource(subpath);
}

/**
 * Answer a workspace TypeScript resolution here instead of through the default
 * resolver. The default resolver detects the format of every `.ts` URL (Node
 * 24 strips types by default) with `getPackageScopeConfig`, which re-parses
 * the nearest package.json's whole `exports` map each time: for a
 * `libs/core/*.ts` module that is the ~290KB `libs/core/package.json`, about
 * half of a cold child's start-up. The load hook decides the format of these
 * files anyway, so nothing is lost. Same URL as the default resolver (realpath,
 * as without --preserve-symlinks; with it, in argv or NODE_OPTIONS, it stands aside); `KYBERION_TS_LOADER_FAST_RESOLVE=0` restores
 * the default-resolver path (differential test: ts-loader-resolve.test.ts).
 */
function resolveTsSourceDirectly(candidate) {
  const ext = extname(candidate);
  if (!TS_EXTENSIONS.has(ext)) return null;
  if (!tsLoaderFastResolveEnabled()) return null;
  if (PRESERVE_SYMLINKS) return null;
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    return null;
  }
  return {
    url: pathToFileURL(real).href,
    format: ext === '.cts' ? 'commonjs' : 'module',
    shortCircuit: true,
  };
}

function resolveTsLike(specifier, context, nextResolve) {
  if (!(specifier.startsWith('.') || specifier.startsWith('/'))) {
    const workspaceSource = resolveWorkspacePackageToSource(specifier);
    if (workspaceSource) {
      return { url: workspaceSource, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }

  const parentPath =
    context.parentURL && isFileUrl(context.parentURL) ? fileURLToPath(context.parentURL) : ROOT_DIR;
  if (!isWorkspacePath(parentPath)) {
    return nextResolve(specifier, context);
  }

  const sourcePath = toFilePath(specifier, context.parentURL);
  const sourceExt = extname(sourcePath);
  const candidates = [];

  if (sourceExt) {
    candidates.push(sourcePath);
  }

  if (JS_LIKE_EXTENSIONS.has(sourceExt) || !sourceExt) {
    const stem = sourceExt ? sourcePath.slice(0, -sourceExt.length) : sourcePath;
    candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
    candidates.push(
      resolvePath(sourcePath, 'index.ts'),
      resolvePath(sourcePath, 'index.tsx'),
      resolvePath(sourcePath, 'index.mts'),
      resolvePath(sourcePath, 'index.cts')
    );
  }

  for (const candidate of candidates) {
    const resolved = resolveCandidatePath(candidate);
    if (resolved) {
      if (isCoreSourceModule(candidate)) latchCoreInstance('source');
      const fast = resolveTsSourceDirectly(candidate);
      if (fast) return fast;
      // The CJS default resolver cannot handle file:// URL specifiers; when the
      // specifier already resolves as-is (no .js→.ts rewrite), pass it through.
      if (candidate === sourcePath) {
        return nextResolve(specifier, context);
      }
      return nextResolve(resolved, context);
    }
  }

  return nextResolve(specifier, context);
}

function loadTsLike(url, context, nextLoad) {
  const filePath = isFileUrl(url) ? fileURLToPath(url) : null;
  if (!filePath) {
    return nextLoad(url, context);
  }

  if (!isWorkspacePath(filePath)) {
    return nextLoad(url, context);
  }

  const ext = extname(filePath);
  if (!TS_EXTENSIONS.has(ext)) {
    return nextLoad(url, context);
  }

  const source = readFileSync(filePath, 'utf8');
  const result = transpileWithCache(filePath, source);

  return {
    format: ext === '.cts' ? 'commonjs' : 'module',
    source: result.outputText,
    shortCircuit: true,
  };
}

registerHooks({
  resolve: resolveTsLike,
  load: loadTsLike,
});
