/**
 * KD-06: provenance-derived plugin trust.
 *
 * Trust is computed from the plugin's actual acquisition location — never
 * from a manifest's self-declared field, and never from a catalog entry.
 * Only assets that resolve (symlinks followed) inside this repository's own
 * `plugins/` tree are `official`. Everything else is `third-party` unless it
 * matches an explicitly configured curated-origin prefix (config, not the
 * manifest, so a plugin can never promote itself).
 *
 * This module intentionally never accepts a manifest object — that is the
 * enforcement mechanism for "never self-declared".
 */
import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeLstat, safeReaddir, safeReadlink, safeStat } from './secure-io.js';

export type PluginTrustLabel = 'official' | 'curated' | 'third-party';

export interface PluginTrustResult {
  label: PluginTrustLabel;
  /** Fully symlink-resolved source location (or the original URL for remote sources). */
  resolvedSourcePath: string;
  /** Fully symlink-resolved path of this repo's own plugins/ tree. */
  officialRoot: string;
  reason: string;
}

export interface DerivePluginTrustOptions {
  /**
   * Explicit, operator-configured allowlist of curated origins (path
   * prefixes or URL prefixes). Never sourced from the plugin manifest.
   */
  curatedOriginPrefixes?: string[];
}

/** Raised whenever a plugin asset resolves outside the plugin's own root. */
export class PluginTrustViolationError extends Error {
  constructor(message: string) {
    super(`[POLICY_VIOLATION] ${message}`);
    this.name = 'PluginTrustViolationError';
  }
}

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i;

function isRemoteUrl(candidate: string): boolean {
  return URL_SCHEME_PATTERN.test(candidate) && !candidate.toLowerCase().startsWith('file://');
}

/** Codepoint-order prefix match — never localeCompare (cross-platform determinism). */
function matchCuratedPrefix(value: string, prefixes: string[] | undefined): string | undefined {
  if (!prefixes || prefixes.length === 0) return undefined;
  return prefixes.find((prefix) => Boolean(prefix) && value.startsWith(prefix));
}

/**
 * Follows a symlink chain (if any) to its final target using only secure-io
 * primitives. Never throws on a missing/unreadable target — an unresolved
 * path is returned as-is so containment checks can still reject it.
 */
function followSymlinkChain(startPath: string, guardMax = 40): string {
  let current = path.resolve(startPath);
  let hops = 0;
  for (;;) {
    let stat;
    try {
      stat = safeLstat(current);
    } catch {
      return current;
    }
    if (!stat.isSymbolicLink()) return current;
    hops += 1;
    if (hops > guardMax) {
      throw new PluginTrustViolationError(
        `Symlink chain exceeds safety bound while resolving plugin asset: ${startPath}`
      );
    }
    const target = safeReadlink(current);
    current = path.isAbsolute(target) ? target : path.resolve(path.dirname(current), target);
  }
}

/** Fully resolves a filesystem path (directory or file) through any symlinks. */
export function resolvePluginSourceRealPath(candidatePath: string): string {
  return followSymlinkChain(candidatePath);
}

export function isPathContainedIn(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  if (candidateResolved === rootResolved) return true;
  const rel = path.relative(rootResolved, candidateResolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Walks a staged plugin directory and rejects any symlink whose fully
 * resolved target escapes the directory's own realpath. Symlinked
 * directories are rejected outright (not traversed) to avoid re-entrant
 * cross-linking; only symlinked regular files that stay within the root are
 * tolerated by the caller (which dereferences them when copying).
 */
export function assertPluginAssetsContained(rootPath: string): void {
  const rootResolved = resolvePluginSourceRealPath(rootPath);
  const stack: string[] = [path.resolve(rootPath)];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    if (!safeExistsSync(dir)) continue;
    for (const name of safeReaddir(dir)) {
      const entryPath = path.join(dir, name);
      const lst = safeLstat(entryPath);
      if (lst.isSymbolicLink()) {
        const finalTarget = followSymlinkChain(entryPath);
        if (!isPathContainedIn(rootResolved, finalTarget)) {
          throw new PluginTrustViolationError(
            `Plugin asset '${path.relative(rootPath, entryPath)}' is a symlink that escapes the plugin root (resolves to ${finalTarget})`
          );
        }
        if (safeExistsSync(finalTarget) && safeStat(finalTarget).isDirectory()) {
          throw new PluginTrustViolationError(
            `Plugin asset '${path.relative(rootPath, entryPath)}' is a symlinked directory, which is not supported (only symlinked regular files that stay within the plugin root are allowed)`
          );
        }
        continue;
      }
      if (lst.isDirectory()) {
        stack.push(entryPath);
      }
    }
  }
}

/**
 * Derive the trust label for a plugin from where it actually came from.
 * `sourcePath` is either a local filesystem path (already fetched/staged
 * somewhere) or a remote URL string. It is deliberately the ONLY input:
 * callers must not — and this function cannot — consult manifest content.
 */
export function derivePluginTrustLabel(
  sourcePath: string,
  opts: DerivePluginTrustOptions = {}
): PluginTrustResult {
  const trimmed = String(sourcePath || '').trim();
  if (!trimmed) {
    throw new Error('[POLICY_VIOLATION] Plugin source path/URL is required to derive trust');
  }

  const officialRootRaw = path.join(pathResolver.rootDir(), 'plugins');
  const officialRoot = resolvePluginSourceRealPath(officialRootRaw);

  if (isRemoteUrl(trimmed)) {
    const curatedMatch = matchCuratedPrefix(trimmed, opts.curatedOriginPrefixes);
    if (curatedMatch) {
      return {
        label: 'curated',
        resolvedSourcePath: trimmed,
        officialRoot,
        reason: `Source URL matches configured curated origin prefix: ${curatedMatch}`,
      };
    }
    return {
      label: 'third-party',
      resolvedSourcePath: trimmed,
      officialRoot,
      reason: 'Remote URL sources are never official; no curated origin prefix matched',
    };
  }

  const resolvedSourcePath = resolvePluginSourceRealPath(path.resolve(trimmed));
  if (isPathContainedIn(officialRoot, resolvedSourcePath)) {
    return {
      label: 'official',
      resolvedSourcePath,
      officialRoot,
      reason: "Source resolves inside this repository's own plugins/ tree",
    };
  }

  const curatedMatch = matchCuratedPrefix(resolvedSourcePath, opts.curatedOriginPrefixes);
  if (curatedMatch) {
    return {
      label: 'curated',
      resolvedSourcePath,
      officialRoot,
      reason: `Source matches configured curated origin prefix: ${curatedMatch}`,
    };
  }

  return {
    label: 'third-party',
    resolvedSourcePath,
    officialRoot,
    reason:
      "Source is outside this repository's plugins/ tree and no curated origin prefix matched",
  };
}
