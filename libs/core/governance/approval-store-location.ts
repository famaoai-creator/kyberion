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
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { createLogger } from '../logger.js';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeFsyncFile,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { storagePartitionSegments } from '../storage-layout.js';
import { validateReadPermission, validateWritePermission } from '../tier-guard.js';
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
/** Kind of a tenant-activation request (the only kind the activation exception applies to). */
export const TENANT_ACTIVATION_REQUEST_KIND = 'mission_gate';

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
 * design): a valid `tenant_slug` → that tenant's partition, except a genuine
 * tenant-activation request — the `tenant-activation` storage channel AND kind
 * `mission_gate`, as organization/tenant-activation-approval.ts creates it —
 * for a tenant that is not yet active, which stays in the system tree.
 * Activeness is the creator's verdict (`tenantActive`, computed there with
 * isTenantActivationActive; the store cannot import the organization layer
 * without a cycle); anything short of `tenantActive: true` keeps the request
 * in the system tree, which is still hidden from processes bound to another
 * tenant (systemRecordVisibleToThisProcess). Anything else — no scope, no
 * tenant, an invalid tenant — is the system tree.
 */
export function approvalPartitionForScope(
  scope: EventScope | EventScopeInput | undefined,
  options: { storageChannel?: string; kind?: string; tenantActive?: boolean } = {}
): ApprovalPartition {
  const tenant = normalizedTenant(scope?.tenant_slug);
  if (!tenant) return SYSTEM_APPROVAL_PARTITION;
  if (
    options.storageChannel !== undefined &&
    normalizeApprovalChannel(options.storageChannel) === TENANT_ACTIVATION_STORAGE_CHANNEL &&
    options.kind === TENANT_ACTIVATION_REQUEST_KIND &&
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

/** Live (never Vitest-remapped) system-tree roots a tenant partition path is confined like. */
const LIVE_SYSTEM_COORDINATION_ROOT = 'active/shared/coordination/channels';
const LIVE_SYSTEM_OBSERVABILITY_ROOT = 'active/shared/observability/channels';

/**
 * The live system-tree path a tenant partition path stands in for:
 * `<ch>/requests/…` → `coordination/channels/<ch>/approvals/requests/…`,
 * `<ch>/passkey-challenges/…` → `…/<ch>/approvals/passkey-challenges/…`,
 * `<ch>/approvals.jsonl` → `observability/channels/<ch>/approvals.jsonl`,
 * `<ch>` → `coordination/channels/<ch>`, the partition root → `coordination/channels`.
 * Absolute (under the project root), so tier-guard judges the real grant even
 * under Vitest, where the store itself lives in the isolated root.
 */
function liveSystemPathFor(partition: ApprovalTenantPartition, logicalPath: string): string {
  const root = tenantApprovalPartitionLogicalRoot(partition);
  if (logicalPath !== root && !logicalPath.startsWith(root + '/')) {
    throw new Error(
      `[APPROVAL_LOCATION_MISMATCH] '${logicalPath}' is not inside the approval partition it is written as`
    );
  }
  const [channel, area, ...rest] = logicalPath
    .slice(root.length)
    .split('/')
    .filter((segment) => segment.length > 0);
  let live: string;
  if (!channel) live = LIVE_SYSTEM_COORDINATION_ROOT;
  else if (area === 'approvals.jsonl' && rest.length === 0)
    live = `${LIVE_SYSTEM_OBSERVABILITY_ROOT}/${channel}/approvals.jsonl`;
  else
    live = [
      LIVE_SYSTEM_COORDINATION_ROOT,
      channel,
      ...(area ? ['approvals', area] : []),
      ...rest,
    ].join('/');
  return path.join(pathResolver.rootDir(), live);
}

/**
 * Per-channel role confinement for tenant records: before the store role
 * touches a tenant partition, the caller (its `role` for writes, its ambient
 * identity for reads) must hold the grant the same operation needs on the
 * live system-tree path of that channel — so `slack_bridge` decides a tenant
 * record on the slack channel exactly as it would a system one, and no other.
 */
function assertCallerChannelAccess(
  access: 'read' | 'write' | 'mkdir',
  partition: ApprovalTenantPartition,
  logicalPath: string,
  role?: GovernedArtifactRole
): void {
  const live = liveSystemPathFor(partition, logicalPath);
  const decision =
    access === 'read'
      ? role
        ? withExecutionContext(role, () => validateReadPermission(live))
        : validateReadPermission(live)
      : role
        ? withExecutionContext(role, () => validateWritePermission(live, access))
        : validateWritePermission(live, access);
  if (!decision.allowed) {
    throw new Error(
      `[POLICY_VIOLATION] approval ${access} refused — the caller may not ${access === 'read' ? 'read' : 'write'} this channel's approvals | ` +
        `next: use the role that owns the channel | evidence: ${decision.reason ?? 'denied'}`
    );
  }
}

/**
 * Run `fn` as the identity that may write `partition`: the caller's `role` in
 * the system tree; in a tenant partition, after the binding and channel checks,
 * the tenant-bound store role.
 */
function asPartitionWriter<T>(
  role: GovernedArtifactRole,
  partition: ApprovalPartition,
  logicalPath: string,
  access: 'write' | 'mkdir',
  fn: () => T
): T {
  if (partition.kind === 'system') return withExecutionContext(role, fn);
  assertMayBindApprovalTenant(partition.tenant_slug);
  assertCallerChannelAccess(access, partition, logicalPath, role);
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
  assertCallerChannelAccess('read', partition, logicalPath);
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
  assertCallerChannelAccess('read', partition, logicalDir);
  return asTenantApprovalStore(partition.tenant_slug, list);
}

/** Create a directory in a location. */
export function ensureApprovalDirAt(
  role: GovernedArtifactRole,
  partition: ApprovalPartition,
  logicalDir: string
): string {
  return asPartitionWriter(role, partition, logicalDir, 'mkdir', () => {
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
  return asPartitionWriter(role, partition, logicalPath, 'write', () => {
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
  return asPartitionWriter(role, partition, logicalPath, 'write', () => {
    const resolved = prepareGovernedFile(logicalPath);
    appendJsonLine(logicalPath, value);
    return resolved;
  });
}

/**
 * Whether a file exists in a location. A tenant partition is probed as its
 * store role after the binding and per-channel read checks (`role` = the
 * caller's role; omitted = the ambient identity); a tenant this process may
 * not bind reports false.
 */
export function approvalFileExistsAt(
  role: GovernedArtifactRole | undefined,
  partition: ApprovalPartition,
  logicalPath: string
): boolean {
  const exists = (): boolean => safeExistsSync(resolveGovernedArtifactPath(logicalPath));
  if (partition.kind === 'system') return role ? withExecutionContext(role, exists) : exists();
  if (!mayBindApprovalTenant(partition.tenant_slug)) return false;
  assertCallerChannelAccess('read', partition, logicalPath, role);
  return asTenantApprovalStore(partition.tenant_slug, exists);
}

/**
 * Remove one file (a request record or a passkey challenge) in a location,
 * confined like a write: the caller's `role` in the system tree; in a tenant
 * partition, after the binding and per-channel write checks, the store role.
 * Absent files are a no-op; returns whether a file was removed.
 */
export function removeApprovalFileAt(
  role: GovernedArtifactRole,
  partition: ApprovalPartition,
  logicalPath: string
): boolean {
  return asPartitionWriter(role, partition, logicalPath, 'write', () => {
    const resolved = resolveGovernedArtifactPath(logicalPath);
    if (!safeExistsSync(resolved)) return false;
    ensureRegularGovernedArtifactFile(resolved);
    safeUnlinkSync(resolved);
    return true;
  });
}

/**
 * Read an append-only JSONL log (a channel's `approvals.jsonl`) in a location;
 * malformed lines are skipped, an absent log is empty. Confined like
 * {@link approvalFileExistsAt}.
 */
export function readApprovalJsonlAt<T = Record<string, unknown>>(
  role: GovernedArtifactRole | undefined,
  partition: ApprovalPartition,
  logicalPath: string
): T[] {
  const read = (): T[] => {
    const resolved = resolveGovernedArtifactPath(logicalPath);
    if (!safeExistsSync(resolved)) return [];
    ensureRegularGovernedArtifactFile(resolved);
    return readJsonLines<T>(resolved, { onMalformed: 'skip' });
  };
  if (partition.kind === 'system') return role ? withExecutionContext(role, read) : read();
  if (!mayBindApprovalTenant(partition.tenant_slug)) return [];
  assertCallerChannelAccess('read', partition, logicalPath, role);
  return asTenantApprovalStore(partition.tenant_slug, read);
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
    logger.warn(
      `tenant approval partitions not listed — the ${tier} tier directory is unreadable, so its tenants' approvals are invisible to this process | next: check the tenant approval root and the ${TENANT_APPROVAL_PARTITION_INDEX_READER_ROLE} grant | evidence: ${dir}: ${err instanceof Error ? err.message : String(err)}`
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

/**
 * A legacy tenant record left in the system tree is visible only to a process
 * that may bind its tenant — the same rule as its tenant partition — so a
 * process bound to tenant A never reads, lists or decides tenant B's record
 * wherever it is stored. Untenanted records are visible to everyone.
 */
export function systemRecordVisibleToThisProcess(
  record: Pick<ApprovalRequestRecord, 'scope'>
): boolean {
  const tenant = normalizedTenant(record.scope?.tenant_slug);
  return !tenant || mayBindApprovalTenant(tenant);
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
  if (system && systemRecordVisibleToThisProcess(system))
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
