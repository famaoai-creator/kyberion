import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { rootDir } from './path-resolver.js';
import { isReservedScopeName, isValidTenantSlug } from './foundation/scope.js';

/**
 * Runtime storage layout — one governed place per storage purpose.
 *
 * Every runtime write is classified by PURPOSE (how long it lives and who may
 * delete it) and by PARTITION (who owns it: the platform, or a tier/tenant).
 * See knowledge/product/architecture/runtime-storage-layout.md for the
 * placement table; this module is the resolver for the shared "floors".
 *
 * Floor layout: `active/shared/<floor>/<partition>/<domain>/...` where
 * partition is `system` (platform-wide, carries no tenant or personal data)
 * or `<tier>/<tenant|shared>` (data-bearing, enforced by tier-guard and the
 * security-policy tenant_scope protected prefixes).
 *
 * Purposes that are NOT floors keep their dedicated owners:
 * - workspace → `createScratchWorkspace` (workforce/workspace-ledger.ts)
 * - artifact owned by a mission/project/session → `writeScopedArtifact`
 * - state → `active/shared/runtime/<domain>/` (+ physicalScopedPath)
 * - log → `active/shared/logs/`
 */

export type StorageDataTier = 'personal' | 'confidential' | 'public';

export const STORAGE_DATA_TIERS: readonly StorageDataTier[] = [
  'personal',
  'confidential',
  'public',
] as const;

/** Floors resolved by this module, mapped to their repo-relative roots. */
export const STORAGE_FLOOR_ROOTS = {
  /** Consumable intermediates; 24h TTL. Re-creatable by contract. */
  scratch: 'active/shared/tmp',
  /** Inbound external files waiting for perception / ingest; short TTL. */
  staging: 'active/shared/staging',
  /** Derived, re-generable data (digest-keyed sidecars, build trees, models). */
  cache: 'active/shared/cache',
  /** Deliverables owned by the platform or a tenant (no narrower scope). */
  artifact: 'active/shared/artifacts',
} as const;

export type StorageFloor = keyof typeof STORAGE_FLOOR_ROOTS;

export const STORAGE_FLOORS = Object.keys(STORAGE_FLOOR_ROOTS) as StorageFloor[];

/** Partition segment for platform-wide data that belongs to no tenant. */
export const SYSTEM_PARTITION_SEGMENT = 'system';

/** Partition tenant segment for tier data with no tenant binding. */
export const UNTENANTED_PARTITION_SEGMENT = 'shared';

export type StoragePartition =
  { kind: 'system' } | { kind: 'tier'; tier: StorageDataTier; tenant?: string };

export const SYSTEM_PARTITION: StoragePartition = { kind: 'system' };

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function assertSegment(value: string, label: string): string {
  if (!SEGMENT_PATTERN.test(value) || /^\.+$/u.test(value)) {
    throw new Error(`[STORAGE_LAYOUT_SEGMENT_INVALID] ${label} '${value}'`);
  }
  return value;
}

/** Repo-relative partition segments: `['system']` or `[tier, tenant|shared]`. */
export function storagePartitionSegments(partition: StoragePartition): string[] {
  if (partition.kind === 'system') return [SYSTEM_PARTITION_SEGMENT];
  if (!STORAGE_DATA_TIERS.includes(partition.tier)) {
    throw new Error(`[STORAGE_LAYOUT_TIER_INVALID] '${String(partition.tier)}'`);
  }
  const tenant = partition.tenant?.trim().toLowerCase();
  if (!tenant) return [partition.tier, UNTENANTED_PARTITION_SEGMENT];
  if (!isValidTenantSlug(tenant)) {
    throw new Error(`[STORAGE_LAYOUT_TENANT_INVALID] '${partition.tenant}'`);
  }
  return [partition.tier, tenant];
}

/**
 * Repo-relative path on a floor: `<root>/<partition>/<domain>/<...parts>`.
 * `domain` names the owning subsystem (e.g. `voice`, `media-generation`) so
 * retention and offboarding can reason about one subtree at a time.
 */
export function storageFloorRelativePath(
  floor: StorageFloor,
  partition: StoragePartition,
  domain: string,
  ...parts: string[]
): string {
  const root = STORAGE_FLOOR_ROOTS[floor];
  if (!root) throw new Error(`[STORAGE_LAYOUT_FLOOR_INVALID] '${String(floor)}'`);
  const rest = parts
    .flatMap((part) => String(part).split(/[\\/]+/u))
    .filter((part) => part.length > 0)
    .map((part) => assertSegment(part, 'path segment'));
  return path.posix.join(
    root,
    ...storagePartitionSegments(partition),
    assertSegment(domain, 'domain'),
    ...rest
  );
}

/** Absolute path on a floor. Callers still write through secure-io. */
export function resolveStorageFloor(
  floor: StorageFloor,
  partition: StoragePartition,
  domain: string,
  ...parts: string[]
): string {
  return path.join(
    rootDir(),
    ...storageFloorRelativePath(floor, partition, domain, ...parts).split('/')
  );
}

export interface StorageFloorClassification {
  floor: StorageFloor;
  /** `legacy` = directly under the floor root without a partition segment. */
  partition: StoragePartition | { kind: 'legacy' };
}

