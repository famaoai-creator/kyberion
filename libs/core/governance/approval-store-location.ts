/**
 * Physical placement of approval records: the system tree, or a per-tenant
 * partition.
 *
 * Every approval whose scope names a tenant — except a tenant-activation
 * request for a tenant that is not yet active — lives in that tenant's own
 * partition,
 * `active/shared/runtime/tenant-approvals/<personal|confidential>/<tenant>/<channel>/`
 * (`requests/<id>.json`, `passkey-challenges/<id>.json`, `approvals.jsonl`).
 * Untenanted records keep the system tree
 * (`active/shared/coordination/channels/<channel>/approvals/…`,
 * `active/shared/observability/channels/<channel>/approvals.jsonl`). A public
 * tenant record is stored in the tenant's `confidential` partition (a
 * tenant_scope protected prefix); its recorded scope keeps tier `public`.
 *
 * Callers keep addressing a record by `(storageChannel, id)`.
 * {@link locateApprovalRequest} finds it: the system tree first (which also
 * holds legacy tenant records written before the partition existed), then the
 * partitions this process may bind — only its own tenant when it has an
 * active tenant, every tenant otherwise. A partition is read and written as
 * the tenant-bound `tenant_approval_store` role bound to the record's tenant;
 * a process bound to another tenant never finds the record and cannot write
 * it. Mutators write back to where the record was found, never to a
 * caller-derived location.
 */
import * as path from 'node:path';
import { resolveIdentityContext, withExecutionContext } from '../authority.js';
import { appendJsonLine } from '../foundation/json.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeFsyncFile,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import { storagePartitionSegments } from '../storage-layout.js';
import type { EventScope, EventScopeInput } from '../event-scope.js';
import {
  ensureRegularGovernedArtifactFile,
  readGovernedArtifactJson,
  resolveGovernedArtifactPath,
} from '../workforce/artifact-store-reader.js';
// Type only: the artifact-store writer module must stay out of this module's
// runtime graph (the read path below is imported by light readers).
import type { GovernedArtifactRole } from '../workforce/artifact-store.js';
import {
  approvalEventLogicalPath,
  approvalPasskeyChallengesLogicalDir,
  approvalRequestLogicalPath,
  approvalRequestsLogicalDir,
  approvalStoreRoots,
  normalizeApprovalChannel,
  normalizeApprovalRequestId,
} from './approval-store-paths.js';
import type { ApprovalRequestRecord } from './approval-store.js';

const logger = createLogger('approval-store-location');

/** Tenant-bound store role of the tenant partitions (security-policy.json). */
export const TENANT_APPROVAL_STORE_ROLE = 'tenant_approval_store';
/** Lists tenant directory names under the partition tiers only (descendants denied). */
export const TENANT_APPROVAL_PARTITION_INDEX_READER_ROLE = 'tenant_approval_partition_index_reader';
/**
 * Storage channel of tenant-activation requests
 * (organization/tenant-activation-approval.ts TENANT_ACTIVATION_APPROVAL_CHANNEL).
 */
export const TENANT_ACTIVATION_STORAGE_CHANNEL = 'tenant-activation';

export type ApprovalPartitionTier = 'personal' | 'confidential';

export interface ApprovalTenantPartition {
  kind: 'tenant';
  tier: ApprovalPartitionTier;
  tenant_slug: string;
}

export type ApprovalPartition = { kind: 'system' } | ApprovalTenantPartition;

export const SYSTEM_APPROVAL_PARTITION: ApprovalPartition = Object.freeze({ kind: 'system' });

/** A record together with where it was found. */
export interface LocatedApprovalRequest {
  record: ApprovalRequestRecord;
  partition: ApprovalPartition;
  storageChannel: string;
}

const PARTITION_TIERS: readonly ApprovalPartitionTier[] = ['personal', 'confidential'];

/** Storage tier of a tenant partition: `personal` stays personal, every other tier is `confidential`. */
export function tenantApprovalPartitionTier(tier: string | undefined): ApprovalPartitionTier {
  return tier === 'personal' ? 'personal' : 'confidential';
}

function normalizedTenant(value: string | undefined): string | undefined {
  const tenant = (value || '').trim().toLowerCase();
  return tenant && isValidTenantSlug(tenant) ? tenant : undefined;
}

