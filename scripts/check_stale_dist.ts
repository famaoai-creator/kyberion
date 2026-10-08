#!/usr/bin/env node
/**
 * Detects stale build artifacts: a dist tree whose newest .js is older than
 * the newest TypeScript source it was built from. The ts-loader resolves
 * workspace specifiers like `@agent/core/*` to `<pkg>/dist/` whenever it
 * exists, so a stale package dist serves old exports and surfaces far from
 * the cause (e.g. `pnpm organization` dying with "does not provide an export
 * named ..." while baseline-check reported all_clear).
 *
 * Complements check_dist_workspace_imports.ts: that gate proves dist imports
 * resolve; this one proves dist is as new as its sources.
 *
 * Targets scanned:
 *  - root build (build:repo): scripts/, presence/, satellites/ -> dist/<name>.
 *    The four presence/displays/* surfaces excluded from the root tsconfig
 *    (they build via build:ui) are excluded from the source side.
 *  - actuator build (build:actuators): libs/actuators/** -> dist/libs/actuators.
 *  - package builds (build:packages): each libs/<pkg>/ that has a dist/ dir ->
 *    libs/<pkg>/dist. A package with no dist/ is skipped: the ts-loader falls
 *    back to source in that case, so absence cannot serve stale exports.
 *  - root-emitted package trees (build:repo): tsconfig `paths` pulls
 *    @agent/shared-* / transitively-imported libs sources into the root
 *    program and emits them under dist/libs/<pkg>/ — the `main` of
 *    shared-{media,nerve,network,vision} resolves here, not to libs/<pkg>/dist.
 *    Each dist/libs/<pkg>/ dir present gets its own target vs the package's
 *    tsconfig rootDir, proven against the shared `dist/.tsbuildinfo`.
 *
 * Freshness is proven two ways, most precise first:
 *  1. tsbuildinfo content-hash compare — every tsconfig here is incremental
 *     or composite, and fileInfos[].version is a SHA-256 of file contents.
 *     Any source file whose hash differs from (or is missing among) the
 *     entries recorded under the target's sourceRoot means the last build
 *     never saw that content — regardless of mtime games (`touch`, branch
 *     checkouts that restore identical content, dist hand-touched newer).
 *  2. mtime fallback — when a target's buildinfo is absent or records no
 *     entries under its sourceRoot, stale iff max(source .ts mtime) >
 *     max(newest dist .js mtime, buildinfo mtime). The buildinfo-mtime union
 *     keeps a `touch`ed source from staying flagged once a rebuild ran but
 *     skipped re-emitting identical files. (build:actuators now writes its
 *     own dist/.tsbuildinfo.actuators — before that split, `dist/.tsbuildinfo`
 *     was shared and the last writer's program could starve the other's
 *     hash coverage.)
 *
 * `*.test.ts` is excluded only where the owning tsconfig excludes it
 * (derived per package from its tsconfig exclude list; the root build emits
 * tests, several shared-* package builds compile them too).
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { readTextFile } from '@agent/core/foundation';
import { safeExistsSync, safeReaddir, safeStat } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

// Mirrors tsconfig.json `exclude` for presence/displays: those surfaces build
// through `pnpm run build:ui`, not `build:repo`.
const ROOT_BUILD_EXCLUDED_DIRS: Readonly<Record<string, readonly string[]>> = {
  presence: [
    'displays/chronos-mirror-v2',
    'displays/terminal-hud',
    'displays/operator-surface',
    'displays/concierge',
  ],
};

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
  // Repo-relative tsbuildinfo candidates; the newest existing one's mtime
  // joins the freshness marker (see module doc for the incremental-emit case).
  buildInfo?: readonly string[];
  excludeSourceDirs?: readonly string[];
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
    versions.set(path.resolve(baseDir, name), version);
  }
  return versions;
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
  if (!safeExistsSync(sourceRoot)) return null;
  if (!safeExistsSync(distRoot)) return null;

  const excluded = (spec.excludeSourceDirs ?? []).map((rel) =>
    path.join(sourceRoot, ...rel.split('/'))
  );
  const excludeTests = spec.excludeTests ?? false;
  const source = scanSources(
    sourceRoot,
    (filePath) =>
      isSourceFile(filePath, excludeTests) &&
      !excluded.some((dir) => filePath.startsWith(dir + path.sep))
  );
  const dist = newestMtime(distRoot, (filePath) => path.extname(filePath) === '.js');

  if (source.newestMs === null) return null;
  const base = {
    target: spec.id,
    source_file: source.newestFile ? toRepoRelative(source.newestFile) : null,
    source_mtime_ms: source.newestMs,
    dist_file: dist.file ? toRepoRelative(dist.file) : null,
    dist_mtime_ms: dist.mtimeMs,
  };
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
    const tracked = [...versions.keys()].filter((filePath) =>
      filePath.startsWith(sourceRoot + path.sep)
    );
    if (tracked.length === 0) continue;
    // Only a buildinfo that actually tracks this sourceRoot may join the
    // freshness marker — `dist/.tsbuildinfo` is shared by build:repo and
    // build:actuators, and crediting its mtime here would mask real staleness
    // when the other build wrote it last.
    buildInfoMs = Math.max(buildInfoMs, thisBuildInfoMs);
    const trackedSet = new Set(tracked);
    for (const filePath of source.files) {
      if (!trackedSet.has(filePath)) {
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
        if (fileMs <= thisBuildInfoMs) continue;
        return {
          ...base,
          source_file: toRepoRelative(filePath),
          reason: 'unrecorded_source',
          detail: 'source file has no tsbuildinfo entry — newer than the last build',
        };
      }
      if (hashFile(filePath) !== versions.get(filePath)) {
        return {
          ...base,
          source_file: toRepoRelative(filePath),
          reason: 'source_changed_since_build',
          detail: 'content hash differs from the last recorded build input',
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

function listPackageDistTargets(libsRootRel = 'libs'): StaleTargetSpec[] {
  const libsRoot = pathResolver.rootResolve(libsRootRel);
  if (!safeExistsSync(libsRoot)) return [];
  let entries: string[];
  try {
    entries = safeReaddir(libsRoot);
  } catch {
    return [];
  }
  const specs: StaleTargetSpec[] = [];
  for (const entry of entries) {
    if (entry === 'actuators') continue;
    const pkgDir = path.join(libsRoot, entry);
    let isDir = false;
    try {
      isDir = safeStat(pkgDir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (!safeExistsSync(path.join(pkgDir, 'dist'))) continue;
    // The tsconfig decides where the build's source root is and whether test
    // files are real build inputs — e.g. shared-* compile src/** (tests
    // included) while libs/core and libs/shared-ui exclude them.
    const tsconfig = readPackageTsconfig(pkgDir);
    const rootDir = tsconfig?.compilerOptions?.rootDir?.replace(/^\.\//u, '').replace(/\/$/u, '');
    const sourceRoot = rootDir ? `${libsRootRel}/${entry}/${rootDir}` : `${libsRootRel}/${entry}`;
    // `extends` is intentionally not resolved: today every libs/*/tsconfig
    // extends the root, whose exclude list has no test patterns — so an
    // absent child exclude means tests are real build inputs.
    const excludeTests =
      tsconfig === null
        ? true
        : (tsconfig.exclude ?? []).some((pattern) => /test|__tests__/u.test(pattern));
    specs.push({
      id: `libs/${entry}`,
      sourceRoot,
      distRoot: `${libsRootRel}/${entry}/dist`,
      // Package builds park their tsbuildinfo in one of these two places
      // (libs/core: dist/.tsbuildinfo; libs/shared-*: tsconfig.tsbuildinfo).
      buildInfo: [
        `${libsRootRel}/${entry}/dist/.tsbuildinfo`,
        `${libsRootRel}/${entry}/tsconfig.tsbuildinfo`,
      ],
      excludeTests,
    });
  }
  return specs;
}

