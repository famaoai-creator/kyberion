import * as fs from 'node:fs';
import * as path from 'node:path';
import * as pathResolver from './path-resolver.js';
import { assertSensitivePathAllowed } from './sensitive-path-policy.js';
import { validateReadPermission, validateWritePermission } from './tier-guard.js';

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

/** True when an entry exists at p (a dangling symlink counts); throws on ELOOP and the like. */
export function entryExists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
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
  let caseInsensitive = false;
  const swapped = path.join(path.dirname(real), swapCase(path.basename(real)));
  if (swapped !== real) {
    try {
      const a = fs.lstatSync(real);
      const b = fs.lstatSync(swapped);
      caseInsensitive = a.dev === b.dev && a.ino === b.ino;
    } catch {
      caseInsensitive = false;
    }
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
  const wanted = leaf.normalize('NFC').toLowerCase();
  let names: string[];
  try {
    names = fs.readdirSync(realDir);
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
    const real = fs.realpathSync.native(absPath);
    return path.join(path.dirname(real), onDiskLeaf(path.dirname(real), path.basename(real)));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
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
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // `existing` is a dangling symlink (lstat sees it, realpath cannot follow
    // it). A write through it would create its target, so follow it by hand,
    // relative to its real parent so `..` in the link text resolves the way
    // the OS resolves it.
    const parentReal = fs.realpathSync.native(path.dirname(existing));
    const target = path.resolve(parentReal, fs.readlinkSync(existing));
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(
      `[SECURITY] Refusing access to ${resolved}: a path component does not resolve (${code})`
    );
  }
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
      `[SECURITY] Write through symbolic link denied: ${displayPath} resolves to ${canonical}. ${guard.reason ?? ''}`.trim()
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
      `[SECURITY] Read through symbolic link denied: ${displayPath} resolves to ${canonical}. ${guard.reason ?? ''}`.trim()
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
  mode?: number
): number {
  const fd = fs.openSync(resolved, flags, mode);
  try {
    assertNotForeignHardLink(fs.fstatSync(fd), resolved, displayPath, operation);
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(
      `[PATH_UNRESOLVABLE] ${filePath} has a component that does not resolve (${code})`
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
 * very inode of `knowledge/personal/a.txt`. Path canonicalization cannot see
 * that, so operations that read or modify the existing inode in place
 * (read, append, copy source, chmod, fsync, open-for-append) refuse a
 * regular file with more than one link unless every link lives in the same
 * directory as the checked path (e.g. lock recovery's `<file>` +
 * `<file>.stale-*` tomb pair while a displaced record is put back). Writes
 * that replace the entry (safeWriteFile, copy destination: temp + rename)
 * never touch the old inode and need no check.
 *
 * Reads under `node_modules/` are exempt: the pnpm store links every package
 * file into each project. Files outside the repository (vault mounts) are
 * judged by the vault allowance, not by link count.
 */
export type HardLinkOperation = 'read' | 'write';

export function assertNotForeignHardLink(
  stat: fs.Stats,
  resolved: string,
  displayPath: string,
  operation: HardLinkOperation
): void {
  if (!stat.isFile() || stat.nlink <= 1) return;
  const canonical = canonicalGuardPath(resolved, 'follow');
  const logicalRoot = path.resolve(pathResolver.rootDir());
  const relative = isInside(logicalRoot, canonical);
  if (relative === undefined) return;
  if (operation === 'read' && relative.split(path.sep).includes('node_modules')) return;
  const dir = path.dirname(canonical);
  let sameInodeNames = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const st = fs.lstatSync(path.join(dir, name));
        if (st.dev === stat.dev && st.ino === stat.ino) sameInodeNames += 1;
      } catch {
        // raced entry: not a link of this inode
      }
    }
  } catch {
    sameInodeNames = 0;
  }
  if (sameInodeNames >= stat.nlink) return;
  throw new Error(
    `[SECURITY] Refusing to ${operation} ${displayPath}: it is a hard link (nlink=${stat.nlink}) to a file that also lives outside this directory`
  );
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
      `[SECURITY] Refusing to create a symbolic link to ${displayPath}: it resolves outside the repository (${canonicalTarget})`
    );
  }
  for (const candidate of new Set([path.resolve(resolvedTarget), canonicalTarget])) {
    assertSensitivePathAllowed(candidate, 'write', mediationProbe());
    const writeGuard = validateWritePermission(candidate);
    if (!writeGuard.allowed) {
      throw new Error(
        `[SECURITY] Refusing to create a symbolic link to ${displayPath}: the target is outside the caller's write scope. ${writeGuard.reason ?? ''}`.trim()
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
  assertNotForeignHardLink(fs.statSync(resolvedSrc), resolvedSrc, srcPath, 'read');
  let destIsLink = false;
  try {
    destIsLink = fs.lstatSync(resolvedDest).isSymbolicLink();
  } catch {
    destIsLink = false;
  }
  if (destIsLink) throw new Error(`[SECURITY] Refusing to replace symbolic link: ${resolvedDest}`);
  const temp = `${resolvedDest}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    fs.copyFileSync(resolvedSrc, temp, fs.constants.COPYFILE_EXCL);
    fs.renameSync(temp, resolvedDest);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** chmod through an fd for regular files, so a foreign hard link is refused. */
export function chmodInPlace(resolved: string, displayPath: string, mode: number): void {
  if (!fs.statSync(resolved).isFile()) return fs.chmodSync(resolved, mode);
  const fd = openInPlace(resolved, displayPath, 'r', 'write');
  try {
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}