/**
 * Where a record with this scope is stored (decision 2 of the partition
 * design): a valid `tenant_slug` → that tenant's partition, except a
 * tenant-activation request (`storageChannel` `tenant-activation`) unless the
 * caller states the tenant is already active (`tenantActive: true`). Anything
 * else — no scope, no tenant, an invalid tenant — is the system tree.
 */
export function approvalPartitionForScope(
  scope: EventScope | EventScopeInput | undefined,
  options: { storageChannel?: string; tenantActive?: boolean } = {}
): ApprovalPartition {
  const tenant = normalizedTenant(scope?.tenant_slug);
  if (!tenant) return SYSTEM_APPROVAL_PARTITION;
  if (
    options.storageChannel !== undefined &&
    normalizeApprovalChannel(options.storageChannel) === TENANT_ACTIVATION_STORAGE_CHANNEL &&
    options.tenantActive !== true
  ) {
    return SYSTEM_APPROVAL_PARTITION;
  }
  return { kind: 'tenant', tier: tenantApprovalPartitionTier(scope?.tier), tenant_slug: tenant };
}

// ---------------------------------------------------------------------------
// Logical paths
// ---------------------------------------------------------------------------

/** Repo-relative root of one tenant partition (`<root>/<tier>/<tenant>`). */
export function tenantApprovalPartitionLogicalRoot(partition: ApprovalTenantPartition): string {
  return path.posix.join(
    approvalStoreRoots().tenantApprovals,
    ...storagePartitionSegments({
      kind: 'tier',
      tier: tenantApprovalPartitionTier(partition.tier),
      tenant: partition.tenant_slug,
    })
  );
}

/** Tenant partition: `<root>/<tier>/<tenant>/<channel>/requests`. */
export function tenantApprovalRequestsLogicalDir(
  partition: ApprovalTenantPartition,
  storageChannel: string
): string {
  return `${tenantApprovalPartitionLogicalRoot(partition)}/${normalizeApprovalChannel(storageChannel)}/requests`;
}

/** Tenant partition: `<root>/<tier>/<tenant>/<channel>/requests/<id>.json`. */
export function tenantApprovalRequestLogicalPath(
  partition: ApprovalTenantPartition,
  storageChannel: string,
  id: string
): string {
  return `${tenantApprovalRequestsLogicalDir(partition, storageChannel)}/${normalizeApprovalRequestId(id)}.json`;
}

/** Tenant partition: `<root>/<tier>/<tenant>/<channel>/approvals.jsonl`. */
export function tenantApprovalEventLogicalPath(
  partition: ApprovalTenantPartition,
  storageChannel: string
): string {
  return `${tenantApprovalPartitionLogicalRoot(partition)}/${normalizeApprovalChannel(storageChannel)}/approvals.jsonl`;
}

/** Tenant partition: `<root>/<tier>/<tenant>/<channel>/passkey-challenges`. */
export function tenantApprovalPasskeyChallengesLogicalDir(
  partition: ApprovalTenantPartition,
  storageChannel: string
): string {
  return `${tenantApprovalPartitionLogicalRoot(partition)}/${normalizeApprovalChannel(storageChannel)}/passkey-challenges`;
}

/** Request directory of a channel in either location. */
export function approvalRequestsLogicalDirAt(
  partition: ApprovalPartition,
  storageChannel: string
): string {
  return partition.kind === 'system'
    ? approvalRequestsLogicalDir(storageChannel)
    : tenantApprovalRequestsLogicalDir(partition, storageChannel);
}

/** Request record path in either location. */
export function approvalRequestLogicalPathAt(
  partition: ApprovalPartition,
  storageChannel: string,
  id: string
): string {
  return partition.kind === 'system'
    ? approvalRequestLogicalPath(storageChannel, id)
    : tenantApprovalRequestLogicalPath(partition, storageChannel, id);
}

/** Event log path in either location. */
export function approvalEventLogicalPathAt(
  partition: ApprovalPartition,
  storageChannel: string
): string {
  return partition.kind === 'system'
    ? approvalEventLogicalPath(storageChannel)
    : tenantApprovalEventLogicalPath(partition, storageChannel);
}

