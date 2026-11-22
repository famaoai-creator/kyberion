/**
 * Deterministic content fingerprint of a source tree.
 *
 * Shared by the code-graph extractor (which records the fingerprint when it
 * freezes the denominator) and the reverse_spec evidence checker (which
 * recomputes it at audit time to prove the analyzed source was not modified —
 * the "source intact" invariant). Both sides must enumerate the same files,
 * so the listing rules live here only.
 */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  MAX_RANGE_READ_BYTES,
  safeExistsSync,
  safeLstat,
  safeReaddir,
  safeReadFileRange,
} from '../secure-io.js';
import * as pathResolver from '../path-resolver.js';

/** Directories that are never part of an analyzed source baseline. */
export const SOURCE_TREE_SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
]);

/** Secret-bearing files are neither read nor fingerprinted. */
export const SOURCE_TREE_SKIPPED_FILE_NAMES: ReadonlySet<string> = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.test',
  'credential.kyberion-connections',
  'credential.kyberion-vault',
]);

export const DEFAULT_SOURCE_TREE_MAX_FILES = 200_000;

/** Workspace trees a source root must not contain (runtime state, knowledge tiers, secrets). */
export const SOURCE_ROOT_RESERVED_DIRECTORIES: readonly string[] = ['active', 'knowledge', 'vault'];

/** Floors inside active/ where an analyzed copy may live (inbound files and scratch). */
export const SOURCE_ROOT_ALLOWED_FLOORS: readonly string[] = [
  'active/shared/staging',
  'active/shared/tmp',
];

export interface SourceFingerprint {
  algorithm: 'sha256';
  value: string;
  file_count: number;
}

export interface ResolvedSourceRoot {
  /** Absolute path of the source root. */
  absolute: string;
  /** Workspace-relative POSIX path ('.' for the workspace root). */
  relative: string;
}

/** Resolve a workspace-relative (or absolute in-workspace) source root; throws outside the workspace. */
export function resolveWorkspaceSourceRoot(sourceRoot: string): ResolvedSourceRoot {
  const workspace = pathResolver.rootDir();
  const absolute = path.resolve(workspace, sourceRoot || '.');
  const relative = path.relative(workspace, absolute).replaceAll(path.sep, '/');
  if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`[SOURCE_ROOT] source_root must stay within the workspace: ${sourceRoot}`);
  }
  // A root that contains Kyberion's own runtime or knowledge trees would fingerprint mission
  // evidence written during the analysis (never stable) and walk higher-tier knowledge; a root
  // inside them is just as unsafe, except the inbound/scratch floors legacy code is copied into.
  for (const reserved of SOURCE_ROOT_RESERVED_DIRECTORIES) {
    const reservedAbs = path.join(workspace, reserved);
    const containsReserved =
      reservedAbs === absolute || reservedAbs.startsWith(absolute + path.sep);
    const insideReserved = absolute.startsWith(reservedAbs + path.sep);
    const allowedFloor = SOURCE_ROOT_ALLOWED_FLOORS.some((floor) => {
      const floorAbs = path.join(workspace, floor);
      return absolute.startsWith(floorAbs + path.sep);
    });
    if (containsReserved || (insideReserved && !allowedFloor)) {
      throw new Error(
        `[SOURCE_ROOT] source_root ${sourceRoot || '.'} overlaps the workspace ${reserved}/ tree — copy the target under active/shared/staging/<job>/ and point source_root there`
      );
    }
  }
  if (!safeExistsSync(absolute) || !safeLstat(absolute).isDirectory()) {
    throw new Error(`[SOURCE_ROOT] source_root directory not found: ${sourceRoot}`);
  }
  return { absolute, relative: relative || '.' };
}

/**
 * Sorted POSIX paths (relative to `absoluteRoot`) of every regular file in the
 * tree. Symlinks are skipped. Exceeding `maxFiles` throws instead of silently
 * truncating — a truncated listing cannot serve as a coverage denominator.
 */
export function listSourceTreeFiles(
  absoluteRoot: string,
  options: { maxFiles?: number } = {}
): string[] {
  const maxFiles = options.maxFiles ?? DEFAULT_SOURCE_TREE_MAX_FILES;
  const result: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of safeReaddir(directory).sort()) {
      const absolute = path.join(directory, entry);
      const stat = safeLstat(absolute);
      if (stat.isSymbolicLink()) continue;
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (stat.isDirectory()) {
        if (!SOURCE_TREE_SKIPPED_DIRECTORIES.has(entry)) visit(absolute, relative);
        continue;
      }
      if (!stat.isFile() || SOURCE_TREE_SKIPPED_FILE_NAMES.has(entry)) continue;
      if (result.length >= maxFiles) {
        throw new Error(
          `[SOURCE_TREE] more than ${maxFiles} files under ${absoluteRoot} — narrow source_root or raise max_files`
        );
      }
      result.push(relative);
    }
  };
  visit(absoluteRoot, '');
  return result.sort();
}

function hashFile(absolute: string): string {
  const hash = createHash('sha256');
  const size = safeLstat(absolute).size;
  for (let position = 0; position < size; position += MAX_RANGE_READ_BYTES) {
    hash.update(safeReadFileRange(absolute, position, MAX_RANGE_READ_BYTES));
  }
  return hash.digest('hex');
}

/** Fingerprint = sha256 over `path NUL sha256(content) LF` for every listed file, in sorted order. */
export function computeSourceFingerprint(
  absoluteRoot: string,
  options: { maxFiles?: number; files?: readonly string[] } = {}
): SourceFingerprint {
  const files = options.files
    ? [...options.files].sort()
    : listSourceTreeFiles(absoluteRoot, options);
  const hash = createHash('sha256');
  for (const relative of files) {
    hash.update(`${relative}\0${hashFile(path.join(absoluteRoot, relative))}\n`);
  }
  return { algorithm: 'sha256', value: hash.digest('hex'), file_count: files.length };
}