/**
 * The root build (build:repo) emits package sources it reaches through
 * tsconfig `paths` into dist/libs/<pkg>/ — e.g. shared-{media,nerve,network,
 * vision} package.json `main` resolves to ../../../dist/libs/<pkg>/src/index.js.
 * Those trees are distinct stale targets from the packages' own libs/<pkg>/dist.
 */
function listRootEmittedPackageTargets(
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
    },
    {
      id: 'root:presence',
      sourceRoot: 'presence',
      distRoot: 'dist/presence',
      buildInfo: ['dist/.tsbuildinfo'],
      excludeSourceDirs: ROOT_BUILD_EXCLUDED_DIRS.presence,
    },
    {
      id: 'root:satellites',
      sourceRoot: 'satellites',
      distRoot: 'dist/satellites',
      buildInfo: ['dist/.tsbuildinfo'],
    },
    {
      id: 'libs/actuators',
      sourceRoot: 'libs/actuators',
      distRoot: 'dist/libs/actuators',
      // Own buildinfo since tsconfig.actuators.json sets tsBuildInfoFile;
      // the shared dist/.tsbuildinfo remains as fallback for trees built
      // before the split.
      buildInfo: ['dist/.tsbuildinfo.actuators', 'dist/.tsbuildinfo'],
      excludeTests: true,
    },
    ...listPackageDistTargets(),
    ...listRootEmittedPackageTargets(),
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