/** Passkey challenge directory in either location. */
export function approvalPasskeyChallengesLogicalDirAt(
  partition: ApprovalPartition,
  storageChannel: string
): string {
  return partition.kind === 'system'
    ? approvalPasskeyChallengesLogicalDir(storageChannel)
    : tenantApprovalPasskeyChallengesLogicalDir(partition, storageChannel);
}

// ---------------------------------------------------------------------------
// Binding
// ---------------------------------------------------------------------------

/** This process's active tenant (undefined = unbound: operator CLI, an untenanted server). */
function activeTenant(): string | undefined {
  return normalizedTenant(resolveIdentityContext().tenantSlug);
}

/** Whether this process may bind the tenant-bound store role to `tenantSlug`. */
export function mayBindApprovalTenant(tenantSlug: string): boolean {
  const active = activeTenant();
  return !active || active === tenantSlug.toLowerCase();
}

/**
 * Refuse a tenant partition write this process may not bind, BEFORE anything
 * is written, so a transition never half-writes and then throws
 * [ROLE_TENANT_SCOPE_MISMATCH]. Names only this process's own tenant.
 */
function assertMayBindApprovalTenant(tenantSlug: string): void {
  if (mayBindApprovalTenant(tenantSlug)) return;
  throw new Error(
    `[APPROVAL_TENANT_BINDING_CONFLICT] this process is bound to tenant '${activeTenant()}', not the approval's tenant | ` +
      'decide or create it from an unbound operator process or as that tenant'
  );
}

/** Run `fn` as `tenant_approval_store` bound to `tenantSlug`. */
export function asTenantApprovalStore<T>(tenantSlug: string, fn: () => T): T {
  return withExecutionContext(TENANT_APPROVAL_STORE_ROLE, fn, undefined, tenantSlug);
}

// ---------------------------------------------------------------------------
// Partition I/O (system → the caller's role; tenant → the tenant-bound store role).
// System writes have the semantics of workforce/artifact-store's governed
// writers (the role assumed around a regular-file write under a governed path).
// ---------------------------------------------------------------------------

/** Run `fn` as the identity that may write `partition`, refusing an unbindable tenant first. */
function asPartitionWriter<T>(
  role: GovernedArtifactRole,
  partition: ApprovalPartition,
  fn: () => T
): T {
  if (partition.kind === 'system') return withExecutionContext(role, fn);
  assertMayBindApprovalTenant(partition.tenant_slug);
  return asTenantApprovalStore(partition.tenant_slug, fn);
}

/** Resolve a governed file path, create its directory and refuse a non-regular file. */
function prepareGovernedFile(logicalPath: string): string {
  const resolved = resolveGovernedArtifactPath(logicalPath);
  const dir = path.dirname(resolved);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  ensureRegularGovernedArtifactFile(resolved);
  return resolved;
}

/** Read a JSON file in a location; null when absent. */
export function readApprovalJsonAt<T>(partition: ApprovalPartition, logicalPath: string): T | null {
  if (partition.kind === 'system') return readGovernedArtifactJson<T>(logicalPath);
  if (!mayBindApprovalTenant(partition.tenant_slug)) return null;
  return asTenantApprovalStore(partition.tenant_slug, () =>
    readGovernedArtifactJson<T>(logicalPath)
  );
}

/** List a directory in a location (sorted); empty when absent or not bindable. */
export function listApprovalDirAt(partition: ApprovalPartition, logicalDir: string): string[] {
  const list = (): string[] => {
    const resolved = resolveGovernedArtifactPath(logicalDir);
    return safeExistsSync(resolved) ? safeReaddir(resolved).sort() : [];
  };
  if (partition.kind === 'system') return list();
  if (!mayBindApprovalTenant(partition.tenant_slug)) return [];
  return asTenantApprovalStore(partition.tenant_slug, list);
}

/** Create a directory in a location. */
export function ensureApprovalDirAt(
  role: GovernedArtifactRole,
  partition: ApprovalPartition,
  logicalDir: string
): string {
  return asPartitionWriter(role, partition, () => {
    const resolved = resolveGovernedArtifactPath(logicalDir);
    if (!safeExistsSync(resolved)) safeMkdir(resolved, { recursive: true });
    return resolved;
  });
}

