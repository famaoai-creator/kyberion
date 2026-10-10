import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { assertSensitivePathAllowed } from './sensitive-path-policy.js';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';
import { vaultTargetIdentity } from './secret/vault-mount.js';

/**
 * Permission guards of secure-io: literal + canonical (symlink-resolved)
 * checks shared by every read and write helper. Split out of secure-io.ts so
 * the I/O module stays within its size budget; secure-io is the only caller.
 *
 * Only function declarations and `var` at module level: secure-io's import
 * cycle (audit-chain -> secure-io) can call into this module before its
 * lexical bindings initialize.
 */

// eslint-disable-next-line no-var
var mediationProbeFn: (() => boolean) | undefined;

/** secure-io registers its sensitive-path mediation state here, once. */
export function registerSensitivePathMediationProbe(probe: () => boolean): void {
  // First registration wins: a later caller must not swap the probe out.
  if (mediationProbeFn) return;
  mediationProbeFn = probe;
}

/** Before registration secure-io is still bootstrapping, which counts as mediated. */
function mediationProbe(): boolean {
  return mediationProbeFn ? mediationProbeFn() : true;
}

/**
 * True when an entry exists at p (a dangling symlink counts); throws on ELOOP
 * and the like. Only probes inside the checkout (logical or real root): the
 * canonicalization walk never needs to look outside it, and a path outside
 * is refused with code EOUTSIDE.
 */
export function entryExists(p: string): boolean {
  const candidate = path.resolve(p);
  const logicalRoot = path.resolve(pathResolver.rootDir());
  const physicalRoot = realRoot().real;
  let stat: fs.Stats | undefined;
  try {
    // Each probe sits behind its own containment check on the probed value.
    if (candidate === logicalRoot) stat = fs.lstatSync(logicalRoot);
    else if (candidate === physicalRoot) stat = fs.lstatSync(physicalRoot);
    else if (candidate.startsWith(logicalRoot + path.sep))
      stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    else if (candidate.startsWith(physicalRoot + path.sep))
      stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    else throw Object.assign(new Error('path is outside the repository'), { code: 'EOUTSIDE' });
  } catch (error) {
    if (errnoCode(error) === 'ENOTDIR') return false;
    rethrowAsErrno(error, 'lstat');
  }
  return stat !== undefined;
}

/**
 * The errno of a caught error as one of a fixed set of literals. Guard errors
 * reach HTTP surfaces through callers' messages, so a caught error object is
 * never rethrown or echoed from this module — only its errno classification.
 */
function errnoCode(error: unknown): string {
  const raw = (error as NodeJS.ErrnoException | undefined)?.code;
  // Inline list (no module const): reachable during the secure-io bootstrap cycle.
  const known = [
    'ENOENT',
    'ENOTDIR',
    'ELOOP',
    'EACCES',
    'EPERM',
    'EEXIST',
    'EINVAL',
    'ENAMETOOLONG',
    'EISDIR',
    'EOUTSIDE',
  ];
  for (const code of known) if (raw === code) return code;
  return 'EUNKNOWN';
}

function rethrowAsErrno(error: unknown, operation: string): never {
  const code = errnoCode(error);
  throw Object.assign(new Error(`${operation} failed (${code})`), { code });
}

/*
 * ---------------------------------------------------------------------------
 * Symlink canonicalization for the permission guards.
 *
 * The tier guard classifies a path as written, but the OS follows symbolic
 * links in every component. Without canonicalization a persona that may write
 * `active/shared/tmp/` can plant `tmp/link -> scripts/` and then write
 * `tmp/link/x.ts` into a code path it may only read (and a reader can read
 * `knowledge/personal/` through a link placed in a lower tier). Every guarded
 * operation therefore checks the canonical (physical) path as well as the
 * literal one; both must pass.
 *
 * - `follow`: the operation follows a symlink leaf (open, append, copy dest,
 *   chmod, read). Every component is resolved.
 * - `leaf`: the operation acts on the directory entry itself and never
 *   follows the leaf (rename, unlink, rm, rmdir, lstat, readlink, creating a
 *   link). Only the parent is resolved; the leaf name is kept (with its
 *   on-disk case on a case-insensitive volume).
 *
 * The canonical path is mapped back into the logical root space
 * (`pathResolver.rootDir()`), so a checkout reached through a symlinked
 * prefix (macOS `/var -> /private/var`, a fixture root) keeps classifying
 * against the same policy prefixes. The Vitest live-subtree remap is not
 * re-applied: the literal path was already remapped by `pathResolver.resolve`
 * and the canonical path names the physical location the OS will touch,
 * which is exactly what the guard must judge.
 *
 * No realpath cache: every check walks the path afresh. A per-process cache
 * of resolved directories cannot see a rename done through raw fs or by
 * another process (an ancestor renamed into a protected tree with a link
 * left behind re-verifies as "same inode"), and re-verifying every ancestor
 * costs about as much as realpath itself. See runbook §10 for the cost.
 * ---------------------------------------------------------------------------
 */
