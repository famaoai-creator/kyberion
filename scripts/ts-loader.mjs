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
import { dirname, extname, resolve as resolvePath } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { registerHooks } from 'node:module';
import { transpileWithCache } from './ts-loader-cache.mjs';

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

function resolveWorkspacePackageToSource(specifier) {
  let packageRoot;
  let subpath;
  if (specifier === '@agent/core') {
    packageRoot = resolvePath(PROJECT_ROOT, 'libs/core');
    subpath = 'index';
  } else if (specifier.startsWith('@agent/core/')) {
    packageRoot = resolvePath(PROJECT_ROOT, 'libs/core');
    subpath = specifier.slice('@agent/core/'.length);
  } else {
    return null;
  }

  const distJs = resolvePath(packageRoot, 'dist', `${subpath}.js`);
  const distIndex = resolvePath(packageRoot, 'dist', subpath, 'index.js');
  if (existsSync(distJs) || existsSync(distIndex)) {
    return null;
  }

  const candidates = [
    resolvePath(packageRoot, `${subpath}.ts`),
    resolvePath(packageRoot, subpath, 'index.ts'),
    resolvePath(packageRoot, 'src', `${subpath}.ts`),
    resolvePath(packageRoot, 'src', subpath, 'index.ts'),
  ];
  for (const candidate of candidates) {
    const resolved = resolveCandidatePath(candidate);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Answer a workspace TypeScript resolution here instead of through the default
 * resolver. The default resolver detects the format of every `.ts` URL (Node
 * 24 strips types by default) with `getPackageScopeConfig`, which re-parses
 * the nearest package.json's whole `exports` map each time: for a
 * `libs/core/*.ts` module that is the ~290KB `libs/core/package.json`, about
 * half of a cold child's start-up. The load hook decides the format of these
 * files anyway, so nothing is lost. Same URL as the default resolver (realpath,
 * as without --preserve-symlinks); `KYBERION_TS_LOADER_FAST_RESOLVE=0` restores
 * the default-resolver path (differential test: ts-loader-resolve.test.ts).
 */
function resolveTsSourceDirectly(candidate) {
  const ext = extname(candidate);
  if (!TS_EXTENSIONS.has(ext)) return null;
  const flag = String(process.env.KYBERION_TS_LOADER_FAST_RESOLVE ?? '')
    .trim()
    .toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return null;
  if (process.execArgv.includes('--preserve-symlinks')) return null;
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