/** Write a JSON file in a location; `fsync` flushes it before returning. */
export function writeApprovalJsonAt(
  role: GovernedArtifactRole,
  partition: ApprovalPartition,
  logicalPath: string,
  value: unknown,
  options: { fsync?: boolean } = {}
): string {
  return asPartitionWriter(role, partition, () => {
    const resolved = prepareGovernedFile(logicalPath);
    safeWriteFile(logicalPath, JSON.stringify(value, null, 2));
    if (options.fsync) safeFsyncFile(resolved);
    return resolved;
  });
}

/** Append one JSON line in a location. */
export function appendApprovalJsonlAt(
  role: GovernedArtifactRole,
  partition: ApprovalPartition,
  logicalPath: string,
  value: unknown
): string {
  return asPartitionWriter(role, partition, () => {
    const resolved = prepareGovernedFile(logicalPath);
    appendJsonLine(logicalPath, value);
    return resolved;
  });
}

// ---------------------------------------------------------------------------
// Partition enumeration and lookup
// ---------------------------------------------------------------------------

function listTierTenants(tier: ApprovalPartitionTier): string[] {
  const dir = `${approvalStoreRoots().tenantApprovals}/${tier}`;
  try {
    return withExecutionContext(
      TENANT_APPROVAL_PARTITION_INDEX_READER_ROLE,
      () => {
        const resolved = pathResolver.resolve(dir);
        return safeExistsSync(resolved) ? safeReaddir(resolved).sort() : [];
      },
      'worker'
    ).filter((name) => normalizedTenant(name) === name);
  } catch (err) {
    logger.debug(
      `tenant approval partition listing skipped — unreadable tier directory | next: check the tenant approval root | evidence: ${tier}: ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
}

/**
 * Every tenant partition this process may bind: its own tenant's partitions
 * (both tiers) when it has an active tenant, otherwise every tenant directory
 * the index reader lists. Only partitions that exist are returned.
 */
export function listApprovalPartitions(): ApprovalTenantPartition[] {
  const active = activeTenant();
  const partitions: ApprovalTenantPartition[] = [];
  for (const tier of PARTITION_TIERS) {
    const tenants = active ? [active] : listTierTenants(tier);
    for (const tenant of tenants) {
      const partition: ApprovalTenantPartition = { kind: 'tenant', tier, tenant_slug: tenant };
      if (active) {
        const exists = asTenantApprovalStore(tenant, () =>
          safeExistsSync(pathResolver.resolve(tenantApprovalPartitionLogicalRoot(partition)))
        );
        if (!exists) continue;
      }
      partitions.push(partition);
    }
  }
  return partitions;
}

/** Partitions of one tenant (both tiers) this process may bind; empty when it may not. */
export function approvalPartitionsForTenant(tenantSlug: string): ApprovalTenantPartition[] {
  const tenant = normalizedTenant(tenantSlug);
  if (!tenant || !mayBindApprovalTenant(tenant)) return [];
  return PARTITION_TIERS.map((tier) => ({ kind: 'tenant', tier, tenant_slug: tenant }));
}

/** Storage channels that have a request directory in a location. */
export function listApprovalChannelsAt(partition: ApprovalPartition): string[] {
  const root =
    partition.kind === 'system'
      ? approvalStoreRoots().coordination
      : tenantApprovalPartitionLogicalRoot(partition);
  return listApprovalDirAt(partition, root).filter((entry) => {
    let channel: string;
    try {
      channel = normalizeApprovalChannel(entry, 'storage channel');
    } catch {
      return false;
    }
    return approvalDirExistsAt(partition, approvalRequestsLogicalDirAt(partition, channel));
  });
}

function approvalDirExistsAt(partition: ApprovalPartition, logicalDir: string): boolean {
  const exists = (): boolean => safeExistsSync(resolveGovernedArtifactPath(logicalDir));
  if (partition.kind === 'system') return exists();
  return asTenantApprovalStore(partition.tenant_slug, exists);
}

function describePartition(partition: ApprovalPartition): string {
  return partition.kind === 'system' ? 'system' : `${partition.tier} tenant partition`;
}

/**
 * Find a request by `(storageChannel, id)`: the system tree first (it also
 * holds legacy tenant records), then — with a `scope` hint naming a tenant —
 * that tenant's partitions only, otherwise every partition this process may
 * bind ({@link listApprovalPartitions}). Null when no bindable location holds
 * it (a process bound to tenant A never finds tenant B's record). Throws
 * `[APPROVAL_LOCATION_AMBIGUOUS]` when the id exists in more than one place.
 */
export function locateApprovalRequest(
  storageChannel: string,
  id: string,
  options: { scope?: EventScope | EventScopeInput } = {}
): LocatedApprovalRequest | null {
  const channel = normalizeApprovalChannel(storageChannel);
  const requestId = normalizeApprovalRequestId(id);
  const found: LocatedApprovalRequest[] = [];
  const system = readApprovalJsonAt<ApprovalRequestRecord>(
    SYSTEM_APPROVAL_PARTITION,
    approvalRequestLogicalPath(channel, requestId)
  );
  if (system)
    found.push({ record: system, partition: SYSTEM_APPROVAL_PARTITION, storageChannel: channel });
  const hinted = normalizedTenant(options.scope?.tenant_slug);
  const partitions = hinted ? approvalPartitionsForTenant(hinted) : listApprovalPartitions();
  for (const partition of partitions) {
    const record = readApprovalJsonAt<ApprovalRequestRecord>(
      partition,
      tenantApprovalRequestLogicalPath(partition, channel, requestId)
    );
    if (record) found.push({ record, partition, storageChannel: channel });
  }
  if (found.length > 1) {
    throw new Error(
      `[APPROVAL_LOCATION_AMBIGUOUS] approval request ${channel}/${requestId} exists in ${found.length} locations (${found.map((entry) => describePartition(entry.partition)).join(', ')}) | ` +
        'next: keep one copy (the approval store hygiene tenant-partition migration reports both) and remove the other | ' +
        `evidence: ${requestId}`
    );
  }
  return found[0] ?? null;
}

/**
 * Refuse a write when the location a record was found in disagrees with the
 * record's own scope: a tenant partition must hold only that tenant's
 * records, in the tier partition its scope maps to. The system tree accepts
 * any record (untenanted, pre-activation, or a legacy tenant record written
 * before the partition existed, which stays writable in place until moved).
 */
export function assertApprovalLocationAgrees(
  partition: ApprovalPartition,
  record: Pick<ApprovalRequestRecord, 'id' | 'scope' | 'storageChannel'>
): void {
  if (partition.kind === 'system') return;
  const expected = approvalPartitionForScope(record.scope, { tenantActive: true });
  if (
    expected.kind !== 'tenant' ||
    expected.tenant_slug !== partition.tenant_slug ||
    expected.tier !== partition.tier
  ) {
    throw new Error(
      `[APPROVAL_LOCATION_MISMATCH] approval request ${record.id} was found in a ${partition.tier} tenant partition that does not match its recorded scope | ` +
        'next: inspect the record; it was not changed | ' +
        `evidence: ${record.storageChannel}/${record.id}`
    );
  }
}

/** Write an updated record back to where it was found (after the agreement check). */
export function writeLocatedApprovalRequest(
  role: GovernedArtifactRole,
  located: Pick<LocatedApprovalRequest, 'partition' | 'storageChannel'>,
  updated: ApprovalRequestRecord,
  options: { fsync?: boolean } = {}
): string {
  assertApprovalLocationAgrees(located.partition, updated);
  return writeApprovalJsonAt(
    role,
    located.partition,
    approvalRequestLogicalPathAt(located.partition, located.storageChannel, updated.id),
    updated,
    options
  );
}

/** Append an event line to the event log of the location a record lives in. */
export function appendLocatedApprovalEvent(
  role: GovernedArtifactRole,
  located: Pick<LocatedApprovalRequest, 'partition' | 'storageChannel'>,
  event: Record<string, unknown>
): string {
  return appendApprovalJsonlAt(
    role,
    located.partition,
    approvalEventLogicalPathAt(located.partition, located.storageChannel),
    event
  );
}
