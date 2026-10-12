#!/usr/bin/env node
/**
 * Verify every owned compiler tree against its own input hashes and emits.
 * The runtime compiler owns scripts/presence/satellites/actuators; libraries
 * own package-local dist and buildinfo. Physical source shadows are checked
 * separately, including ignored and untracked files.
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeReaddir, safeStat } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

import {
  BUNDLED_SCRIPT_NAMES,
  PACKAGE_BUILD_OUTPUTS,
  ROOT_SOURCE_EXCLUSIONS,
} from './build-output-layout.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

export interface StaleDistTarget {
  target: string;
  source_file: string | null;
  source_mtime_ms: number | null;
  dist_file: string | null;
  dist_mtime_ms: number | null;
  reason:
    | 'source_changed_since_build'
    | 'unrecorded_source'
    | 'source_newer_than_dist'
    | 'dist_missing'
    | 'emit_missing'
    | 'orphaned_emit'
    | 'scan_failed';
  detail?: string;
}

export interface StaleDistScan {
  stale: StaleDistTarget[];
  checked: number;
}

export interface StaleTargetSpec {
  id: string;
  // Repo-relative roots; resolved via pathResolver.rootResolve.
  sourceRoot: string;
  distRoot: string;
  /** Root-program emit retains this prefix below distRoot (e.g. a package's src/). */
  emitPrefix?: string;
  // Repo-relative tsbuildinfo candidates; the newest existing one's mtime
  // joins the freshness marker (see module doc for the incremental-emit case).
  buildInfo?: readonly string[];
  excludeSourceDirs?: readonly string[];
  excludeSourceFiles?: readonly string[];
  required?: boolean;
  checkOrphans?: boolean;
  extraEmits?: readonly string[];
  excludeTests?: boolean;
}

function isSourceFile(filePath: string, excludeTests: boolean): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) return false;
  // Declaration files (.d.ts/.d.mts/.d.cts) are never emitted into the
  // program's output — they are inputs only, and `*.ts` include globs do not
  // match the .mts/.cts spellings either, so they can never be recorded.
  if (/\.d\.[cm]?ts$/u.test(filePath)) return false;
  if (
    excludeTests &&
    (/\.test\.[cm]?tsx?$/u.test(filePath) || filePath.split(path.sep).includes('__tests__'))
  )
    return false;
  return true;
}

interface SourceScan {
  files: string[];
  newestFile: string | null;
  newestMs: number | null;
}

function scanSources(root: string, accept: (filePath: string) => boolean): SourceScan {
  const files: string[] = [];
  let newestFile: string | null = null;
  let newestMs = -1;
  for (const filePath of getAllFiles(root)) {
    if (!accept(filePath)) continue;
    files.push(filePath);
    let mtimeMs: number;
    try {
      mtimeMs = safeStat(filePath).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > newestMs) {
      newestMs = mtimeMs;
      newestFile = filePath;
    }
  }
  return { files, newestFile, newestMs: newestMs >= 0 ? newestMs : null };
}

function newestMtime(
  root: string,
  accept: (filePath: string) => boolean
): { file: string | null; mtimeMs: number | null } {
  const scan = scanSources(root, accept);
  return { file: scan.newestFile, mtimeMs: scan.newestMs };
}

/**
 * Parse a tsbuildinfo into absolute-source-path -> recorded content hash.
 * fileNames are stored relative to the tsbuildinfo's own directory.
 */
function loadBuildInfoVersions(buildInfoPath: string): Map<string, string> | null {
  let parsed: { fileNames?: unknown; fileInfos?: unknown };
  try {
    parsed = JSON.parse(readTextFile(buildInfoPath));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.fileNames) || !Array.isArray(parsed.fileInfos)) return null;
  const baseDir = path.dirname(buildInfoPath);
  const versions = new Map<string, string>();
  for (let i = 0; i < parsed.fileNames.length; i += 1) {
    const name = parsed.fileNames[i];
    if (typeof name !== 'string') continue;
    const info = parsed.fileInfos[i] as { version?: unknown } | string | undefined;
    const version = typeof info === 'string' ? info : info?.version;
    if (typeof version !== 'string') continue;
    versions.set(pathKey(path.resolve(baseDir, name)), version);
  }
  return versions;
}

function pathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  // TypeScript lowercases paths in Windows tsbuildinfo while directory scans
  // retain the on-disk spelling. Windows paths are case-insensitive, so use
  // the same identity for buildinfo and scanned source paths.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fileMtime(filePath: string): number | null {
  try {
    return safeStat(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function hashFile(filePath: string): string | null {
  try {
    return createHash('sha256').update(readTextFile(filePath), 'utf8').digest('hex');
  } catch {
    return null;
  }
}

function toRepoRelative(filePath: string): string {
  return path.relative(pathResolver.rootDir(), filePath).split(path.sep).join('/');
}

function evaluateTarget(
  spec: StaleTargetSpec,
  buildInfoCache: Map<string, Map<string, string> | null> = new Map()
): StaleDistTarget | null {
  const sourceRoot = pathResolver.rootResolve(spec.sourceRoot);
  const distRoot = pathResolver.rootResolve(spec.distRoot);
  if (!safeExistsSync(sourceRoot)) {
    if (!spec.required) return null;
    return {
      target: spec.id,
      source_file: null,
      source_mtime_ms: null,
      dist_file: null,
      dist_mtime_ms: null,
      reason: 'scan_failed',
      detail: 'required compiler source root is missing: ' + spec.sourceRoot,
    };
  }
  if (!safeExistsSync(distRoot) && !spec.required) return null;

  const excluded = (spec.excludeSourceDirs ?? []).map((rel) =>
    path.join(sourceRoot, ...rel.split('/'))
  );
  const excludeTests = spec.excludeTests ?? false;
  const source = scanSources(
    sourceRoot,
    (filePath) =>
      isSourceFile(filePath, excludeTests) &&
      !excluded.some((dir) => filePath.startsWith(dir + path.sep)) &&
      !(spec.excludeSourceFiles ?? []).some((file) => filePath === path.join(sourceRoot, file))
  );
  const dist = safeExistsSync(distRoot)
    ? newestMtime(distRoot, (filePath) => path.extname(filePath) === '.js')
    : { file: null, mtimeMs: null };

  const emitForSource = (filePath: string): string =>
    path.join(
      distRoot,
      spec.emitPrefix || '',
      path.relative(sourceRoot, filePath).replace(/\.[cm]?tsx?$/u, '.js')
    );
  const sourceEvidence = (filePath: string) => {
    const emitted = emitForSource(filePath);
    return {
      source_file: toRepoRelative(filePath),
      source_mtime_ms: fileMtime(filePath),
      dist_file: toRepoRelative(emitted),
      dist_mtime_ms: fileMtime(emitted),
    };
  };

  const base = {
    target: spec.id,
    source_file: source.newestFile ? toRepoRelative(source.newestFile) : null,
    source_mtime_ms: source.newestMs,
    dist_file: dist.file ? toRepoRelative(dist.file) : null,
    dist_mtime_ms: dist.mtimeMs,
  };
  if (spec.checkOrphans && safeExistsSync(distRoot)) {
    const emitted = scanSources(distRoot, (file) => file.endsWith('.js'));
    for (const file of emitted.files) {
      const relative = path.relative(distRoot, file).split(path.sep).join('/');
      if ((spec.extraEmits ?? []).includes(relative)) continue;
      const sourceStem = path.join(sourceRoot, relative.replace(/\.js$/u, ''));
      if (!['.ts', '.tsx'].some((extension) => safeExistsSync(sourceStem + extension))) {
        return {
          ...base,
          source_file: null,
          source_mtime_ms: null,
          dist_file: toRepoRelative(file),
          dist_mtime_ms: fileMtime(file),
          reason: 'orphaned_emit',
          detail:
            'compiler output has no source; run the owned-output clean build after a delete or rename',
        };
      }
    }
  }
  if (source.newestMs === null) return null;
  if (dist.mtimeMs === null) return { ...base, reason: 'dist_missing' as const };

  // Precise pass: a buildinfo that records entries under this sourceRoot lets
  // us compare recorded content hashes instead of trusting mtimes.
  let buildInfoMs = 0;
  for (const rel of spec.buildInfo ?? []) {
    const buildInfoPath = pathResolver.rootResolve(rel);
    if (!safeExistsSync(buildInfoPath)) continue;
    let thisBuildInfoMs = 0;
    try {
      thisBuildInfoMs = safeStat(buildInfoPath).mtimeMs;
    } catch {
      continue;
    }
    if (!buildInfoCache.has(buildInfoPath)) {
      buildInfoCache.set(buildInfoPath, loadBuildInfoVersions(buildInfoPath));
    }
    const versions = buildInfoCache.get(buildInfoPath)!;
    if (!versions) continue;
    const sourceRootKey = pathKey(sourceRoot);
    const tracked = [...versions.keys()].filter((filePath) => {
      // Normalize identity before checking directory components. Resolving
      // sourceRoot + path.sep removes the separator and admits prefix siblings.
      const relative = path.relative(sourceRootKey, filePath);
      return (
        relative !== '' &&
        relative !== '..' &&
        !relative.startsWith('..' + path.sep) &&
        !path.isAbsolute(relative)
      );
    });
    if (tracked.length === 0) continue;
    // Only a buildinfo that actually tracks this sourceRoot may join the
    // freshness marker — `dist/.tsbuildinfo` is shared by build:repo and
    // build:actuators, and crediting its mtime here would mask real staleness
    // when the other build wrote it last.
    buildInfoMs = Math.max(buildInfoMs, thisBuildInfoMs);
    const trackedSet = new Set(tracked);
    for (const filePath of source.files) {
      if (!trackedSet.has(pathKey(filePath))) {
        // A file absent from fileInfos either arrived after this build, or
        // sits outside the program that wrote this buildinfo — the shared
        // `dist/.tsbuildinfo` mixes both build:repo and build:actuators
        // programs, so mtime decides which case this is.
        let fileMs = 0;
        try {
          fileMs = safeStat(filePath).mtimeMs;
        } catch {
          continue;
        }
        if (fileMs <= thisBuildInfoMs && !spec.required) continue;
        return {
          ...base,
          ...sourceEvidence(filePath),
          source_mtime_ms: fileMs,
          reason: 'unrecorded_source',
          detail: spec.required
            ? 'source file has no tsbuildinfo entry in the required compiler project'
            : 'source file has no tsbuildinfo entry — newer than the last build',
        };
      }
      if (hashFile(filePath) !== versions.get(pathKey(filePath))) {
        return {
          ...base,
          ...sourceEvidence(filePath),
          reason: 'source_changed_since_build',
          detail: 'content hash differs from the last recorded build input',
        };
      }
    }
    // Completeness pass: a buildinfo that still credits a source it never
    // re-emitted (incremental emit after a partial dist wipe) leaves the
    // recorded output absent on disk — the freshness check above cannot see
    // that. Verify every tracked source's expected .js exists.
    // Buildinfo keys may be lowercased on Windows. Keep their identity for
    // lookup, but use the scanned path's real spelling for diagnostic provenance.
    const onDisk = new Map(source.files.map((filePath) => [pathKey(filePath), filePath]));
    for (const trackedPath of tracked) {
      const filePath = onDisk.get(trackedPath);
      if (!filePath) continue;
      const emitted = emitForSource(filePath);
      if (!safeExistsSync(emitted)) {
        return {
          ...base,
          ...sourceEvidence(filePath),
          dist_mtime_ms: null,
          reason: 'emit_missing' as const,
          detail:
            'buildinfo records the source but its emitted .js is absent — likely a stale incremental emit after a partial dist wipe',
        };
      }
    }
    // Every tracked source matches the recorded build inputs — fresh,
    // regardless of mtimes.
    return null;
  }

  // Fallback pass: no usable buildinfo for this sourceRoot — compare mtimes.
  const markerMs = Math.max(dist.mtimeMs, buildInfoMs);
  if (source.newestMs > markerMs) return { ...base, reason: 'source_newer_than_dist' as const };
  return null;
}

interface PackageTsconfig {
  compilerOptions?: { rootDir?: string };
  exclude?: string[];
}

function readPackageTsconfig(pkgDir: string): PackageTsconfig | null {
  const tsconfigPath = path.join(pkgDir, 'tsconfig.json');
  try {
    if (!safeExistsSync(tsconfigPath)) return null;
    return JSON.parse(readTextFile(tsconfigPath)) as PackageTsconfig;
  } catch {
    return null;
  }
}

/**
 * The root build (build:repo) emits package sources it reaches through
 * tsconfig `paths` into dist/libs/<pkg>/ — e.g. shared-{media,nerve,network,
 * vision} package.json `main` resolves to ../../../dist/libs/<pkg>/src/index.js.
 * Those trees are distinct stale targets from the packages' own libs/<pkg>/dist.
 */
export function listRootEmittedPackageTargets(
  libsRootRel = 'libs',
  distLibsRel = 'dist/libs'
): StaleTargetSpec[] {
  const distLibsRoot = pathResolver.rootResolve(distLibsRel);
  if (!safeExistsSync(distLibsRoot)) return [];
  let entries: string[];
  try {
    entries = safeReaddir(distLibsRoot);
  } catch {
    return [];
  }
  const specs: StaleTargetSpec[] = [];
  for (const entry of entries) {
    if (entry === 'actuators') continue;
    const pkgDir = pathResolver.rootResolve(path.join(libsRootRel, entry));
    if (!safeExistsSync(pkgDir)) continue;
    const tsconfig = readPackageTsconfig(pkgDir);
    const rootDir = tsconfig?.compilerOptions?.rootDir?.replace(/^\.\//u, '').replace(/\/$/u, '');
    const sourceRoot = rootDir ? `${libsRootRel}/${entry}/${rootDir}` : `${libsRootRel}/${entry}`;
    specs.push({
      id: `dist/libs/${entry}`,
      sourceRoot,
      distRoot: `${distLibsRel}/${entry}`,
      // Keep the discovered dist root: a missing whole src/ subtree must fail,
      // not disappear via evaluateTarget's absent-target compatibility path.
      emitPrefix: rootDir || undefined,
      buildInfo: ['dist/.tsbuildinfo'],
      // The root program admits package sources only via imports — tests are
      // never reachable, matching the package builds' own exclusion for core.
      excludeTests: true,
    });
  }
  return specs;
}

export function defaultStaleDistTargets(): StaleTargetSpec[] {
  return [
    {
      id: 'root:scripts',
      sourceRoot: 'scripts',
      distRoot: 'dist/scripts',
      buildInfo: ['dist/.tsbuildinfo'],
      excludeSourceFiles: ROOT_SOURCE_EXCLUSIONS.scripts,
      extraEmits: BUNDLED_SCRIPT_NAMES.map((name) => name + '.bundle.js'),
      required: true,
      checkOrphans: true,
    },
    {
      id: 'root:presence',
      sourceRoot: 'presence',
      distRoot: 'dist/presence',
      buildInfo: ['dist/.tsbuildinfo'],
      excludeSourceDirs: ROOT_SOURCE_EXCLUSIONS.presence,
      required: true,
      checkOrphans: true,
    },
    {
      id: 'root:satellites',
      sourceRoot: 'satellites',
      distRoot: 'dist/satellites',
      buildInfo: ['dist/.tsbuildinfo'],
      required: true,
      checkOrphans: true,
    },
    {
      id: 'libs/actuators',
      sourceRoot: 'libs/actuators',
      distRoot: 'dist/libs/actuators',
      buildInfo: ['dist/.tsbuildinfo'],
      excludeTests: true,
      required: true,
      checkOrphans: true,
    },
    ...PACKAGE_BUILD_OUTPUTS.map(({ id, sourceRoot, excludeTests }) => ({
      id,
      sourceRoot,
      excludeTests,
      distRoot: id + '/dist',
      buildInfo: [id + '/dist/.tsbuildinfo'],
      required: true,
      checkOrphans: true,
    })),
  ];
}

export function findStaleDistTargets(options: { targets?: StaleTargetSpec[] } = {}): StaleDistScan {
  const stale: StaleDistTarget[] = [];
  const targets = options.targets ?? defaultStaleDistTargets();
  // `dist/.tsbuildinfo` serves every root/actuator target — parse once.
  const buildInfoCache = new Map<string, Map<string, string> | null>();
  for (const spec of targets) {
    try {
      const finding = evaluateTarget(spec, buildInfoCache);
      if (finding) stale.push(finding);
    } catch (error) {
      // A throwing scan must not leave the caller with no actionable finding —
      // surface it as a stale entry, matching the L2 scan-failure convention.
      stale.push({
        target: spec.id,
        source_file: null,
        source_mtime_ms: null,
        dist_file: null,
        dist_mtime_ms: null,
        reason: 'scan_failed',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { stale, checked: targets.length };
}

export function formatStaleDistWarning(scan: StaleDistScan): string | null {
  if (scan.stale.length === 0) return null;
  const first = scan.stale[0];
  const detail =
    first.reason === 'source_newer_than_dist'
      ? `first: ${first.target} (source ${first.source_file} newer than dist ${first.dist_file})`
      : `first: ${first.target} (${first.reason}${first.detail ? `: ${first.detail}` : ''})`;
  return `${scan.stale.length} dist target(s) are stale vs their TypeScript sources — run \`pnpm run build\` to rebuild; ${detail}`;
}

export const runCheckStaleDist = defineScript({
  name: 'check:stale-dist',
  run(context) {
    const scan = findStaleDistTargets();
    const warning = formatStaleDistWarning(scan);
    if (warning) {
      context.print('[check:stale-dist] FAILED');
      throw new ScriptExitError(
        1,
        `${warning}\n${scan.stale.map((s) => `- ${s.target}: ${s.reason}`).join('\n')}`
      );
    }
    context.print(`[check:stale-dist] OK (${scan.checked} targets)`);
  },
});

if (
  isDirectScript(import.meta.url, 'check_stale_dist.ts') ||
  isDirectScript(import.meta.url, 'check_stale_dist.js')
)
  void runCheckStaleDist();
