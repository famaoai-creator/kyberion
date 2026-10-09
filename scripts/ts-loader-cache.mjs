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
 * may only write data:
 *
 * - Location: `node_modules/.cache/kyberion-ts-loader/` in the code checkout,
 *   NOT the governed data floors under `active/` (security-policy
 *   `default_allow` lets every persona write `active/shared/cache/` through
 *   secure-io). secure-io denies `node_modules/` to every persona and authority
 *   role except the SUDO authority (tier-guard-ts-loader-cache.test.ts). A
 *   `KYBERION_TS_LOADER_CACHE_DIR` override inside the checkout is honoured only
 *   under `node_modules/`; anywhere else in the checkout the cache is off.
 * - Ownership and mode: the cache root must be a real directory owned by this
 *   uid with no group/other write bit; directories are created 0700 and entries
 *   0600. Each entry is opened without following symlinks and `fstat`ed: an
 *   entry of another owner or with a group/other write bit is a miss and is
 *   deleted. Every cache error is a miss.
 * - No HMAC: a process that can write the cache directory as this uid can also
 *   read any key stored for this uid and edit `scripts/` directly, so a MAC would
 *   add nothing beyond the location and ownership checks.
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
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
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
const IS_WINDOWS = process.platform === 'win32';
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || IS_WINDOWS;

const requireFromLoader = createRequire(import.meta.url);
let tsModule = null;
function typescript() {
  if (!tsModule) tsModule = requireFromLoader('typescript');
  return tsModule;
}

const CACHE_TRAILER_PREFIX = '\n//# kyberion-ts-loader-cache=';
const DEFAULT_CACHE_SEGMENTS = ['node_modules', '.cache', 'kyberion-ts-loader'];
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

function relativeInside(root, target) {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return rel === '' ? '' : null;
  return CASE_INSENSITIVE_FS ? rel.toLowerCase() : rel;
}

/**
 * Cache directory, or null when the cache is off. An override inside the
 * checkout must sit under `node_modules/`: everywhere else in the checkout is a
 * governed tree some persona may write, and the cache holds executable code.
 */
export function tsLoaderCacheDir(env = process.env, projectRoot = PROJECT_ROOT) {
  if (isOffFlag(env.KYBERION_TS_LOADER_CACHE)) return null;
  const override = String(env.KYBERION_TS_LOADER_CACHE_DIR ?? '').trim();
  if (!override) return join(projectRoot, ...DEFAULT_CACHE_SEGMENTS);
  const dir = isAbsolute(override) ? override : resolvePath(projectRoot, override);
  const rel = relativeInside(projectRoot, dir);
  if (rel === null) return dir;
  return rel.split(sep)[0] === 'node_modules' && rel !== 'node_modules' ? dir : null;
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

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Owned by `uid` (when the platform has uids) and not writable by group or other. Exported for tests. */
export function isTrustedStat(stat, uid) {
  if (uid !== null && stat.uid !== uid) return false;
  if (!IS_WINDOWS && (stat.mode & 0o022) !== 0) return false;
  return true;
}

const trustedRoots = new Map();
/** Create the cache root 0700 and check it once per process; an untrusted root turns the cache off. */
function ensureTrustedRoot(dir, uid) {
  const memoKey = `${dir}\0${uid}`;
  const known = trustedRoots.get(memoKey);
  if (known !== undefined) return known;
  let trusted = false;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    trusted = stat.isDirectory() && !stat.isSymbolicLink() && isTrustedStat(stat, uid);
  } catch {
    trusted = false;
  }
  trustedRoots.set(memoKey, trusted);
  return trusted;
}

function removeQuietly(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    /* already gone */
  }
}

function readCachedTranspile(dir, key, uid) {
  const entry = cacheEntryPath(dir, key);
  let fd;
  try {
    fd = openSync(entry, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  let text;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !isTrustedStat(stat, uid)) {
      closeSync(fd);
      fd = undefined;
      // Wrong owner or a group/other write bit: never executed, and removed.
      removeQuietly(entry);
      return null;
    }
    text = readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const trailer = `${CACHE_TRAILER_PREFIX}${key}\n`;
  // An entry is only valid with its own trailer: guards against a truncated or foreign file.
  if (!text.endsWith(trailer)) {
    removeQuietly(entry);
    return null;
  }
  return text.slice(0, -trailer.length);
}

let cacheTempCounter = 0;
function writeCachedTranspile(dir, key, output) {
  const target = cacheEntryPath(dir, key);
  const temp = `${target}.${process.pid}.${Date.now()}.${cacheTempCounter++}.tmp`;
  try {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${output}${CACHE_TRAILER_PREFIX}${key}\n`, { flag: 'wx', mode: 0o600 });
    // rename is atomic on POSIX: a concurrent reader sees the old entry, none, or this one.
    renameSync(temp, target);
  } catch {
    // Best effort (read-only checkout, full disk, Windows rename over an open file).
    removeQuietly(temp);
  }
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
