/**
 * Transpile cache for scripts/ts-loader.mjs.
 *
 * A cold `node --import ./scripts/ts-loader.mjs <script>.ts` child spent most of
 * its start-up in `ts.transpileModule`, again in every process. Each output is
 * stored under the re-generable cache floor
 * (`active/shared/cache/system/ts-loader/`, storage-layout system partition:
 * repository code only, never tenant data; see runtime-storage-layout.md),
 * keyed on the SHA-256 of the loader cache version, the TypeScript version, the
 * compiler options, the absolute file path (the inline source map names it)
 * and the source text. A changed source therefore never hits a stale entry.
 * Writes go to a unique temp file renamed into place, so concurrent processes
 * only ever read a complete entry, and every cache error falls back to
 * transpiling. TypeScript is required lazily, so an all-hit start never parses
 * typescript.js.
 *
 * Bootstrap constraint: the loader runs before any TypeScript module can be
 * imported, so secure-io (itself TypeScript) is unavailable here; `node:fs` is
 * used directly (governance-import-baseline.json) and only on this cache tree.
 *
 * - `KYBERION_TS_LOADER_CACHE=0` turns the cache off (kill switch).
 * - `KYBERION_TS_LOADER_CACHE_DIR=<dir>` relocates it (tests point it at a sandbox).
 */
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

const requireFromLoader = createRequire(import.meta.url);
let tsModule = null;
function typescript() {
  if (!tsModule) tsModule = requireFromLoader('typescript');
  return tsModule;
}

/** Bump when the transpile output for the same input changes (options, post-processing). */
export const TS_LOADER_CACHE_VERSION = '1';
const CACHE_TRAILER_PREFIX = '\n//# kyberion-ts-loader-cache=';

/** Repository subtrees that hold data, not code: never copied into the system cache floor. */
const UNCACHEABLE_TOP_LEVEL = new Set(['active', 'knowledge', 'customer', 'vault', 'node_modules']);

let typescriptVersion = null;
function typescriptVersionId() {
  if (typescriptVersion === null) {
    try {
      const pkgPath = requireFromLoader.resolve('typescript/package.json');
      typescriptVersion = String(JSON.parse(readFileSync(pkgPath, 'utf8')).version || 'unknown');
    } catch {
      typescriptVersion = 'unknown';
    }
  }
  return typescriptVersion;
}

/** Cache directory, or null when the cache is switched off. Read per call so tests can toggle it. */
export function tsLoaderCacheDir(env = process.env) {
  const flag = String(env.KYBERION_TS_LOADER_CACHE ?? '')
    .trim()
    .toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'off') return null;
  const override = String(env.KYBERION_TS_LOADER_CACHE_DIR ?? '').trim();
  if (override) return isAbsolute(override) ? override : resolvePath(PROJECT_ROOT, override);
  return join(PROJECT_ROOT, 'active', 'shared', 'cache', 'system', 'ts-loader');
}

function isCacheableSource(filePath, projectRoot) {
  const rel = relative(projectRoot, filePath);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return false;
  return !UNCACHEABLE_TOP_LEVEL.has(rel.split(sep)[0]);
}

function compilerOptionsFor(ext) {
  const ts = typescript();
  return {
    target: ts.ScriptTarget.ES2022,
    module: ext === '.cts' ? ts.ModuleKind.CommonJS : ts.ModuleKind.ESNext,
    jsx: ext === '.tsx' ? ts.JsxEmit.ReactJSX : ts.JsxEmit.Preserve,
    sourceMap: true,
    inlineSourceMap: true,
    inlineSources: true,
    esModuleInterop: true,
    verbatimModuleSyntax: false,
  };
}

/** Cache key: changes when the source, its path, the options, TypeScript or this loader change. */
export function tsLoaderCacheKey(filePath, source) {
  const ext = extname(filePath);
  return (
    createHash('sha256')
      .update(`kyberion-ts-loader:${TS_LOADER_CACHE_VERSION}\0`)
      .update(`typescript:${typescriptVersionId()}\0`)
      // Options are symbolic here so a hit does not need TypeScript loaded; they
      // mirror compilerOptionsFor() and TS_LOADER_CACHE_VERSION covers changes to it.
      .update(
        `options:es2022|${ext === '.cts' ? 'cjs' : 'esm'}|${ext === '.tsx' ? 'react-jsx' : 'preserve'}|inline-map|interop\0`
      )
      .update(`${filePath}\0`)
      .update(source)
      .digest('hex')
  );
}

/**
 * Entries deliberately do not end in a code extension (.js/.mjs/...): repository
 * scanners (boundary tests, lint and governance gates) walk the tree by
 * extension, and a cached copy of `libs/core/*.ts` would show up as a second,
 * unregistered importer of every restricted module.
 */
export const TS_LOADER_CACHE_ENTRY_EXTENSION = '.transpiled';

function cacheEntryPath(dir, key) {
  return join(dir, key.slice(0, 2), `${key}${TS_LOADER_CACHE_ENTRY_EXTENSION}`);
}

function readCachedTranspile(dir, key) {
  let text;
  try {
    text = readFileSync(cacheEntryPath(dir, key), 'utf8');
  } catch {
    return null;
  }
  const trailer = `${CACHE_TRAILER_PREFIX}${key}\n`;
  // An entry is only valid with its own trailer: guards against a truncated or foreign file.
  if (!text.endsWith(trailer)) return null;
  return text.slice(0, -trailer.length);
}

let cacheTempCounter = 0;
function writeCachedTranspile(dir, key, output) {
  const target = cacheEntryPath(dir, key);
  const temp = `${target}.${process.pid}.${Date.now()}.${cacheTempCounter++}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(temp, `${output}${CACHE_TRAILER_PREFIX}${key}\n`, { flag: 'wx' });
    // rename is atomic on POSIX: a concurrent reader sees the old entry, none, or this one.
    renameSync(temp, target);
  } catch {
    // Best effort (read-only checkout, full disk, Windows rename over an open file).
    try {
      unlinkSync(temp);
    } catch {
      /* temp was never created or already renamed */
    }
  }
}

/**
 * Transpile one TypeScript source, through the cache when it is on.
 * `options.env` / `options.projectRoot` exist for tests (sandboxed cache and sources).
 */
export function transpileWithCache(filePath, source, options = {}) {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const dir = isCacheableSource(filePath, projectRoot) ? tsLoaderCacheDir(env) : null;
  const key = dir ? tsLoaderCacheKey(filePath, source) : null;
  if (dir) {
    const cached = readCachedTranspile(dir, key);
    if (cached !== null) return { outputText: cached, cacheHit: true };
  }
  const ts = typescript();
  const result = ts.transpileModule(source, {
    compilerOptions: compilerOptionsFor(extname(filePath)),
    fileName: filePath,
    reportDiagnostics: false,
  });
  if (dir) writeCachedTranspile(dir, key, result.outputText);
  return { outputText: result.outputText, cacheHit: false };
}
