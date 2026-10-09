import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertSafeRepositoryPath } from '#repository-path-boundary';
import { getProcessEnv } from './foundation/process-env.js';

/**
 * Minimal low-level filesystem helpers for foundational modules that cannot
 * depend on secure-io without creating import cycles.
 *
 * Design constraints:
 * - Read/exists helpers stay low-level so path-resolver can probe parent dirs.
 * - Mutating helpers are limited to the active project root.
 * - This module is foundation-only and should not be used by feature code.
 */
function foundationRoot(): string {
  // Keep in lockstep with path-resolver's findProjectRoot: an explicit
  // KYBERION_ROOT override wins, so governed writes resolve against the same
  // root the resolver produced paths from (test roots, sub-dir execution).
  const envRoot = getProcessEnv('KYBERION_ROOT');
  if (envRoot && fs.existsSync(path.join(envRoot, 'package.json'))) {
    return path.resolve(envRoot);
  }
  let current = path.resolve(process.cwd());
  const root = path.parse(current).root;

  while (current !== root) {
    if (
      fs.existsSync(path.join(current, 'package.json')) &&
      (fs.existsSync(path.join(current, 'libs')) || fs.existsSync(path.join(current, 'knowledge')))
    ) {
      return current;
    }
    current = path.dirname(current);
  }

  return path.resolve(process.cwd());
}

function assertFoundationWritePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const root = foundationRoot();
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(
      `[FOUNDATION_IO_VIOLATION] Write outside project root is not allowed: ${resolved}`
    );
  }
  return resolved;
}

export function rawExistsSync(targetPath: string): boolean {
  return fs.existsSync(targetPath);
}

export function rawReadTextFile(targetPath: string): string {
  return fs.readFileSync(targetPath, 'utf8');
}

export function rawReadBuffer(targetPath: string): Buffer {
  return fs.readFileSync(targetPath);
}

export function rawWriteFile(targetPath: string, data: string | Buffer): void {
  fs.writeFileSync(assertFoundationWritePath(targetPath), data);
}

export function rawMkdirp(targetPath: string): void {
  fs.mkdirSync(assertFoundationWritePath(targetPath), { recursive: true });
}

export function rawUnlinkSync(targetPath: string): void {
  fs.unlinkSync(assertFoundationWritePath(targetPath));
}

export function rawStatSync(targetPath: string): fs.Stats {
  return fs.statSync(targetPath);
}

export function rawLstatSync(targetPath: string): fs.Stats {
  return fs.lstatSync(targetPath);
}

export function rawReaddir(targetPath: string): string[] {
  return fs.readdirSync(targetPath);
}

export function rawReadlinkSync(targetPath: string): string {
  return fs.readlinkSync(targetPath);
}

/** Canonical (all links resolved) path of an existing entry; throws when it does not resolve. */
export function rawRealpathSync(targetPath: string): string {
  return fs.realpathSync.native(targetPath);
}

export function rawSymlinkSync(target: string, linkPath: string): void {
  fs.symlinkSync(target, assertFoundationWritePath(linkPath));
}

/** Maximum accepted size for a strict, in-memory regular-file snapshot. */
export const MAX_SNAPSHOT_READ_BYTES = 64 * 1024 * 1024;

function sameSnapshotFile(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/**
 * Foundation-only mechanics for a bounded, stable regular-file snapshot.
 * Callers must authorize the path through secure-io before entering this helper;
 * the explicit absolute root binds all path and ancestor checks to that scope.
 * Rejects symlinks in every repository-relative path component and binds the
 * opened descriptor to the pre-open file identity before reading any bytes.
 * Rechecks descriptor metadata, the strict path, and every ancestor directory
 * before returning. Directory change times detect transient namespace swaps
 * even when the original directory entries are restored around path checks.
 *
 * O_NONBLOCK prevents a raced FIFO from hanging open; O_NOFOLLOW prevents a
 * raced leaf symlink from being followed. Platforms without either guarantee
 * fail closed. Existing range/tail readers intentionally keep their semantics.
 */
export function rawReadFileSnapshot(filePath: string, rootDir: string, maxBytes: number): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_SNAPSHOT_READ_BYTES) {
    throw new Error(
      `Invalid maxBytes for snapshot read: ${maxBytes} (limit: ${MAX_SNAPSHOT_READ_BYTES})`
    );
  }
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (
    !Number.isInteger(O_NOFOLLOW) ||
    O_NOFOLLOW <= 0 ||
    !Number.isInteger(O_NONBLOCK) ||
    O_NONBLOCK <= 0
  ) {
    throw new Error('[SECURITY] Strict file snapshots are unsupported on this platform');
  }
  if (!path.isAbsolute(filePath) || !path.isAbsolute(rootDir)) {
    throw new Error('[SECURITY] Snapshot path and root must be absolute');
  }
  const resolved = assertSafeRepositoryPath(filePath, { rootDir });
  // Capture top-down before the leaf: replacing a later path component must
  // change an already captured containing directory. Include the trusted root
  // so a first-component swap cannot escape this namespace-change check.
  const ancestors: Array<{ directory: string; stat: fs.BigIntStats }> = [];
  let directory = rootDir;
  const relativeParent = path.relative(directory, path.dirname(resolved));
  const segments = relativeParent ? relativeParent.split(path.sep) : [];
  for (const segment of ['', ...segments]) {
    directory = path.join(directory, segment);
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory()) {
      throw new Error('[SECURITY] Snapshot ancestor is not a regular directory');
    }
    ancestors.push({ directory, stat });
  }
  const before = fs.lstatSync(resolved, { bigint: true });
  if (!before.isFile()) throw new Error(`Not a regular file: ${resolved}`);
  if (before.size < 0n || before.size > BigInt(maxBytes)) {
    throw new Error(`File exceeds snapshot byte limit: ${resolved}`);
  }

  const fd = fs.openSync(resolved, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameSnapshotFile(before, opened)) {
      throw new Error(`[SECURITY] File changed before snapshot read: ${resolved}`);
    }
    // One extra byte detects growth even if a read reaches EOF before the
    // post-read metadata check. Allocation and total reads never exceed cap+1.
    const buffer = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    assertSafeRepositoryPath(resolved, { rootDir });
    const finalPath = fs.lstatSync(resolved, { bigint: true });
    if (
      !sameSnapshotFile(opened, after) ||
      !sameSnapshotFile(opened, finalPath) ||
      offset !== Number(opened.size)
    ) {
      throw new Error(`[SECURITY] File changed during snapshot read: ${resolved}`);
    }
    for (const ancestor of ancestors) {
      const current = fs.lstatSync(ancestor.directory, { bigint: true });
      if (
        !current.isDirectory() ||
        current.dev !== ancestor.stat.dev ||
        current.ino !== ancestor.stat.ino ||
        current.mtimeNs !== ancestor.stat.mtimeNs ||
        current.ctimeNs !== ancestor.stat.ctimeNs
      ) {
        throw new Error('[SECURITY] Snapshot ancestor changed during read');
      }
    }
    return buffer.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}
