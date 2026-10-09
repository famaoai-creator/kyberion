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

/** secure-io registers its sensitive-path mediation state here. */
export function registerSensitivePathMediationProbe(probe: () => boolean): void {
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
 *   link). Only the parent is resolved; the leaf name is kept.
 *
 * The canonical path is mapped back into the logical root space
 * (`pathResolver.rootDir()`), so a checkout reached through a symlinked
 * prefix (macOS `/var -> /private/var`, a fixture root) keeps classifying
 * against the same policy prefixes. The Vitest live-subtree remap is not
 * re-applied: the literal path was already remapped by `pathResolver.resolve`
 * and the canonical path names the physical location the OS will touch,
 * which is exactly what the guard must judge.
 *
 * Cost: realpath(3) walks every component (~30 us at depth 15 on the CI
 * VM), so parent directories are served from a small per-process cache that
 * is re-verified on every hit instead of trusted: stat(literal dir) must
 * still reach the cached (dev, ino) — so the bytes land in the very same
 * directory object that was fully resolved — and lstat(cached real path)
 * must still be that directory, not a link. A dir swapped for a link to
 * anywhere else changes the inode and misses, and so does the directory
 * itself renamed away with a link left at its old path (lstat sees the
 * link). The one case a hit cannot see is an ANCESTOR of the cached real
 * path renamed into another location with a link left behind; that needs
 * write permission at the new location plus a link secure-io itself refuses
 * to create (target outside the caller's write scope), and every secure-io
 * move / rm / rmdir / unlink / symlink clears the cache anyway. See the runbook section "secure-io
 * symlink canonicalization" for the measured cost.
 * ---------------------------------------------------------------------------
 */
export type CanonicalMode = 'follow' | 'leaf';

// eslint-disable-next-line no-var
var realRootCache: { root: string; real: string } | undefined;

function realProjectRoot(): string {
  const root = path.resolve(pathResolver.rootDir());
  if (realRootCache?.root === root) return realRootCache.real;
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    // An unresolvable root leaves the logical root as the comparison base;
    // every path below it then fails canonicalization and is refused.
  }
  realRootCache = { root, real };
  return real;
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
    return fs.realpathSync.native(absPath);
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
// eslint-disable-next-line no-var
var realDirCache: Map<string, { dev: number; ino: number; real: string }> | undefined;

/** Drop every cached directory resolution (called after structural mutations). */
export function invalidateRealDirCache(): void {
  realDirCache?.clear();
}

/** True when `p` is itself (not via a final symlink) the directory (dev, ino). */
function sameInode(p: string, dev: number, ino: number): boolean {
  try {
    const st = fs.lstatSync(p);
    return st.dev === dev && st.ino === ino;
  } catch {
    return false;
  }
}

/**
 * Real path of an existing directory, from the verified cache when possible.
 * Returns undefined when `dir` is not an existing directory (callers then
 * take the full physicalPath walk).
 */
function cachedRealDir(dir: string): string | undefined {
  let st: fs.Stats;
  try {
    st = fs.statSync(dir);
  } catch {
    return undefined;
  }
  if (!st.isDirectory()) return undefined;
  const cache = (realDirCache ??= new Map());
  const hit = cache.get(dir);
  if (hit && hit.dev === st.dev && hit.ino === st.ino && sameInode(hit.real, st.dev, st.ino)) {
    return hit.real;
  }
  const real = fs.realpathSync.native(dir);
  if (!sameInode(real, st.dev, st.ino)) return undefined; // raced: let the slow path decide
  if (cache.size >= 4096) cache.clear();
  cache.set(dir, { dev: st.dev, ino: st.ino, real });
  return real;
}

/** physicalPath with the parent served from cachedRealDir; leaf handled per mode. */
function fastPhysicalPath(absolute: string, mode: CanonicalMode): string {
  const parent = path.dirname(absolute);
  const leaf = path.basename(absolute);
  if (parent === absolute) return physicalPath(absolute);
  const realParent = cachedRealDir(parent);
  if (realParent === undefined) {
    return mode === 'follow' ? physicalPath(absolute) : path.join(physicalPath(parent), leaf);
  }
  const candidate = path.join(realParent, leaf);
  if (mode === 'leaf') return candidate;
  let leafStat: fs.Stats;
  try {
    leafStat = fs.lstatSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return candidate; // missing leaf under a real parent
    throw error;
  }
  return leafStat.isSymbolicLink() ? physicalPath(candidate) : candidate;
}

export function canonicalGuardPath(resolved: string, mode: CanonicalMode): string {
  const absolute = path.resolve(resolved);
  let physical: string;
  try {
    physical = fastPhysicalPath(absolute, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new Error(
      `[SECURITY] Refusing access to ${resolved}: a path component does not resolve (${code})`
    );
  }
  const relative = isInside(realProjectRoot(), physical);
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
  assertSensitivePathAllowed(filePath, operation, mediationProbe());
  const resolved = pathResolver.resolve(filePath);
  const guard = validateWritePermission(resolved);
  if (!guard.allowed) throw new Error(guard.reason);
  const canonical = assertCanonicalWritable(resolved, filePath, mode);
  return { resolved, canonical };
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