export type CanonicalMode = 'follow' | 'leaf';

// eslint-disable-next-line no-var
var realRootCache: { root: string; real: string; caseInsensitive: boolean } | undefined;

function swapCase(value: string): string {
  let out = '';
  for (const ch of value) {
    const lower = ch.toLowerCase();
    out += ch === lower ? ch.toUpperCase() : lower;
  }
  return out;
}

/** realpath of the logical root and whether its volume folds case (probed once per root). */
function realRoot(): { real: string; caseInsensitive: boolean } {
  const root = path.resolve(pathResolver.rootDir());
  if (realRootCache?.root === root) return realRootCache;
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    // An unresolvable root leaves the logical root as the comparison base;
    // every path below it then fails canonicalization and is refused.
  }
  // Probe the nearest component (the root or an ancestor) whose name has
  // letters: on a case-folding volume its swapped spelling is the same entry.
  let caseInsensitive = false;
  for (let probe = real; path.dirname(probe) !== probe; probe = path.dirname(probe)) {
    const swapped = path.join(path.dirname(probe), swapCase(path.basename(probe)));
    if (swapped === probe) continue;
    try {
      const a = fs.lstatSync(probe);
      const b = fs.lstatSync(swapped);
      caseInsensitive = a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
    } catch {
      caseInsensitive = false;
    }
    break;
  }
  realRootCache = { root, real, caseInsensitive };
  return realRootCache;
}

/**
 * On a case-insensitive volume, the on-disk spelling of an existing entry
 * `leaf` in the real directory `realDir` (`knowledge/PERSONAL` -> `personal`);
 * tier detection is case-sensitive, so the typed spelling must not be judged.
 */
function onDiskLeaf(realDir: string, leaf: string): string {
  if (!realRoot().caseInsensitive) return leaf;
  const joined = path.resolve(realDir, leaf);
  // Probe only inside the checkout (containment on the probed value).
  let candidate: string | undefined;
  if (joined.startsWith(path.resolve(pathResolver.rootDir()) + path.sep)) candidate = joined;
  else if (joined.startsWith(realRoot().real + path.sep)) candidate = joined;
  if (candidate === undefined) return leaf;
  let stat: fs.Stats | undefined;
  try {
    stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
  } catch {
    return leaf;
  }
  if (!stat) return leaf; // no entry: the typed spelling is what gets created
  // Not a link: realpath returns the on-disk spelling without a listing.
  if (!stat.isSymbolicLink()) {
    try {
      const real = fs.realpathSync.native(candidate);
      // Only trust the spelling if realpath reached the entry we lstat'd (a
      // leaf swapped for a link in between falls through to the listing).
      const reached = fs.lstatSync(real);
      if (reached.dev === stat.dev && reached.ino === stat.ino) return path.basename(real);
    } catch {
      return leaf;
    }
  }
  // A link leaf must not be followed; only then list the directory.
  const wanted = leaf.normalize('NFC').toLowerCase();
  let names: string[];
  try {
    names = fs.readdirSync(path.dirname(candidate));
  } catch {
    return leaf;
  }
  if (names.includes(leaf)) return leaf;
  return names.find((name) => name.normalize('NFC').toLowerCase() === wanted) ?? leaf;
}

