/**
 * Scratch promotion — shared vocabulary for keeping useful ad-hoc work.
 *
 * Builders and ADF written under `active/shared/tmp/<job>/` during discovery
 * work are consumable by contract (tmp TTL). Two operator commands lift them
 * out before the janitor deletes them:
 *
 * - `pnpm scratch:promote` copies the authored files of a scratch directory
 *   into `knowledge/confidential/<tenant>/tools/<tool>/` (or
 *   `knowledge/public/tools/<tool>/`) with a `TOOL.json` manifest;
 * - `pnpm pipeline:promote --tenant <slug>` promotes one ADF into the
 *   tenant's `knowledge/confidential/<tenant>/pipelines/` catalog.
 *
 * The tmp sweep (storage-janitor `scanTmp`) uses the same classifiers to give
 * an unpromoted, code-bearing job directory `code_grace_days` beyond the tmp
 * TTL, warning with the exact promote command while the grace runs.
 *
 * Pure helpers only (no I/O) so scripts, the janitor and tests share one
 * definition of "authored code", "job directory" and "tier-bearing source".
 * See knowledge/product/orchestration/scratch-tool-promotion-playbook.md.
 */
import * as nodePath from 'node:path';
import {
  STORAGE_DATA_TIERS,
  STORAGE_FLOOR_ROOTS,
  SYSTEM_PARTITION_SEGMENT,
  classifyStorageFloorPath,
  type StorageDataTier,
} from './storage-layout.js';
import { isValidTenantSlug } from './foundation/scope.js';
import { trimEndChars, trimStartChars } from './foundation/text.js';

/** Extensions that mark a scratch file as authored code (a builder or script). */
export const SCRATCH_CODE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.mts',
  '.js',
  '.mjs',
  '.py',
  '.sh',
];

/** Manifest written into a promoted tool directory. */
export const TOOL_MANIFEST_FILENAME = 'TOOL.json';

/**
 * Marker `scratch:promote` leaves in the promoted scratch directory. Its
 * presence (or a `TOOL.json`) anywhere in a tmp job directory counts as the
 * promotion record: the janitor then applies the plain tmp TTL again.
 */
export const SCRATCH_PROMOTION_MARKER = '.scratch-promoted.json';

/** Durable state floor (system partition) listing scratch dirs in their grace window. */
export const SCRATCH_PROMOTION_CANDIDATES_SUBPATH =
  'runtime/system/scratch-promotion-candidates.json';

/** Per-install salt for candidate ids (system partition, created on first use). */
export const SCRATCH_PROMOTION_SALT_SUBPATH = 'runtime/system/scratch-promotion-salt.json';

/** Default grace beyond the tmp TTL for unpromoted, code-bearing job directories. */
export const DEFAULT_CODE_GRACE_DAYS = 2;

/** Upper bound on the bytes read from one `.json` file to detect an ADF. */
export const ADF_SNIFF_MAX_BYTES = 256 * 1024;

const SCRATCH_TMP_ROOT = STORAGE_FLOOR_ROOTS.scratch;

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/');
}

/** True when a path segment marks vendored, non-authored content. */
export function isVendoredScratchPath(relativePath: string): boolean {
  return toPosix(relativePath)
    .split('/')
    .some((segment) => segment === 'node_modules' || segment === '.git');
}

/** True when the file extension marks authored code. */
export function hasScratchCodeExtension(filePath: string): boolean {
  return SCRATCH_CODE_EXTENSIONS.includes(nodePath.extname(filePath).toLowerCase());
}

/** True when JSON text is an object with a top-level `steps` array (an ADF pipeline). */
export function isAdfJsonText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as { steps?: unknown }).steps)
    );
  } catch {
    return false;
  }
}

/**
 * Authored code: a code extension, or a `.json` ADF. `readJsonText` is only
 * called for `.json` files and may return null when the file is unreadable or
 * too large (then the file does not count).
 */
export function isAuthoredScratchFile(
  filePath: string,
  readJsonText: (filePath: string) => string | null
): boolean {
  if (isVendoredScratchPath(filePath)) return false;
  if (hasScratchCodeExtension(filePath)) return true;
  if (nodePath.extname(filePath).toLowerCase() !== '.json') return false;
  const base = nodePath.basename(filePath);
  if (base === TOOL_MANIFEST_FILENAME || base === SCRATCH_PROMOTION_MARKER) return false;
  const text = readJsonText(filePath);
  return text !== null && isAdfJsonText(text);
}

/** True when the file is a promotion record (tool manifest or promote marker). */
export function isScratchPromotionRecord(filePath: string): boolean {
  const base = nodePath.basename(filePath);
  return base === TOOL_MANIFEST_FILENAME || base === SCRATCH_PROMOTION_MARKER;
}

/**
 * The job directory (repo-relative, POSIX) that owns a file on the tmp floor:
 * - legacy `active/shared/tmp/<job>/…`
 * - `active/shared/tmp/system/<domain>/<job>/…`
 * - `active/shared/tmp/<tier>/<tenant|shared>/<domain>/<job>/…`
 * Returns null for files that sit directly in a partition/domain directory
 * (no job unit) or outside the tmp floor.
 */
export function scratchJobDirFor(repoRelativeFile: string): string | null {
  const relative = toPosix(repoRelativeFile);
  if (!relative.startsWith(`${SCRATCH_TMP_ROOT}/`)) return null;
  const segments = relative.slice(SCRATCH_TMP_ROOT.length + 1).split('/');
  const partition = segments[0].toLowerCase();
  let depth: number;
  if (partition === SYSTEM_PARTITION_SEGMENT) depth = 3;
  else if (STORAGE_DATA_TIERS.includes(partition as StorageDataTier)) depth = 4;
  else depth = 1;
  // The job dir must be a directory: at least one more segment (the file).
  if (segments.length <= depth) return null;
  return [SCRATCH_TMP_ROOT, ...segments.slice(0, depth)].join('/');
}

