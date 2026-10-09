/**
 * Transpile cache for scripts/ts-loader.mjs.
 *
 * A cold `node --import ./scripts/ts-loader.mjs <script>.ts` child spent most of
 * its start-up in `ts.transpileModule`, again in every process. Each output is
 * cached, keyed on the SHA-256 of this file's own text (it holds the compiler
 * options), the TypeScript version, the absolute file path (the inline source
 * map names it) and the source text, so a changed source, option or compiler
 * never hits a stale entry. TypeScript is required lazily, so an all-hit start
 * never parses typescript.js.
 *
 * Trust model. A cache entry is executed as code by whoever runs the loader
 * (operator, mission_controller, CI), so it must not be writable by a role that
 * may only write data. Location, realpath containment of overrides, owner/mode
 * checks, the Windows default (off unless KYBERION_WINDOWS_PRIVATE_CACHE=1) and
 * atomic writes come from libs/core/private-host-cache.mjs, shared with the
 * local STT discovery cache:
 *
 * - Location: `node_modules/.cache/kyberion-ts-loader/` in the code checkout,
 *   NOT the governed data floors under `active/`. A `KYBERION_TS_LOADER_CACHE_DIR`
 *   override inside the checkout is honoured only under `node_modules/` (decided
 *   on its realpath); anywhere else in the checkout the cache is off.
 * - Each entry is opened without following symlinks and `fstat`ed: another
 *   owner or a group/other write bit means a miss, and the entry is deleted.
 *
 * Writes go to a unique temp file renamed into place, so concurrent processes
 * only ever read a complete entry. Old entries are pruned by write time (hits do
 * not refresh mtime) at most once a day.
 *
 * Bootstrap constraint: the loader runs before any TypeScript module can be
 * imported, so secure-io (itself TypeScript) is unavailable here; `node:fs` is
 * used directly (governance-import-baseline.json) and only on this cache tree.
 *
 * - `KYBERION_TS_LOADER_CACHE=0` turns the cache off (kill switch).
 * - `KYBERION_TS_LOADER_CACHE_DIR=<dir>` relocates it (outside the checkout or under node_modules/).
 */
import {
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  currentUid,
  ensureTrustedRoot,
  isTrustedStat,
  readTrustedFile,
  relativeInside,
  removeQuietly,
  resolvePrivateCacheDir,
  writeTrustedFile,
} from '../libs/core/private-host-cache.mjs';

export { isTrustedStat };

const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

const requireFromLoader = createRequire(import.meta.url);
let tsModule = null;
function typescript() {
  if (!tsModule) tsModule = requireFromLoader('typescript');
  return tsModule;
}

const CACHE_TRAILER_PREFIX = '\n//# kyberion-ts-loader-cache=';
const CACHE_NAME = 'kyberion-ts-loader';
const PRUNE_MARKER = '.last-prune';
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const TS_LOADER_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Repository subtrees that hold data, not code: their sources are never cached. */
const UNCACHEABLE_TOP_LEVEL = new Set(['active', 'knowledge', 'customer', 'vault', 'node_modules']);

/**
 * Entries deliberately do not end in a code extension (.js/.mjs/...): repository
 * scanners (boundary tests, lint and governance gates) walk the tree by
 * extension, and a cached copy of `libs/core/*.ts` would show up as a second,
 * unregistered importer of every restricted module.
 */
export const TS_LOADER_CACHE_ENTRY_EXTENSION = '.transpiled';

let selfDigest = null;
/** Digest of this file: the compiler options and the entry format live here. */
function loaderDigest() {
  if (selfDigest === null) {
    try {
      selfDigest = createHash('sha256')
        .update(readFileSync(fileURLToPath(import.meta.url)))
        .digest('hex');
    } catch {
      selfDigest = 'unreadable';
    }
  }
  return selfDigest;
}

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

function isOffFlag(value) {
  const flag = String(value ?? '')
    .trim()
    .toLowerCase();
  return flag === '0' || flag === 'false' || flag === 'off';
}

/**
 * Whether ts-loader answers workspace TypeScript resolutions itself (see
 * resolveTsSourceDirectly in ts-loader.mjs). Bootstrap code cannot use
 * `@agent/core/foundation/env`, so the switch is read here, beside the cache's.
 */
export function tsLoaderFastResolveEnabled(env = process.env) {
  return !isOffFlag(env.KYBERION_TS_LOADER_FAST_RESOLVE);
}

/**
 * Whether Node was asked to keep symlinked paths (flag, NODE_OPTIONS or
 * NODE_PRESERVE_SYMLINKS). The loader's direct resolution returns realpaths, so
 * it stands aside then and lets the default resolver decide.
 */
export function preservesSymlinks(execArgv = process.execArgv, env = process.env) {
  const flags = new Set(['--preserve-symlinks', '--preserve-symlinks-main']);
  if (execArgv.some((arg) => flags.has(arg.split('=')[0]))) return true;
  const nodeOptions = String(env.NODE_OPTIONS ?? '')
    .split(/\s+/u)
    .filter(Boolean);
  if (nodeOptions.some((arg) => flags.has(arg.split('=')[0]))) return true;
  return String(env.NODE_PRESERVE_SYMLINKS ?? '').trim() === '1';
}