/** Physical path of `absPath`: realpath of the deepest existing entry plus the missing tail. */
function physicalPath(absPath: string, hops = 0): string {
  // Literal bound (no module const): the secure-io bootstrap cycle can reach
  // this before lexical bindings initialize. 40 matches Linux MAXSYMLINKS.
  if (hops > 40) {
    throw Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' });
  }
  // Fast path: an existing, fully resolvable path costs one realpath call.
  try {
    // realpath already returns the on-disk case on case-folding platforms.
    return fs.realpathSync.native(absPath);
  } catch (error) {
    const code = errnoCode(error);
    if (code !== 'ENOENT' && code !== 'ENOTDIR') rethrowAsErrno(error, 'realpath');
  }
  const missing: string[] = [];
  let existing = absPath;
  while (!entryExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  try {
    return path.join(fs.realpathSync.native(existing), ...missing);
  } catch (error) {
    if (errnoCode(error) !== 'ENOENT') rethrowAsErrno(error, 'realpath');
    // `existing` is a dangling symlink (lstat sees it, realpath cannot follow
    // it). A write through it would create its target, so follow it by hand,
    // relative to its real parent so `..` in the link text resolves the way
    // the OS resolves it.
    const link = path.resolve(existing);
    const logicalRoot = path.resolve(pathResolver.rootDir());
    const physicalRoot = realRoot().real;
    // A dangling link outside the checkout is never followed.
    let linkText: string;
    if (link.startsWith(logicalRoot + path.sep)) linkText = fs.readlinkSync(link);
    else if (link.startsWith(physicalRoot + path.sep)) linkText = fs.readlinkSync(link);
    else
      throw Object.assign(new Error('dangling link outside the repository'), { code: 'EOUTSIDE' });
    const parentReal = fs.realpathSync.native(path.dirname(link));
    const target = path.resolve(parentReal, linkText);
    return physicalPath(path.join(target, ...missing), hops + 1);
  }
}

export function isInside(base: string, candidate: string): string | undefined {
  const relative = path.relative(base, candidate);
  if (relative === '') return '';
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative;
}

/**
 * Canonical path used by the permission guards (see the block comment above).
 * Fails closed: a component that cannot be resolved (loop, permission error)
 * throws instead of falling back to the literal path.
 */
export function canonicalGuardPath(resolved: string, mode: CanonicalMode): string {
  const absolute = path.resolve(resolved);
  let physical: string;
  try {
    if (mode === 'follow' || path.dirname(absolute) === absolute) {
      physical = physicalPath(absolute);
    } else {
      const realParent = physicalPath(path.dirname(absolute));
      physical = path.join(realParent, onDiskLeaf(realParent, path.basename(absolute)));
    }
  } catch {
    // The errno is deliberately not echoed: these messages reach HTTP surfaces.
    throw new Error(
      `[SECURITY] Refusing access to ${resolved}: a path component does not resolve (symlink loop, dangling link, outside the repository or not permitted)`
    );
  }
  return toLogicalRoot(physical);
}

/** Re-express a physical path under the logical root (see the block comment above). */
function toLogicalRoot(physical: string): string {
  const relative = isInside(realRoot().real, physical);
  if (relative === undefined) return physical;
  const logicalRoot = path.resolve(pathResolver.rootDir());
  return relative === '' ? logicalRoot : path.join(logicalRoot, relative);
}

/**
 * Write-side companion of `validateWritePermission`: the literal path is
 * expected to have passed already; this checks the canonical path when it
 * differs. Returns the canonical path (for tier detection).
 */
export function assertCanonicalWritable(
  resolved: string,
  displayPath: string,
  mode: CanonicalMode = 'follow'
): string {
  const canonical = canonicalGuardPath(resolved, mode);
  if (canonical === path.resolve(resolved)) return canonical;
  assertSensitivePathAllowed(canonical, 'write', mediationProbe());
  const guard = validateWritePermission(canonical);
  if (!guard.allowed) {
    throw new Error(
      `[SECURITY] Write through symbolic link denied: ${displayPath} resolves to a location outside the caller's write scope`
    );
  }
  return canonical;
}

/** Read-side companion of `validateReadPermission` (see assertCanonicalWritable). */
export function assertCanonicalReadable(
  resolved: string,
  displayPath: string,
  mode: CanonicalMode = 'follow'
): string {
  const canonical = canonicalGuardPath(resolved, mode);
  if (canonical === path.resolve(resolved)) return canonical;
  assertSensitivePathAllowed(canonical, 'read', mediationProbe());
  const guard = validateReadPermission(canonical);
  if (!guard.allowed) {
    throw new Error(
      `[SECURITY] Read through symbolic link denied: ${displayPath} resolves to a location outside the caller's read scope`
    );
  }
  return canonical;
}

/**
 * The one write guard every write-type helper uses: sensitive-path deny list,
 * literal write permission, then canonical write permission. Returns the
 * literal resolved path (the operation itself still runs on it) and the
 * canonical path (where the bytes actually land).
 */
export function guardWritePath(
  filePath: string,
  mode: CanonicalMode = 'follow',
  operation = 'write'
): { resolved: string; canonical: string } {
  const resolved = guardLiteralWritePath(filePath, operation);
  const canonical = assertCanonicalWritable(resolved, filePath, mode);
  return { resolved, canonical };
}

/** The literal half of guardWritePath, for callers that run the canonical check later. */
export function guardLiteralWritePath(filePath: string, operation = 'write'): string {
  assertSensitivePathAllowed(filePath, operation, mediationProbe());
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  return resolved;
}

/** Identity of the directory a write was checked against (see assertTempInCheckedDir). */
export interface CheckedDir {
  dir: string;
  dev: number;
  ino: number;
}

export function captureCheckedDir(dir: string): CheckedDir {
  const st = fs.statSync(dir);
  return { dir, dev: st.dev, ino: st.ino };
}

/**
 * Narrows the check-to-use race of an atomic write: after the temp file is
 * opened, the checked directory must still be the same directory object, it
 * must still canonicalize to itself (no component swapped for a link), and
 * the temp entry seen there must be the descriptor just opened.
 */
export function assertTempInCheckedDir(checked: CheckedDir, tempPath: string, fd: number): void {
  const dirNow = fs.statSync(checked.dir);
  const tempNow = fs.lstatSync(tempPath);
  const opened = fs.fstatSync(fd);
  if (
    checked.ino === 0 ||
    opened.ino === 0 ||
    dirNow.dev !== checked.dev ||
    dirNow.ino !== checked.ino ||
    tempNow.dev !== opened.dev ||
    tempNow.ino !== opened.ino ||
    canonicalGuardPath(checked.dir, 'follow') !== checked.dir
  ) {
    throw new Error(
      `[SECURITY] Refusing to write in ${checked.dir}: the directory changed between the permission check and the write`
    );
  }
}

/** Open for in-place access (read, append, fsync, chmod); refuses foreign hard links on the fd. */
export function openInPlace(
  resolved: string,
  displayPath: string,
  flags: string,
  operation: HardLinkOperation,
  mode?: number,
  noFollow = false,
  authorizedCanonical?: string
): number {
  const c = fs.constants;
  // In-place access must not change the inode before it is vetted: a
  // truncating or replacing flag would act on a foreign hard link first.
  const base: Record<string, number> = {
    r: c.O_RDONLY,
    'r+': c.O_RDWR,
    a: c.O_WRONLY | c.O_APPEND,
    'a+': c.O_RDWR | c.O_APPEND,
    ax: c.O_WRONLY | c.O_APPEND,
    'ax+': c.O_RDWR | c.O_APPEND,
  };
  if (!Object.hasOwn(base, flags)) {
    throw new Error(`[SECURITY] Unsupported in-place open flag '${flags}' for ${displayPath}`);
  }
  // Non-blocking: a FIFO (or a link flipped to one) must not hang the caller.
  let open = base[flags] | (c.O_NONBLOCK ?? 0);
  if (noFollow) open |= c.O_NOFOLLOW ?? 0;
  const creates = flags.startsWith('a');
  let fd: number | undefined;
  if (!flags.startsWith('ax')) {
    try {
      fd = fs.openSync(resolved, open);
    } catch (error) {
      if (!creates || errnoCode(error) !== 'ENOENT') rethrowAsErrno(error, 'open');
    }
  }
  let created = false;
  if (fd === undefined) {
    // Create only a new entry, never through a (dangling) link: O_EXCL with
    // O_NOFOLLOW fails on any existing leaf instead of creating its target.
    const exclusive = open | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW ?? 0);
    fd = fs.openSync(resolved, exclusive, mode);
    created = true;
  }
  let accepted = false;
  try {
    const held = fs.fstatSync(fd);
    if (!held.isFile()) {
      throw new Error(`Not a regular file: ${displayPath} (refusing to ${operation} it)`);
    }
    vetOpenedFd(fd, resolved, displayPath, operation, authorizedCanonical);
    accepted = true;
    return fd;
  } finally {
    if (!accepted) {
      if (created) removeCreatedEntry(fd, resolved);
      fs.closeSync(fd);
    }
  }
}