export interface PromotionSourceScope {
  tier: StorageDataTier;
  /** Tenant slug carried by the path, when it names one. */
  tenant?: string;
  /** Repo-relative prefix that classified the path (for diagnostics). */
  location: string;
}

const TIERED_TREE_PREFIXES = [
  'knowledge',
  'active/missions',
  'active/projects',
  'active/organizations',
  'active/archive/missions',
] as const;

function tenantSegment(value: string | undefined): string | undefined {
  return value && isValidTenantSlug(value) ? value : undefined;
}

/**
 * Classification form of a repo-relative path: POSIX separators, no leading
 * `./`, and case-folded — tier and tenant segments must not escape the guard
 * through a case variant (`Confidential/`) on a case-insensitive filesystem.
 */
function classificationPath(repoRelativePath: string): string {
  return toPosix(repoRelativePath).replace(/^\.\//u, '').toLowerCase();
}

const UNPARTITIONED_MISSION_PATTERN = /^active\/(?:archive\/)?missions\/([^/]+)\//u;

/**
 * True when a path sits in an UNPARTITIONED (legacy) storage-floor directory
 * (`active/shared/tmp/<job>`, `active/shared/staging/<job>`, …) or an
 * unpartitioned mission directory. Its tier is unknown: legacy scratch
 * routinely holds confidential material, so a public promotion needs an
 * explicit acknowledgement.
 */
export function isUnknownTierSource(repoRelativePath: string): boolean {
  const relative = classificationPath(repoRelativePath);
  const floor = classifyStorageFloorPath(relative);
  if (floor) return floor.partition.kind === 'legacy';
  const mission = relative.match(UNPARTITIONED_MISSION_PATTERN)?.[1];
  return mission !== undefined && !STORAGE_DATA_TIERS.includes(mission as StorageDataTier);
}

/**
 * Tier/tenant carried by a source path. Returns null for public, system and
 * legacy (unpartitioned) locations; legacy locations are additionally flagged
 * by {@link isUnknownTierSource}. A tenant-partitioned public floor path still
 * returns a scope (tier `public` with its tenant): its contents are bound to a
 * tenant. Matching is case-insensitive.
 */
export function classifyPromotionSourceScope(
  repoRelativePath: string
): PromotionSourceScope | null {
  const relative = classificationPath(repoRelativePath);
  const floor = classifyStorageFloorPath(relative);
  if (floor) {
    if (floor.partition.kind !== 'tier') return null;
    const { tier, tenant } = floor.partition;
    if (tier === 'public' && !tenant) return null;
    const segments = relative.slice(STORAGE_FLOOR_ROOTS[floor.floor].length + 1).split('/');
    return {
      tier,
      ...(tenant ? { tenant } : {}),
      location: [STORAGE_FLOOR_ROOTS[floor.floor], ...segments.slice(0, 2)].join('/'),
    };
  }
  for (const prefix of TIERED_TREE_PREFIXES) {
    if (!relative.startsWith(`${prefix}/`)) continue;
    const [tier, next] = relative.slice(prefix.length + 1).split('/');
    if (tier !== 'personal' && tier !== 'confidential') continue;
    const tenant = tenantSegment(next);
    return {
      tier,
      ...(tenant ? { tenant } : {}),
      location: `${prefix}/${tier}`,
    };
  }
  if (relative.startsWith('customer/')) {
    const tenant = tenantSegment(relative.split('/')[1]);
    return { tier: 'confidential', ...(tenant ? { tenant } : {}), location: 'customer' };
  }
  return null;
}

/** Tool name suggestion derived from a scratch directory's basename. */
export function suggestScratchToolName(dir: string): string {
  const base = nodePath.basename(toPosix(dir));
  const slug = trimStartChars(
    trimEndChars(base.toLowerCase().replace(/[^a-z0-9]+/gu, '-'), '-'),
    '-'
  ).slice(0, 48);
  return slug || 'scratch-tool';
}

/** The exact `scratch:promote` command an operator should run for a scratch dir. */
export function scratchPromoteCommand(options: {
  dir: string;
  name?: string;
  tenant?: string;
}): string {
  // Never suggest --public: scratch is tier-unknown or tier-bound by default.
  const tenant = options.tenant ?? classifyPromotionSourceScope(options.dir)?.tenant;
  const target = `--tenant ${tenant ?? '<slug>'}`;
  return `pnpm scratch:promote --from ${toPosix(options.dir)} --name ${
    options.name ?? suggestScratchToolName(options.dir)
  } ${target}`;
}

export interface ScratchPromotionCandidate {
  /** Opaque, stable id (sha256 prefix of the job dir) — the key across runs. */
  id: string;
  /**
   * Repo-relative job directory. Omitted for tier-partitioned jobs: the
   * candidates file lives in the system partition and must not carry a
   * tenant slug or job name.
   */
  dir?: string;
  /** Tier of a tier-partitioned job. */
  tier?: StorageDataTier;
  /** Job-relative authored files; empty (`files_redacted`) except for system-partition jobs. */
  files: string[];
  /** True when file names were withheld (legacy and tier-partitioned jobs). */
  files_redacted?: boolean;
  file_count: number;
  first_seen: string;
  /** ISO time after which the janitor deletes the oldest expired file of this dir. */
  delete_after: string;
  command: string;
}

export interface ScratchPromotionCandidatesFile {
  generated_at: string;
  code_grace_days: number;
  candidates: ScratchPromotionCandidate[];
}
