/**
 * Layout and scoping primitives of the partitioned delegation store
 * (runtime-storage-layout "Delegation trace and records"), shared by the
 * delegated-task trace/record store (`delegated-task-observability.ts`) and the
 * background-delegation notification queue (`mission/delegation-notifications.ts`)
 * so both resolve the same partition, bound tenant and store role.
 *
 * `<root>/system/` holds untenanted delegations, `<root>/confidential/<tenant>/`
 * tenant ones. `<root>` is the registered ledger root
 * `active/shared/runtime/delegation-records`, whose tenant partitions only the
 * tenant-bound `delegation_record_store` role may read or write (tier-guard
 * tenant check + dedicated-store rule). Tests namespace the store via
 * KYBERION_DELEGATION_STORE_DIR (resolved lazily per call).
 */
import * as path from 'node:path';
import { currentResourceAccessScope } from '../foundation/resource-access-scope.js';
import { resolvePolicyIdentityContext } from '../identity-context-bridge.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { logger } from '../core.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir } from '../secure-io.js';
import { withExecutionContext, withExecutionContextAsync } from '../authority.js';
import { isReservedScopeName, isValidTenantSlug } from '../foundation/scope.js';
import { DELEGATION_RECORD_ROOT_PATH } from '../foundation/runtime-state-roots.js';
import { storagePartitionSegments, tenantStoreLedgerPartitionOf } from '../storage-layout.js';

export const DELEGATION_RECORD_STORE_ROLE = 'delegation_record_store';
/** Tenant delegations hold tenant instruction/context/result text: always confidential. */
export const DELEGATION_TENANT_TIER = 'confidential';
const DELEGATION_RECORDS_DIR = 'records';

export function normalizeDelegationTenant(value: string | undefined): string | undefined {
  const slug = String(value ?? '')
    .trim()
    .toLowerCase();
  return slug && isValidTenantSlug(slug) && !isReservedScopeName(slug) && slug !== 'system'
    ? slug
    : undefined;
}

/** The tenant this process (or the current resource scope) is bound to. */
export function boundDelegationTenant(): string | undefined {
  return normalizeDelegationTenant(
    currentResourceAccessScope()?.tenantSlug ?? resolvePolicyIdentityContext().tenantSlug
  );
}

export function delegationStoreRootOverride(): string | undefined {
  return getRegisteredEnvText('KYBERION_DELEGATION_STORE_DIR')?.trim() || undefined;
}

function resolveStoreRoot(): string {
  const override = delegationStoreRootOverride();
  return assertSafeRepositoryPath(
    pathResolver.rootResolve(override ?? DELEGATION_RECORD_ROOT_PATH),
    {
      allowMissingLeaf: true,
    }
  );
}

/** `<root>/system` or `<root>/confidential/<tenant>`. */
export function delegationPartitionDir(tenant: string | undefined): string {
  return assertSafeRepositoryPath(
    path.join(
      resolveStoreRoot(),
      ...storagePartitionSegments(
        tenant ? { kind: 'tier', tier: DELEGATION_TENANT_TIER, tenant } : { kind: 'system' }
      )
    ),
    { allowMissingLeaf: true }
  );
}

/** A file directly inside a partition (`<partition>/<leaf>`). */
export function delegationPartitionFile(tenant: string | undefined, leaf: string): string {
  return assertSafeRepositoryPath(path.join(delegationPartitionDir(tenant), leaf), {
    allowMissingLeaf: true,
  });
}

export function delegationRecordsDirFor(tenant: string | undefined): string {
  return delegationPartitionFile(tenant, DELEGATION_RECORDS_DIR);
}

export function safeDelegationLeafId(value: string, label: string): string {
  const safeId = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-');
  if (!safeId) throw new Error(`${label} is required.`);
  return safeId;
}

export function delegationRecordPathIn(tenant: string | undefined, delegationId: string): string {
  return assertSafeRepositoryPath(
    path.join(
      delegationRecordsDirFor(tenant),
      `${safeDelegationLeafId(delegationId, 'Delegation id')}.json`
    ),
    { allowMissingLeaf: true }
  );
}