/**
 * Undo a create whose vetting failed: unlink the new entry at `resolved`
 * only while it is still the inode just created (no leaf link: it was
 * created O_NOFOLLOW) and inside the checkout.
 */
function removeCreatedEntry(fd: number, resolved: string): void {
  try {
    const mine = fs.fstatSync(fd);
    const target = path.resolve(resolved);
    let entry: fs.Stats | undefined;
    if (target.startsWith(path.resolve(pathResolver.rootDir()) + path.sep))
      entry = fs.lstatSync(target);
    else if (target.startsWith(realRoot().real + path.sep)) entry = fs.lstatSync(target);
    if (entry && entry.dev === mine.dev && entry.ino === mine.ino && entry.size === 0)
      fs.unlinkSync(target);
  } catch {
    // best effort: a concurrent change already moved the entry
  }
}

/**
 * Open a directory and vet the descriptor (like openInPlace for files):
 * non-blocking, refuses anything but a directory.
 */
export function openDirVetted(
  resolved: string,
  displayPath: string,
  operation: HardLinkOperation,
  authorizedCanonical?: string
): number {
  const c = fs.constants;
  const fd = fs.openSync(resolved, c.O_RDONLY | (c.O_DIRECTORY ?? 0) | (c.O_NONBLOCK ?? 0));
  let accepted = false;
  try {
    if (!fs.fstatSync(fd).isDirectory()) {
      throw new Error(`[SECURITY] Refusing to ${operation} ${displayPath}: not a directory`);
    }
    vetOpenedFd(fd, resolved, displayPath, operation, authorizedCanonical);
    accepted = true;
    return fd;
  } finally {
    if (!accepted) fs.closeSync(fd);
  }
}

