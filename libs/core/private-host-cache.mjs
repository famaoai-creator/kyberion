/**
 * Private host caches: small caches whose content decides what gets executed
 * (the ts-loader transpile cache, the local STT discovery result), so they must
 * not be writable by a role that may only write data.
 *
 * Trust model (MSN-OPS-ROUND5 review H1/H2):
 *
 * - Location: `<checkout>/node_modules/.cache/<name>/`. Every governed data tree
 *   under `active/` is in security-policy `default_allow` and writable by any
 *   persona through secure-io; `node_modules/` is denied to every persona and
 *   authority role except the operator-equivalent SUDO authority. An override
 *   directory is accepted only outside the checkout or under its
 *   `node_modules/`, decided on the realpath of its deepest existing ancestor,
 *   so a pnpm workspace link (`node_modules/@actuator/x -> libs/actuators/x`)
 *   cannot smuggle it back into the source tree.
 * - Ownership and mode: the cache root must be a real directory owned by this
 *   uid with no group/other write bit; directories are created 0700 and files
 *   0600. A file is opened without following symlinks and `fstat`ed; one with
 *   another owner or a group/other write bit is deleted and treated as absent.
 * - Windows has no uid or POSIX mode bits to check, so the checks would fail
 *   open there: these caches are off on win32 unless
 *   `KYBERION_WINDOWS_PRIVATE_CACHE=1` opts in (a single-user host).
 * - No MAC: a process that can write the cache as this uid can also read any
 *   per-user key and edit the checkout's code directly.
 *
 * Bootstrap constraint: scripts/ts-loader.mjs uses this before any TypeScript
 * (and so secure-io) can load, and secure-io refuses `node_modules/` by design,
 * so this module uses `node:fs` directly, on these cache directories only
 * (tests/fixtures/governance-import-baseline.json, core-fs-exception-boundary).
 */
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

export function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Owned by `uid` (when the platform has uids) and not writable by group or other. */
export function isTrustedStat(stat, uid, platform = process.platform) {
  if (uid !== null && stat.uid !== uid) return false;
  if (platform !== 'win32' && (stat.mode & 0o022) !== 0) return false;
  return true;
}

/** Whether private host caches may run on this platform (off on win32 unless opted in). */
export function privateHostCacheSupported(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return true;
  return String(env.KYBERION_WINDOWS_PRIVATE_CACHE ?? '').trim() === '1';
}

/** Realpath of `target`, resolving the deepest existing ancestor (the rest may not exist yet). */
export function realpathOfDeepestAncestor(target) {
  let current = resolvePath(target);
  const rest = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return join(realpathSync(current), ...rest.reverse());
      } catch {
        return null;
      }
    }
    const parent = dirname(current);
    if (parent === current) return null;
    rest.push(basename(current));
    current = parent;
  }
}

/** `target` relative to `root`, or null when outside (lower-cased on case-insensitive hosts). */
export function relativeInside(root, target) {
  const rel = relative(root, target);
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return CASE_INSENSITIVE_FS ? rel.toLowerCase() : rel;
}

/**
 * The cache directory for `name`, or null when it may not be used: the default
 * `<projectRoot>/node_modules/.cache/<name>`, or `override` when it is outside
 * the checkout or under its `node_modules/` (after realpath).
 */
export function resolvePrivateCacheDir({
  projectRoot,
  name,
  override = '',
  env = process.env,
  platform = process.platform,
}) {
  if (!privateHostCacheSupported(env, platform)) return null;
  const requested = String(override ?? '').trim();
  const dir = requested
    ? isAbsolute(requested)
      ? requested
      : resolvePath(projectRoot, requested)
    : join(projectRoot, 'node_modules', '.cache', name);
  const realDir = realpathOfDeepestAncestor(dir);
  const realRoot = realpathOfDeepestAncestor(projectRoot);
  if (!realDir || !realRoot) return null;
  const rel = relativeInside(realRoot, realDir);
  if (rel === null) return dir;
  const [top] = rel.split(sep);
  return top === 'node_modules' && rel !== 'node_modules' ? dir : null;
}

const trustedRoots = new Map();
/** Create `dir` 0700 and check it once per process; false turns the cache off. */
export function ensureTrustedRoot(dir, uid = currentUid()) {
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

export function removeQuietly(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    /* already gone */
  }
}

/** Read a cache file if it is trusted; an untrusted one is deleted. Null when absent or untrusted. */
export function readTrustedFile(filePath, uid = currentUid()) {
  let fd;
  try {
    fd = openSync(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || !isTrustedStat(stat, uid)) {
      closeSync(fd);
      fd = undefined;
      removeQuietly(filePath);
      return null;
    }
    return readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

let tempCounter = 0;
/** Write via a unique 0600 temp file renamed into place (atomic on POSIX). False on any error. */
export function writeTrustedFile(filePath, text) {
  const temp = `${filePath}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
    renameSync(temp, filePath);
    return true;
  } catch {
    removeQuietly(temp);
    return false;
  }
}