/**
 * Cache directory, or null when the cache is off: kill switch, Windows without
 * opt-in, or an override inside the checkout that is not under `node_modules/`
 * (the cache holds executable code; see libs/core/private-host-cache.mjs).
 */
export function tsLoaderCacheDir(env = process.env, projectRoot = PROJECT_ROOT) {
  if (isOffFlag(env.KYBERION_TS_LOADER_CACHE)) return null;
  return resolvePrivateCacheDir({
    projectRoot,
    name: CACHE_NAME,
    override: env.KYBERION_TS_LOADER_CACHE_DIR,
    env,
  });
}

function isCacheableSource(filePath, projectRoot) {
  const rel = relativeInside(projectRoot, filePath);
  if (!rel) return false;
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

/** Cache key: changes when the source, its path, this loader file or TypeScript change. */
export function tsLoaderCacheKey(filePath, source) {
  return createHash('sha256')
    .update(`kyberion-ts-loader:${loaderDigest()}\0`)
    .update(`typescript:${typescriptVersionId()}\0`)
    .update(`${filePath}\0`)
    .update(source)
    .digest('hex');
}

function cacheEntryPath(dir, key) {
  return join(dir, key.slice(0, 2), `${key}${TS_LOADER_CACHE_ENTRY_EXTENSION}`);
}

function readCachedTranspile(dir, key, uid) {
  const entry = cacheEntryPath(dir, key);
  // Wrong owner or a group/other write bit: never executed, and removed.
  const text = readTrustedFile(entry, uid);
  if (text === null) return null;
  const trailer = `${CACHE_TRAILER_PREFIX}${key}\n`;
  // An entry is only valid with its own trailer: guards against a truncated or foreign file.
  if (!text.endsWith(trailer)) {
    removeQuietly(entry);
    return null;
  }
  return text.slice(0, -trailer.length);
}

function writeCachedTranspile(dir, key, output) {
  // Best effort (read-only checkout, full disk, Windows rename over an open file).
  writeTrustedFile(cacheEntryPath(dir, key), `${output}${CACHE_TRAILER_PREFIX}${key}\n`);
}

/**
 * Delete entries (and abandoned temp files) written more than `maxAgeMs` ago.
 * Runs at most once per `PRUNE_INTERVAL_MS` per cache directory (marker file
 * mtime), from a process that just wrote an entry. Hits do not refresh mtime, so
 * a module unchanged for `maxAgeMs` is re-transpiled once.
 */
export function pruneTsLoaderCache(dir, options = {}) {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? TS_LOADER_CACHE_MAX_AGE_MS;
  const marker = join(dir, PRUNE_MARKER);
  if (!options.force) {
    try {
      if (now - statSync(marker).mtimeMs < PRUNE_INTERVAL_MS) return 0;
    } catch {
      /* no marker yet */
    }
  }
  try {
    writeFileSync(marker, '', { mode: 0o600 });
    utimesSync(marker, now / 1000, now / 1000);
  } catch {
    return 0;
  }
  let removed = 0;
  let shards;
  try {
    shards = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const shard of shards) {
    if (shard === PRUNE_MARKER) continue;
    let names;
    try {
      names = readdirSync(join(dir, shard));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(dir, shard, name);
      try {
        const limit = name.endsWith('.tmp') ? 60 * 60 * 1000 : maxAgeMs;
        if (now - lstatSync(file).mtimeMs > limit) {
          unlinkSync(file);
          removed += 1;
        }
      } catch {
        /* raced with another process */
      }
    }
  }
  return removed;
}

const prunedDirs = new Set();

/**
 * Transpile one TypeScript source, through the cache when it is on.
 * `options.env` / `options.projectRoot` / `options.expectedUid` exist for tests.
 */
export function transpileWithCache(filePath, source, options = {}) {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? PROJECT_ROOT;
  const uid = options.expectedUid !== undefined ? options.expectedUid : currentUid();
  let dir = isCacheableSource(filePath, projectRoot) ? tsLoaderCacheDir(env, projectRoot) : null;
  if (dir && !ensureTrustedRoot(dir, uid)) dir = null;
  const key = dir ? tsLoaderCacheKey(filePath, source) : null;
  if (dir) {
    const cached = readCachedTranspile(dir, key, uid);
    if (cached !== null) return { outputText: cached, cacheHit: true };
  }
  const ts = typescript();
  const result = ts.transpileModule(source, {
    compilerOptions: compilerOptionsFor(extname(filePath)),
    fileName: filePath,
    reportDiagnostics: false,
  });
  if (dir) {
    writeCachedTranspile(dir, key, result.outputText);
    if (!prunedDirs.has(dir)) {
      prunedDirs.add(dir);
      pruneTsLoaderCache(dir);
    }
  }
  return { outputText: result.outputText, cacheHit: false };
}