function toPosixRelative(filePath: string): string {
  const normalized = filePath.replace(/\\/gu, '/');
  if (!path.isAbsolute(filePath)) return normalized.replace(/^\.\//u, '');
  const root = rootDir().replace(/\\/gu, '/').replace(/\/$/u, '');
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

/**
 * Classify a path against the floors. Returns null when the path is not on a
 * floor. A tier partition with a non-slug tenant segment (other than
 * `shared`) is still classified so tier-guard can fail closed on it.
 */
export function classifyStorageFloorPath(filePath: string): StorageFloorClassification | null {
  const relative = toPosixRelative(filePath);
  for (const floor of STORAGE_FLOORS) {
    const root = STORAGE_FLOOR_ROOTS[floor];
    if (relative !== root && !relative.startsWith(`${root}/`)) continue;
    const [first, second] = relative.slice(root.length + 1).split('/');
    if (first === SYSTEM_PARTITION_SEGMENT) return { floor, partition: SYSTEM_PARTITION };
    if (STORAGE_DATA_TIERS.includes(first as StorageDataTier)) {
      const tenant =
        second && second !== UNTENANTED_PARTITION_SEGMENT && !isReservedScopeName(second)
          ? second
          : undefined;
      return { floor, partition: { kind: 'tier', tier: first as StorageDataTier, tenant } };
    }
    return { floor, partition: { kind: 'legacy' } };
  }
  return null;
}

/** Data tier carried by a floor path, or undefined for system/legacy/non-floor paths. */
export function storageFloorTier(filePath: string): StorageDataTier | undefined {
  const classification = classifyStorageFloorPath(filePath);
  return classification?.partition.kind === 'tier' ? classification.partition.tier : undefined;
}

const FLOOR_TIER_SEGMENT = new RegExp(
  `(?:^|/)(?:${Object.values(STORAGE_FLOOR_ROOTS)
    .map((root) => root.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&'))
    .join('|')})/(personal|confidential|public)/`,
  'u'
);

/**
 * Tier of a floor partition found anywhere in a path, independent of the
 * project root (mirrors how tier-guard's detectTier matches `/knowledge/<tier>/`
 * by substring, so a path resolved against a different cwd still classifies).
 */
export function storageFloorTierInPath(filePath: string): StorageDataTier | undefined {
  return filePath.replace(/\\/gu, '/').match(FLOOR_TIER_SEGMENT)?.[1] as
    StorageDataTier | undefined;
}

/**
 * Repo-relative prefixes of the tenant-bearing floor partitions
 * (`<root>/<tier>/` for personal and confidential). Mirrored in
 * security-policy.json `tenant_scope.protected_prefixes`; a governance test
 * keeps the two in sync.
 */
export function protectedStorageFloorPrefixes(): string[] {
  return STORAGE_FLOORS.flatMap((floor) =>
    (['personal', 'confidential'] as const).map((tier) => `${STORAGE_FLOOR_ROOTS[floor]}/${tier}/`)
  );
}

/**
 * Tier/tenant-partitioned runtime ledgers (state purpose, runtime-storage-layout):
 * `<root>/<tier>/<tenant|shared>/<file>.jsonl`, written by `libs/core/metrics.ts`.
 * Their personal/confidential subtrees are tenant_scope protected prefixes in
 * security-policy.json; tier-guard gives reads of them the tenant check plus the
 * persona read rules of `knowledge/<tier>/`, and tenant offboarding purges them.
 */
export const PARTITIONED_RUNTIME_LEDGER_ROOTS = {
  resource_usage: 'active/shared/runtime/usage-ledger',
  execution_metrics: 'active/shared/runtime/execution-metrics',
} as const;

/**
 * Inter-process lock id of a metrics ledger file (foundation/lock-utils
 * withLockSync). Every append to a system ledger file and tenant offboarding's
 * read-filter-rewrite of it take the same lock, so a rewrite never loses an
 * append made while it ran.
 */
export function metricsLedgerLockId(filePath: string): string {
  const digest = createHash('sha256').update(path.resolve(filePath), 'utf8').digest('hex');
  return `metrics-ledger-${digest}`;
}

/** `<root>/<tier>/` prefixes of one partitioned runtime ledger (mirrored in security-policy.json). */
export function partitionedLedgerProtectedPrefixes(root: string): string[] {
  return (['personal', 'confidential'] as const).map((tier) => `${root}/${tier}/`);
}

function nonEmptyText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Tenant of a metrics-ledger row — the ONE resolver used for placement,
 * legacy-row gating, tenant offboarding and the budget governor: the
 * canonical `scope.tenant_slug` (legacy `scope.tenant_id`), then the
 * pre-canonical top-level `tenant_slug` / `tenant` / `tenant_id` fields.
 * Lower-cased; '' when the row names no tenant.
 */
export function metricsRowTenant(row: unknown): string {
  if (!row || typeof row !== 'object') return '';
  const record = row as Record<string, unknown>;
  const scope =
    record.scope && typeof record.scope === 'object'
      ? (record.scope as Record<string, unknown>)
      : {};
  return (
    nonEmptyText(scope.tenant_slug) ||
    nonEmptyText(scope.tenant_id) ||
    nonEmptyText(record.tenant_slug) ||
    nonEmptyText(record.tenant) ||
    nonEmptyText(record.tenant_id)
  ).toLowerCase();
}