/** readdir of the directory actually opened and vetted (not of whatever the path names later). */
export function readdirVetted(resolved: string, displayPath: string): string[] {
  const fd = openDirVetted(resolved, displayPath, 'read');
  try {
    if (process.platform === 'linux') {
      try {
        return fs.readdirSync(`/proc/self/fd/${fd}`);
      } catch {
        // /proc unavailable: path fallback below
      }
    }
    const held = fs.fstatSync(fd);
    const canonical = canonicalGuardPath(resolved, 'follow');
    if (!leafIsInode(canonical, held)) throw new Error(`[SECURITY] ${displayPath} changed`);
    const names = fs.readdirSync(canonical);
    if (!leafIsInode(canonical, held)) throw new Error(`[SECURITY] ${displayPath} changed`);
    return names;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Authorize what was actually opened, not the path that was checked: the
 * path is judged before open(2), which follows symlinks, so a link flipped in
 * between would hand over a different file (e.g. from knowledge/personal/).
 * The opened file's own location — from /proc/self/fd where available,
 * otherwise the re-derived canonical path whose leaf must be the very inode
 * held — is re-checked for permission, then for foreign hard links.
 */
export function vetOpenedFd(
  fd: number,
  resolved: string,
  displayPath: string,
  operation: HardLinkOperation,
  authorizedCanonical?: string
): fs.Stats {
  const held = fs.fstatSync(fd);
  const actual = openedLocation(fd, resolved, held);
  if (actual === undefined) {
    throw new Error(
      `[SECURITY] Refusing to ${operation} ${displayPath}: the file changed between the permission check and the open`
    );
  }
  // Opened exactly what the caller's check authorized: no need to re-judge.
  if (actual !== authorizedCanonical) assertAuthorizedAt(actual, displayPath, operation);
  assertNotForeignHardLink(held, actual, displayPath, operation);
  return held;
}

/**
 * Stat-only counterpart of vetOpenedFd (safeStat, validateFileSize): regular
 * files and directories are opened non-blocking and vetted through the fd;
 * anything else (sockets, FIFOs, devices) is pinned by path identity.
 */
export function statVetted(resolved: string, displayPath: string): fs.Stats {
  const peek = fs.statSync(resolved);
  if (peek.isFile() || peek.isDirectory()) {
    const { O_RDONLY, O_NONBLOCK } = fs.constants;
    const fd = fs.openSync(resolved, O_RDONLY | (O_NONBLOCK ?? 0));
    try {
      return vetOpenedFd(fd, resolved, displayPath, 'read');
    } finally {
      fs.closeSync(fd);
    }
  }
  const canonical = canonicalGuardPath(resolved, 'follow');
  if (!leafIsInode(canonical, peek)) {
    throw new Error(
      `[SECURITY] Refusing to stat ${displayPath}: the entry changed between the permission check and the stat`
    );
  }
  assertAuthorizedAt(canonical, displayPath, 'read');
  return peek;
}

/** Where the opened file actually lives (logical-root form), or undefined if it cannot be pinned. */
function openedLocation(fd: number, resolved: string, held: fs.Stats): string | undefined {
  if (held.ino === 0) return undefined;
  if (process.platform === 'linux') {
    try {
      const link = fs.readlinkSync(`/proc/self/fd/${fd}`);
      if (path.isAbsolute(link) && !link.endsWith(' (deleted)')) return toLogicalRoot(link);
    } catch {
      // /proc unavailable: fall back to the path identity check below
    }
  }
  const canonical = canonicalGuardPath(resolved, 'follow');
  return leafIsInode(canonical, held) ? canonical : undefined;
}

/** The canonical path's leaf entry (not followed) is the inode `held`. */
function leafIsInode(canonical: string, held: fs.Stats): boolean {
  if (held.ino === 0) return false;
  const target = path.resolve(canonical);
  let now: { dev: number; ino: number } | undefined;
  try {
    if (target.startsWith(path.resolve(pathResolver.rootDir()) + path.sep))
      now = fs.lstatSync(target);
    else if (target.startsWith(realRoot().real + path.sep)) now = fs.lstatSync(target);
    else now = vaultTargetIdentity(target);
  } catch {
    return false;
  }
  return now !== undefined && now.dev === held.dev && now.ino === held.ino;
}

function assertAuthorizedAt(
  actual: string,
  displayPath: string,
  operation: HardLinkOperation
): void {
  assertSensitivePathAllowed(actual, operation, mediationProbe());
  const guard =
    operation === 'read' ? validateReadPermission(actual) : validateWritePermission(actual);
  if (!guard.allowed) {
    throw new Error(
      `[SECURITY] ${operation === 'read' ? 'Read' : 'Write'} denied: ${displayPath} resolves to a location outside the caller's ${operation} scope`
    );
  }
}

/** Read counterpart of guardWritePath; `deny` formats the literal-denial message. */
export function guardReadPath(
  filePath: string,
  deny: (reason: string | undefined) => string,
  mode: CanonicalMode = 'follow'
): string {
  assertSensitivePathAllowed(filePath, 'read', mediationProbe());
  const resolved = pathResolver.resolve(filePath);
  const guard = validateReadPermission(resolved);
  if (!guard.allowed) throw new Error(deny(guard.reason));
  assertCanonicalReadable(resolved, filePath, mode);
  return resolved;
}

/**
 * Canonical path with every symlink resolved, including symlinked parent
 * directories. A missing tail is resolved through its nearest existing
 * ancestor, so classification of a not-yet-written path still sees the real
 * parent. Fails closed: a symlink component that does not resolve (dangling,
 * looping) and a canonical path outside the repository both throw. Like
 * safeExistsSync it reveals no content, so only the sensitive-path deny list
 * applies (to the input and to the canonical path).
 */
export function safeRealpath(filePath: string): string {
  assertSensitivePathAllowed(filePath, 'read', mediationProbe());
  const resolved = path.resolve(pathResolver.resolve(filePath));
  if (
    isInside(path.resolve(pathResolver.rootDir()), resolved) === undefined &&
    isInside(realRoot().real, resolved) === undefined
  ) {
    throw new Error(`[PATH_OUTSIDE_REPOSITORY] ${filePath} resolves outside the repository`);
  }
  const missing: string[] = [];
  let existing = resolved;
  let real: string;
  try {
    while (!entryExists(existing)) {
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
    real = fs.realpathSync.native(existing);
  } catch {
    throw new Error(
      `[PATH_UNRESOLVABLE] ${filePath} has a component that does not resolve (symlink loop, dangling link or not permitted)`
    );
  }
  const canonical = path.join(real, ...missing);
  const root = fs.realpathSync.native(pathResolver.rootDir());
  const relative = path.relative(root, canonical);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`[PATH_OUTSIDE_REPOSITORY] ${filePath} resolves outside the repository`);
  }
  assertSensitivePathAllowed(canonical, 'read', mediationProbe());
  return canonical;
}

/*
 * Hard links. A hard link is a second name for the same inode, and nothing
 * on the path says where the other names live: `tmp/x/hl.txt` may be the
 * very inode of `knowledge/personal/a.txt`, and a later move can give it any
 * writable name. Operations that read or modify the existing inode in place
 * (read, size, append, copy source, chmod, fsync, open-for-append, move,
 * hard-link source) therefore refuse a regular file with more than one link.
 *
 * Two narrow exceptions:
 * - Lock recovery: in `active/shared/runtime/locks/`, exactly two links named
 *   `<base>` and `<base>.stale-<pid>-<ms>-<n>` (the tomb pair that exists
 *   while safeLinkExclusiveSync puts a displaced record back).
 * - Reads of package files under the root `node_modules/`, or under a
 *   workspace package's `node_modules/` the caller cannot write: the pnpm
 *   store links every package file into each project. Decided on the
 *   canonical path (see isTrustedNodeModulesRead).
 *
 * Both exemptions apply only while the canonical path still names the inode
 * the caller holds. A multi-link file outside the repository (vault mount
 * target) gets no exemption. Writes that replace the entry (safeWriteFile,
 * the copy destination: temp + rename) never touch the old inode.
 */
export type HardLinkOperation = 'read' | 'write';

// `var`: reachable during the secure-io bootstrap cycle (no TDZ).
// eslint-disable-next-line no-var
var STALE_TOMB = /^(.+)\.stale-\d+-\d+-\d+$/;
// eslint-disable-next-line no-var
var WORKSPACE_NODE_MODULES =
  /^(?:libs\/core|libs\/shared-[^/]+|libs\/actuators\/[^/]+|satellites\/[^/]+|presence\/displays\/[^/]+|presence\/bridge\/[^/]+)\/node_modules\//;

/** Read exemption for pnpm store links (see the block comment above). */
function isTrustedNodeModulesRead(canonical: string): boolean {
  // Decided on the CANONICAL path: root node_modules/ also holds pnpm's
  // workspace links (node_modules/@agent/core -> libs/core), so a literal
  // node_modules/ prefix can still land in a writable tree.
  const relative = isInside(path.resolve(pathResolver.rootDir()), canonical);
  if (relative === undefined) return false;
  const posix = relative.split(path.sep).join('/');
  // The pnpm content store: written only by the package manager. Exempt for
  // every caller (SUDO included, whose write scope covers the whole root).
  if (posix.startsWith('node_modules/.pnpm/')) return true;
  if (!posix.startsWith('node_modules/') && !WORKSPACE_NODE_MODULES.test(posix)) return false;
  // A caller that could plant a link at the canonical location gets no exemption.
  return !validateWritePermission(canonical).allowed;
}

/** Lock recovery's `<base>` / `<base>.stale-*` pair in the locks directory. */
function isLockTombPair(canonical: string, stat: fs.Stats): boolean {
  if (stat.nlink !== 2 || stat.ino === 0) return false;
  const locksDir = path.join(path.resolve(pathResolver.rootDir()), 'active/shared/runtime/locks');
  const dir = path.dirname(canonical);
  if (dir !== locksDir && !dir.startsWith(locksDir + path.sep)) return false;
  // Probe-only: the tomb names its base, so only the tomb side qualifies.
  // The base side would need a directory listing to find its tomb; lock
  // inspection treats an unreadable record as live, so refusing it during
  // the put-back window is safe.
  const tombOf = STALE_TOMB.exec(path.basename(canonical));
  if (!tombOf) return false;
  try {
    const base = fs.lstatSync(path.join(dir, tombOf[1]));
    return base.dev === stat.dev && base.ino === stat.ino;
  } catch {
    return false;
  }
}

/**
 * Move-side hard-link rule: a file with other names may only move as a lock
 * tomb, and only within its own locks directory (a tomb moved to another
 * name, e.g. MEMORY.md, would keep aliasing the lock record).
 */
export function assertHardLinkMove(
  resolvedSrc: string,
  srcPath: string,
  resolvedDest: string
): void {
  const stat = fs.lstatSync(resolvedSrc);
  assertNotForeignHardLink(stat, resolvedSrc, srcPath, 'write');
  if (!stat.isFile() || stat.nlink <= 1) return;
  const srcDir = path.dirname(canonicalGuardPath(resolvedSrc, 'leaf'));
  if (path.dirname(canonicalGuardPath(resolvedDest, 'leaf')) !== srcDir) {
    throw new Error(
      `[SECURITY] Refusing to move ${srcPath}: a hard-linked lock tomb may only move within its locks directory`
    );
  }
}

export function assertNotForeignHardLink(
  stat: fs.Stats,
  resolved: string,
  displayPath: string,
  operation: HardLinkOperation
): void {
  if (!stat.isFile() || stat.nlink <= 1) return;
  const canonical = canonicalGuardPath(resolved, 'follow');
  // Every exemption below is judged on `canonical`, which is re-derived from
  // the path after the caller opened or stat-ed the file. A component swapped
  // in between would let the exemption be judged on one file while the bytes
  // come from another, so an exemption applies only when `canonical` still
  // names the very inode the caller holds.
  // A multi-link file outside the repository (a vault mount target) gets no
  // exemption: its other names cannot be pinned or judged from here.
  if (sameInodeAt(canonical, stat)) {
    if (operation === 'read' && isTrustedNodeModulesRead(canonical)) return;
    if (isLockTombPair(canonical, stat)) return;
  }
  throw new Error(
    `[SECURITY] Refusing to ${operation} ${displayPath}: it is a hard link (nlink=${stat.nlink}); its other names may live in another scope`
  );
}

/**
 * True when `canonical` (inside the checkout) currently resolves to the inode
 * `held`. Inode 0 is unverifiable; a path outside the checkout is never pinned.
 */
function sameInodeAt(canonical: string, held: fs.Stats): boolean {
  if (held.ino === 0) return false;
  const target = path.resolve(canonical);
  let now: fs.Stats | undefined;
  try {
    if (target.startsWith(path.resolve(pathResolver.rootDir()) + path.sep))
      now = fs.statSync(target);
    else if (target.startsWith(realRoot().real + path.sep)) now = fs.statSync(target);
  } catch {
    return false;
  }
  return now !== undefined && now.dev === held.dev && now.ino === held.ino;
}

/**
 * A symlink is a standing write grant on its target: every later write
 * through it lands there. Its target must resolve inside the repository and
 * be writable (literal and canonical) by the caller. The link is stored
 * relative. Windows junctions are refused by the caller: they need no
 * privilege and always store an absolute target.
 */
export function assertSymlinkTargetWritable(resolvedTarget: string, displayPath: string): void {
  const canonicalTarget = canonicalGuardPath(resolvedTarget, 'follow');
  if (isInside(path.resolve(pathResolver.rootDir()), canonicalTarget) === undefined) {
    throw new Error(
      `[SECURITY] Refusing to create a symbolic link to ${displayPath}: it resolves outside the repository`
    );
  }
  for (const candidate of new Set([path.resolve(resolvedTarget), canonicalTarget])) {
    assertSensitivePathAllowed(candidate, 'write', mediationProbe());
    const writeGuard = validateWritePermission(candidate);
    if (!writeGuard.allowed) {
      throw new Error(
        `[SECURITY] Refusing to create a symbolic link to ${displayPath}: the target is outside the caller's write scope`
      );
    }
  }
}

/**
 * Copy by replacing the destination entry (temp + rename) instead of writing
 * into its inode, which may be a hard link to a file elsewhere. The source
 * inode is read, so it gets the read-side hard-link check. A symlink
 * destination is refused, as in safeWriteFile.
 */
export function copyReplacing(resolvedSrc: string, srcPath: string, resolvedDest: string): void {
  let destIsLink = false;
  try {
    destIsLink = fs.lstatSync(resolvedDest).isSymbolicLink();
  } catch {
    destIsLink = false;
  }
  if (destIsLink) throw new Error(`[SECURITY] Refusing to replace symbolic link: ${resolvedDest}`);
  // Copy from the descriptor that passed the hard-link check, not the path.
  const src = openInPlace(resolvedSrc, srcPath, 'r', 'read');
  const temp = `${resolvedDest}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  let renamed = false;
  try {
    const out = fs.openSync(temp, 'wx', fs.fstatSync(src).mode & 0o7777);
    try {
      const buffer = Buffer.alloc(64 * 1024);
      let read: number;
      while ((read = fs.readSync(src, buffer, 0, buffer.length, null)) > 0) {
        let written = 0;
        while (written < read) written += fs.writeSync(out, buffer, written, read - written);
      }
    } finally {
      fs.closeSync(out);
    }
    fs.renameSync(temp, resolvedDest);
    renamed = true;
  } finally {
    fs.closeSync(src);
    if (!renamed) fs.rmSync(temp, { force: true });
  }
}

/** chmod through an fd for regular files, so a foreign hard link is refused. */
export function chmodInPlace(
  resolved: string,
  displayPath: string,
  mode: number,
  authorizedCanonical?: string
): void {
  // Through a vetted descriptor for files and directories. A Unix socket
  // cannot be opened: it is chmod'ed at its canonical path after an identity
  // pin. FIFOs and devices are refused.
  const c = fs.constants;
  const peek = fs.statSync(resolved);
  if (peek.isSocket()) {
    const canonical = canonicalGuardPath(resolved, 'follow');
    if (!leafIsInode(canonical, peek)) {
      throw new Error(`[SECURITY] Refusing to chmod ${displayPath}: the entry changed`);
    }
    if (canonical !== authorizedCanonical) assertAuthorizedAt(canonical, displayPath, 'write');
    const target = path.resolve(canonical);
    if (target.startsWith(path.resolve(pathResolver.rootDir()) + path.sep))
      return fs.chmodSync(target, mode);
    if (target.startsWith(realRoot().real + path.sep)) return fs.chmodSync(target, mode);
    throw new Error(`[SECURITY] Refusing to chmod ${displayPath}: outside the repository`);
  }
  const fd = fs.openSync(resolved, c.O_RDONLY | (c.O_NONBLOCK ?? 0));
  try {
    const held = fs.fstatSync(fd);
    if (!held.isFile() && !held.isDirectory()) {
      throw new Error(`[SECURITY] Refusing to chmod ${displayPath}: not a file or directory`);
    }
    vetOpenedFd(fd, resolved, displayPath, 'write', authorizedCanonical);
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * mkdir -p for a directory whose canonical path (`checkedCanonicalDir`) the
 * caller has already checked. Missing components are created one at a time,
 * and before each mkdir the parent must still canonicalize to the location
 * that was checked,
 * so a component swapped for a link mid-way cannot leave directories in
 * another scope. Only creates inside the checkout.
 */
export function mkdirGuarded(
  resolvedDir: string,
  checkedCanonicalDir: string,
  displayPath: string,
  mode?: number
): void {
  const target = path.resolve(resolvedDir);
  const missing: string[] = [];
  let existing = target;
  while (!entryExists(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  if (missing.length === 0) return;
  const logicalRoot = path.resolve(pathResolver.rootDir());
  const physicalRoot = realRoot().real;
  // Baseline = what the permission check judged, minus the missing tail.
  let expected = path.resolve(checkedCanonicalDir);
  for (let i = 0; i < missing.length; i += 1) expected = path.dirname(expected);
  let current = existing;
  for (const name of missing) {
    current = path.join(current, name);
    if (
      !current.startsWith(logicalRoot + path.sep) &&
      !current.startsWith(physicalRoot + path.sep)
    ) {
      throw new Error(`[SECURITY] Refusing to create ${displayPath}: outside the repository`);
    }
    if (canonicalGuardPath(path.dirname(current), 'follow') !== expected) {
      throw new Error(
        `[SECURITY] Refusing to create ${displayPath}: a parent changed between the permission check and mkdir`
      );
    }
    try {
      fs.mkdirSync(current, { mode });
    } catch (error) {
      if (errnoCode(error) !== 'EEXIST') rethrowAsErrno(error, 'mkdir');
    }
    expected = path.join(expected, name);
  }
}