/**
 * Run `fn` as `delegation_record_store` bound to the tenant of the registered
 * partition `filePath` lies in; otherwise (system partition, test override,
 * legacy copy) as the caller. The role is tenant-bound: a caller with another
 * active tenant throws [ROLE_TENANT_SCOPE_MISMATCH] before `fn` runs.
 */
export function asDelegationStore<T>(filePath: string, fn: () => T): T {
  const partition = tenantStoreLedgerPartitionOf(filePath);
  if (partition?.storeRole !== DELEGATION_RECORD_STORE_ROLE || !partition.tenant) return fn();
  return withExecutionContext(DELEGATION_RECORD_STORE_ROLE, fn, undefined, partition.tenant);
}

export async function asDelegationStoreAsync<T>(
  filePath: string,
  fn: () => Promise<T>
): Promise<T> {
  const partition = tenantStoreLedgerPartitionOf(filePath);
  if (partition?.storeRole !== DELEGATION_RECORD_STORE_ROLE || !partition.tenant) return fn();
  return withExecutionContextAsync(DELEGATION_RECORD_STORE_ROLE, fn, undefined, partition.tenant);
}

/** Tenant partitions present under the store root (directory names only). */
export function listDelegationTenantPartitions(): string[] {
  const tierDir = path.join(resolveStoreRoot(), DELEGATION_TENANT_TIER);
  if (!safeExistsSync(tierDir)) return [];
  try {
    return safeReaddir(tierDir)
      .map((entry) => normalizeDelegationTenant(entry))
      .filter((entry): entry is string => Boolean(entry))
      .sort();
  } catch (error) {
    logger.debug(
      `delegation partition listing skipped — ${error instanceof Error ? error.message : String(error)} | next: none | evidence: ${tierDir}`
    );
    return [];
  }
}

/**
 * Tenant a legacy (pre-partition) record or row belongs to: its stamp, else
 * the location of its mission (`active/[archive/]missions/<tier>/<tenant>/<id>`).
 * `{}` = untenanted (no mission, or an untenanted one); null = unattributable
 * (the mission exists but is not visible to this process).
 */
export function legacyDelegationTenant(record: {
  tenant_slug?: string;
  mission_id?: string;
}): { tenant?: string } | null {
  const stamped = normalizeDelegationTenant(record.tenant_slug);
  if (stamped) return { tenant: stamped };
  if (!record.mission_id) return {};
  let missionPath: string | null = null;
  try {
    missionPath = pathResolver.findMissionPath(record.mission_id);
  } catch {
    return null;
  }
  if (!missionPath) return {};
  const segments = path.relative(pathResolver.rootDir(), missionPath).split(path.sep);
  const start = segments[1] === 'archive' ? 3 : 2;
  const rest = segments.slice(start + 1);
  return rest.length === 2 ? { tenant: normalizeDelegationTenant(rest[0]) } : {};
}

/**
 * Partition holding the record of `delegationId`, among the partitions this
 * process may read: a tenant-bound process checks its own partition only; an
 * unbound one checks the system partition, then every tenant partition.
 * `{ tenant }` (undefined = system) when found, null otherwise.
 */
export function delegationRecordPartition(delegationId: string): { tenant?: string } | null {
  const bound = boundDelegationTenant();
  const candidates: Array<string | undefined> = bound
    ? [bound]
    : [undefined, ...listDelegationTenantPartitions()];
  for (const tenant of candidates) {
    try {
      const recordPath = delegationRecordPathIn(tenant, delegationId);
      if (asDelegationStore(recordPath, () => safeExistsSync(recordPath))) {
        return tenant ? { tenant } : {};
      }
    } catch (error) {
      logger.debug(
        `delegation record partition probe skipped — ${error instanceof Error ? error.message : String(error)} | next: none | evidence: ${delegationId}`
      );
    }
  }
  return null;
}
