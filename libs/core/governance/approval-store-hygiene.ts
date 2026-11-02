import {
  expireApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from './approval-store.js';
import {
  readGovernedArtifactJson,
  resolveGovernedArtifactPath,
  type GovernedArtifactRole,
} from '../workforce/artifact-store.js';
import { resolveIdentityContext, withExecutionContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeUnlinkSync } from '../secure-io.js';
import { approvalRequestLogicalPath, approvalStoreRoots } from './approval-store-paths.js';
import {
  approvalPartitionForScope,
  approvalPasskeyChallengesLogicalDirAt,
  approvalRequestLogicalPathAt,
  approvalFileExistsAtCurrentIdentity,
  approvalRequestsLogicalDirAt,
  listApprovalDirAt,
  listApprovalPartitions,
  mayBindApprovalTenant,
  readApprovalJsonAt,
  removeApprovalFileAt,
  SYSTEM_APPROVAL_PARTITION,
  TENANT_ACTIVATION_REQUEST_KIND,
  TENANT_ACTIVATION_STORAGE_CHANNEL,
  tenantApprovalPartitionLogicalRoot,
  writeApprovalJsonAt,
  writeLocatedApprovalRequest,
  type ApprovalPartition,
  type ApprovalTenantPartition,
} from './approval-store-location.js';
import { withApprovalRecordLock } from './approval-apply-claim.js';
import { withApprovalPasskeyChallengeLock } from './approval-passkey-challenge.js';
import { auditChain } from './audit-chain.js';
import { isTenantActivationActive } from '../organization/tenant-activation.js';
import { appendRetentionAudit, softDeleteToTrash, TRASH_REPO_SUBPATH } from '../storage-janitor.js';
import { validateWritePermission } from '../tier-guard.js';

/**
 * Autonomous-operation P1-2 / P1-4: keep the live approval store limited to
 * real, still-actionable decisions. Two sweeps share one fixture vocabulary
 * with the human-intervention census (scripts/report_human_interventions.ts):
 *
 *  - pending requests past `expiresAt`, or pending with no expiry for longer
 *    than the stale threshold, move to `expired` through the store's own
 *    transition (event logged), so nothing waits on a human forever;
 *  - records left behind by test runs (before approvalStoreRoots isolated
 *    them) move to `active/archive/.trash/` — restorable, never hard-deleted.
 *    Only the request records move; their lines in the append-only
 *    `approvals.jsonl` event logs stay as history;
 *  - passkey challenges (HA-07) past their expiry are deleted: each is single
 *    use and dead once expired, and the decision it settled keeps its id in
 *    the event log;
 *  - tenant-scoped records written to the system tree before the per-tenant
 *    partitions existed (approval-store-location.ts) are reported, and moved
 *    into their tenant's partition on request.
 *
 * Every sweep covers the system tree and the tenant partitions this process
 * may bind (all of them for an unbound operator process).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Pending requests without `expiresAt` older than this are treated as abandoned. */
export const DEFAULT_STALE_PENDING_APPROVAL_MS = 14 * DAY_MS;

const FIXTURE_TOKEN = /(?:^|[-_:/.\s])(?:tests?|fixtures?)(?:$|[-_:/.\s])/i;
const FIXTURE_CHANNEL_PREFIX = /^qm\d+-/i;
const FIXTURE_REQUESTER = /^human:alice$/i;
// `U123` is the placeholder Slack user the surface suites decide with.
const FIXTURE_DECIDER = /^U123$/;
// Plugin-install suites name throwaway plugins `<label>-<pid>[-<uuid8>...]` and
// file them as `plugin-installer`, so the requester alone cannot tell them apart.
const FIXTURE_PLUGIN_TITLE = /fixture|-\d{3,6}-[0-9a-f]{8}|-\d{5,6}$/i;
// secret-introduction.test.ts filed these as a plain `operator` on `terminal`,
// so only its exact gemini/reason signature identifies the leftovers.
const SECRET_INTRODUCTION_TEST_REASONS = new Set([
  'Enable Gemini media ops',
  'test apply',
  'pending apply',
]);

type FixtureCandidate = Pick<ApprovalRequestRecord, 'storageChannel' | 'requestedBy'> &
  Partial<Pick<ApprovalRequestRecord, 'kind' | 'target' | 'justification'>> & {
    title?: string;
    decidedBy?: string;
  };

/** Name of the first fixture rule the record matches, or null for a real record. */
export function fixtureApprovalRule(record: FixtureCandidate): string | null {
  const channel = record.storageChannel || '';
  const requester = record.requestedBy || '';
  const decider = record.decidedBy || '';
  if (FIXTURE_TOKEN.test(channel)) return 'channel_token';
  if (FIXTURE_CHANNEL_PREFIX.test(channel)) return 'channel_qm_prefix';
  if (FIXTURE_TOKEN.test(requester)) return 'requester_token';
  if (FIXTURE_REQUESTER.test(requester)) return 'requester_alice';
  if (FIXTURE_TOKEN.test(decider)) return 'decider_token';
  if (FIXTURE_DECIDER.test(decider)) return 'decider_u123';
  if (channel === 'plugin-install' && FIXTURE_PLUGIN_TITLE.test(record.title || '')) {
    return 'plugin_title';
  }
  if (
    record.kind === 'secret_mutation' &&
    record.target?.serviceId === 'gemini' &&
    SECRET_INTRODUCTION_TEST_REASONS.has(record.justification?.reason || '')
  ) {
    return 'secret_introduction_test';
  }
  return null;
}

export function isFixtureApproval(record: FixtureCandidate): boolean {
  return fixtureApprovalRule(record) !== null;
}

export type PendingExpiryReason = 'expires_at_passed' | 'stale_pending';

export interface ExpirablePendingApproval {
  storageChannel: string;
  channel: string;
  requestId: string;
  requestedAt: string;
  reason: PendingExpiryReason;
}

/**
 * Pure selection of pending requests that should expire. Fixture records are
 * left to the fixture purge so the expiry event log only carries real work.
 * An unparseable `requestedAt` on a request with no expiry counts as stale:
 * closing it fails safe, leaving it open does not. Requests owned by a
 * suspended pipeline are never stale-expired: the pipeline's own
 * `timeout_at` / `on_timeout` decides what a lapse means for them.
 */
export function findExpirablePendingApprovals(
  records: readonly ApprovalRequestRecord[],
  options: { now?: number; staleAfterMs?: number } = {}
): ExpirablePendingApproval[] {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_PENDING_APPROVAL_MS;
  const selected: ExpirablePendingApproval[] = [];
  for (const record of records) {
    if (record.status !== 'pending' || isFixtureApproval(record)) continue;
    let reason: PendingExpiryReason | null = null;
    if (isApprovalRequestExpired(record, now)) {
      reason = 'expires_at_passed';
    } else if (
      !record.requestedByContext?.pipelineRunId &&
      (typeof record.expiresAt !== 'string' || record.expiresAt.trim() === '')
    ) {
      const requestedAt = Date.parse(record.requestedAt);
      if (!Number.isFinite(requestedAt) || now - requestedAt > staleAfterMs) {
        reason = 'stale_pending';
      }
    }
    if (!reason) continue;
    selected.push({
      storageChannel: record.storageChannel,
      channel: record.channel,
      requestId: record.id,
      requestedAt: record.requestedAt,
      reason,
    });
  }
  return selected;
}

export interface ApprovalSweepResult<T> {
  candidates: T[];
  applied: string[];
  errors: string[];
  dryRun: boolean;
}

export function sweepExpirablePendingApprovals(options: {
  dryRun: boolean;
  role?: GovernedArtifactRole;
  now?: number;
  staleAfterMs?: number;
  records?: readonly ApprovalRequestRecord[];
}): ApprovalSweepResult<ExpirablePendingApproval> {
  const records = options.records ?? listApprovalRequests({ status: 'pending' });
  const candidates = findExpirablePendingApprovals(records, options);
  const result: ApprovalSweepResult<ExpirablePendingApproval> = {
    candidates,
    applied: [],
    errors: [],
    dryRun: options.dryRun,
  };
  if (options.dryRun) return result;
  for (const candidate of candidates) {
    try {
      const updated = expireApprovalRequest(options.role ?? 'infrastructure_sentinel', {
        channel: candidate.channel,
        storageChannel: candidate.storageChannel,
        requestId: candidate.requestId,
        reason: candidate.reason,
      });
      if (updated.status === 'expired') result.applied.push(candidate.requestId);
    } catch (err) {
      result.errors.push(
        `${candidate.storageChannel}/${candidate.requestId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return result;
}

export interface FixtureApprovalRecord {
  storageChannel: string;
  requestId: string;
  /** Where the record lives (system tree unless found in its tenant partition). */
  partition: ApprovalPartition;
  logicalPath: string;
  title: string;
  requestedBy: string;
  status: ApprovalRequestRecord['status'];
  rule: string;
}

export function findFixtureApprovals(
  records: readonly ApprovalRequestRecord[]
): FixtureApprovalRecord[] {
  const selected: FixtureApprovalRecord[] = [];
  for (const record of records) {
    const rule = fixtureApprovalRule(record);
    if (!rule) continue;
    selected.push({
      storageChannel: record.storageChannel,
      requestId: record.id,
      partition: SYSTEM_APPROVAL_PARTITION,
      logicalPath: approvalRequestLogicalPath(record.storageChannel, record.id),
      title: record.title,
      requestedBy: record.requestedBy,
      status: record.status,
      rule,
    });
  }
  return selected;
}

/**
 * Where a listed record lives: its scope's tenant partition when the record is
 * there, otherwise the system tree (untenanted, pre-activation, or a legacy
 * tenant record not yet moved). Probes only the one partition the scope names.
 */
export function approvalRecordPartition(
  record: Pick<ApprovalRequestRecord, 'id' | 'storageChannel' | 'scope'>
): ApprovalPartition {
  const expected = approvalPartitionForScope(record.scope, { tenantActive: true });
  if (expected.kind === 'system') return SYSTEM_APPROVAL_PARTITION;
  try {
    const found = readApprovalJsonAt<ApprovalRequestRecord>(
      expected,
      approvalRequestLogicalPathAt(expected, record.storageChannel, record.id)
    );
    return found ? expected : SYSTEM_APPROVAL_PARTITION;
  } catch {
    return SYSTEM_APPROVAL_PARTITION;
  }
}

/** Point fixture candidates at the location each record actually lives in. */
function locateFixtureCandidates(
  candidates: readonly FixtureApprovalRecord[],
  records: readonly ApprovalRequestRecord[]
): FixtureApprovalRecord[] {
  const byKey = new Map(records.map((record) => [`${record.storageChannel}/${record.id}`, record]));
  return candidates.map((candidate) => {
    const record = byKey.get(`${candidate.storageChannel}/${candidate.requestId}`);
    const partition = record ? approvalRecordPartition(record) : SYSTEM_APPROVAL_PARTITION;
    if (partition.kind === 'system') return candidate;
    return {
      ...candidate,
      partition,
      logicalPath: approvalRequestLogicalPathAt(
        partition,
        candidate.storageChannel,
        candidate.requestId
      ),
    };
  });
}

/** How an operator shell gains the only persona allowed to write the trash. */
export const APPROVAL_TRASH_PERSONA_ENV = 'KYBERION_PERSONA=sovereign';

/**
 * Whether the current identity may move `logicalPath` into the soft-delete
 * trash. Checked once up front so a missing persona fails with one actionable
 * message instead of one policy violation per record.
 */
export function checkApprovalTrashWritable(logicalPath: string): {
  allowed: boolean;
  reason?: string;
} {
  return validateWritePermission(pathResolver.resolve(`${TRASH_REPO_SUBPATH}/${logicalPath}`));
}

/**
 * Move fixture approval records to the soft-delete trash (30-day restore
 * window via `restoreFromTrash`). Runs under the caller's identity, like the
 * storage janitor: only the sovereign persona may write `active/archive/.trash`.
 */
export function purgeFixtureApprovals(options: {
  dryRun: boolean;
  records?: readonly ApprovalRequestRecord[];
}): ApprovalSweepResult<FixtureApprovalRecord> {
  const records = options.records ?? listApprovalRequests();
  const candidates = locateFixtureCandidates(findFixtureApprovals(records), records);
  const result: ApprovalSweepResult<FixtureApprovalRecord> = {
    candidates,
    applied: [],
    errors: [],
    dryRun: options.dryRun,
  };
  if (options.dryRun || candidates.length === 0) return result;
  const access = checkApprovalTrashWritable(candidates[0].logicalPath);
  if (!access.allowed) {
    result.errors.push(
      `trash not writable; rerun with ${APPROVAL_TRASH_PERSONA_ENV}: ${access.reason ?? 'denied'}`
    );
    return result;
  }
  for (const candidate of candidates) {
    try {
      const absolute = pathResolver.resolve(candidate.logicalPath);
      // A tenant partition file is probed as that tenant's store role
      // (approval-store-location.ts; an unbound caller may bind any tenant, a
      // bound one only its own; reads are not role-confined). The
      // trash move itself runs as the sovereign caller, as offboarding does.
      if (
        candidate.partition.kind === 'tenant' &&
        !mayBindApprovalTenant(candidate.partition.tenant_slug)
      ) {
        continue;
      }
      if (!approvalFileExistsAtCurrentIdentity(candidate.partition, candidate.logicalPath))
        continue;
      const { trashPath } = softDeleteToTrash(absolute);
      result.applied.push(candidate.requestId);
      appendRetentionAudit({
        event: 'APPROVAL_FIXTURE_TRASHED',
        path: candidate.logicalPath,
        trash_path: trashPath,
        fixture_rule: candidate.rule,
        reason: 'test-fixture approval record in the live approval store',
      });
    } catch (err) {
      result.errors.push(
        `${candidate.storageChannel}/${candidate.requestId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return result;
}

/** Expired passkey challenges are kept this long (for incident review) before removal. */
export const PASSKEY_CHALLENGE_RETENTION_MS = 60 * 60 * 1000;

const PASSKEY_CHALLENGE_FILE = /^[0-9a-f-]{36}\.json$/u;

export interface ExpiredPasskeyChallenge {
  storageChannel: string;
  /** System tree or the tenant partition the challenge file lives in. */
  partition: ApprovalPartition;
  logicalPath: string;
  /** The challenge's expiry, or null when the file is unreadable (removed too). */
  expiresAt: string | null;
}

/** Channel directory names under a location's root (system: coordination channels). */
function listPartitionChannelDirs(partition: ApprovalPartition): string[] {
  const root =
    partition.kind === 'system'
      ? approvalStoreRoots().coordination
      : tenantApprovalPartitionLogicalRoot(partition);
  try {
    return listApprovalDirAt(partition, root);
  } catch {
    return [];
  }
}

/**
 * Challenge files whose expiry (plus the retention grace) has passed, in the
 * system tree and every tenant partition this process may bind.
 */
export function findExpiredPasskeyChallenges(
  options: { now?: number; retainMs?: number } = {}
): ExpiredPasskeyChallenge[] {
  const now = options.now ?? Date.now();
  const retainMs = options.retainMs ?? PASSKEY_CHALLENGE_RETENTION_MS;
  const selected: ExpiredPasskeyChallenge[] = [];
  const partitions: ApprovalPartition[] = [SYSTEM_APPROVAL_PARTITION, ...listApprovalPartitions()];
  for (const partition of partitions) {
    for (const storageChannel of listPartitionChannelDirs(partition)) {
      let dir: string;
      let files: string[];
      try {
        dir = approvalPasskeyChallengesLogicalDirAt(partition, storageChannel);
        files = listApprovalDirAt(partition, dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!PASSKEY_CHALLENGE_FILE.test(file)) continue;
        const logicalPath = `${dir}/${file}`;
        let expiresAt: string | null = null;
        try {
          const value = readApprovalJsonAt<{ expires_at?: unknown }>(partition, logicalPath);
          expiresAt = typeof value?.expires_at === 'string' ? value.expires_at : null;
        } catch {
          expiresAt = null;
        }
        const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
        if (Number.isFinite(expiry) && expiry + retainMs > now) continue;
        selected.push({ storageChannel, partition, logicalPath, expiresAt });
      }
    }
  }
  return selected;
}

export function sweepExpiredPasskeyChallenges(options: {
  dryRun: boolean;
  role?: GovernedArtifactRole;
  now?: number;
  retainMs?: number;
}): ApprovalSweepResult<ExpiredPasskeyChallenge> {
  const candidates = findExpiredPasskeyChallenges(options);
  const result: ApprovalSweepResult<ExpiredPasskeyChallenge> = {
    candidates,
    applied: [],
    errors: [],
    dryRun: options.dryRun,
  };
  if (options.dryRun) return result;
  const role = options.role ?? 'infrastructure_sentinel';
  withExecutionContext(role, () => {
    for (const candidate of candidates) {
      try {
        // Confined like any approval write: the role's own channel grant, then
        // (tenant partition) the tenant-bound store role.
        removeApprovalFileAt(role, candidate.partition, candidate.logicalPath);
        result.applied.push(candidate.logicalPath);
      } catch (err) {
        result.errors.push(
          `${candidate.logicalPath}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  });
  return result;
}

// ---------------------------------------------------------------------------
// Tenant-partition migration of legacy system-tree records
// ---------------------------------------------------------------------------

/**
 * A tenant-scoped record still in the system tree that belongs in a tenant
 * partition (written before the partitions existed).
 */
export interface LegacyTenantApprovalRecord {
  storageChannel: string;
  requestId: string;
  status: ApprovalRequestRecord['status'];
  from: string;
  to: string;
  partition: ApprovalTenantPartition;
}

/**
 * Whether the tenant named by a tenant-activation request is already active
 * (the same rule approval creation uses: organization/tenant-activation.ts
 * isTenantActivationActive on the request's activation command). A request
 * whose command cannot be read counts as not active, so it stays in the
 * system tree.
 */
export function isActivationRequestTenantActive(
  record: Pick<ApprovalRequestRecord, 'sourceText'>
): boolean {
  try {
    const payload = JSON.parse(record.sourceText || '') as {
      command?: {
        customerSlug?: unknown;
        tenantSlug?: unknown;
        organizationId?: unknown;
        tier?: unknown;
      };
    };
    const command = payload?.command;
    if (
      typeof command?.customerSlug !== 'string' ||
      typeof command.tenantSlug !== 'string' ||
      typeof command.organizationId !== 'string'
    ) {
      return false;
    }
    const tier =
      command.tier === 'personal' || command.tier === 'confidential' || command.tier === 'public'
        ? command.tier
        : undefined;
    return isTenantActivationActive({
      customerSlug: command.customerSlug,
      tenantSlug: command.tenantSlug,
      organizationId: command.organizationId,
      ...(tier ? { tier } : {}),
    });
  } catch {
    return false;
  }
}

/**
 * Pure selection: system-tree records whose scope maps them to a tenant
 * partition. A tenant-activation request moves only once its tenant is active
 * (`isTenantActive`, default {@link isActivationRequestTenantActive}).
 */
export function findLegacyTenantApprovals(
  records: readonly ApprovalRequestRecord[],
  options: { isTenantActive?: (record: ApprovalRequestRecord) => boolean } = {}
): LegacyTenantApprovalRecord[] {
  const isTenantActive = options.isTenantActive ?? isActivationRequestTenantActive;
  const selected: LegacyTenantApprovalRecord[] = [];
  for (const record of records) {
    if (!record.scope?.tenant_slug) continue;
    const activation =
      record.storageChannel === TENANT_ACTIVATION_STORAGE_CHANNEL &&
      record.kind === TENANT_ACTIVATION_REQUEST_KIND;
    const partition = approvalPartitionForScope(record.scope, {
      storageChannel: record.storageChannel,
      kind: record.kind,
      tenantActive: activation ? isTenantActive(record) : true,
    });
    if (partition.kind !== 'tenant') continue;
    selected.push({
      storageChannel: record.storageChannel,
      requestId: record.id,
      status: record.status,
      from: approvalRequestLogicalPath(record.storageChannel, record.id),
      to: approvalRequestLogicalPathAt(partition, record.storageChannel, record.id),
      partition,
    });
  }
  return selected;
}

/**
 * Records in the system tree only (the tree legacy tenant records were
 * written to). A tenant record is listed only to a process that may bind its
 * tenant, so a tenant-bound process never sees another tenant's ids.
 */
export function listSystemTreeApprovalRequests(): ApprovalRequestRecord[] {
  const records: ApprovalRequestRecord[] = [];
  for (const storageChannel of listPartitionChannelDirs(SYSTEM_APPROVAL_PARTITION)) {
    let dir: string;
    try {
      dir = approvalRequestsLogicalDirAt(SYSTEM_APPROVAL_PARTITION, storageChannel);
    } catch {
      continue;
    }
    for (const entry of listApprovalDirAt(SYSTEM_APPROVAL_PARTITION, dir)) {
      if (!entry.endsWith('.json')) continue;
      try {
        const record = readGovernedArtifactJson<ApprovalRequestRecord>(`${dir}/${entry}`);
        if (!record) continue;
        const tenant = record.scope?.tenant_slug?.trim().toLowerCase();
        if (tenant && !mayBindApprovalTenant(tenant)) continue;
        records.push(record);
      } catch {
        // Unreadable or malformed files are left for an operator.
      }
    }
  }
  return records;
}

/** Order-independent JSON form, so a re-run recognises an identical copy. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
      )
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export type TenantPartitionMigrationOutcome = 'moved' | 'already_moved' | 'removed_duplicate';

/**
 * Move one legacy record into its tenant partition, under the record lock:
 * write the partition copy (fsync), read it back, remove the system copy,
 * audit. Idempotent — a record already gone from the system tree is
 * `already_moved`, an identical partition copy just has the system copy
 * removed — and refuses `[APPROVAL_MIGRATION_CONFLICT]` when the partition
 * holds the id with different content. Event-log lines stay where they are.
 */
export function migrateLegacyTenantApproval(
  role: GovernedArtifactRole,
  candidate: Pick<LegacyTenantApprovalRecord, 'storageChannel' | 'requestId' | 'partition'>
): TenantPartitionMigrationOutcome {
  const { storageChannel, requestId, partition } = candidate;
  if (!mayBindApprovalTenant(partition.tenant_slug)) {
    throw new Error(
      `[APPROVAL_TENANT_BINDING_CONFLICT] this process is bound to another tenant than ${storageChannel}/${requestId} | ` +
        'next: run the migration from an unbound operator process'
    );
  }
  return withApprovalRecordLock(role, { channel: storageChannel, requestId }, () => {
    const from = approvalRequestLogicalPath(storageChannel, requestId);
    const to = approvalRequestLogicalPathAt(partition, storageChannel, requestId);
    const system = readApprovalJsonAt<ApprovalRequestRecord>(SYSTEM_APPROVAL_PARTITION, from);
    if (!system) return 'already_moved';
    const existing = readApprovalJsonAt<ApprovalRequestRecord>(partition, to);
    let outcome: TenantPartitionMigrationOutcome = 'moved';
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(system)) {
        throw new Error(
          `[APPROVAL_MIGRATION_CONFLICT] the ${partition.tier} tenant partition already holds ${storageChannel}/${requestId} with different content | ` +
            'next: compare both copies, keep one and remove the other; nothing was changed | ' +
            `evidence: ${from}`
        );
      }
      outcome = 'removed_duplicate';
    } else {
      writeLocatedApprovalRequest(role, { partition, storageChannel }, system, { fsync: true });
      const readBack = readApprovalJsonAt<ApprovalRequestRecord>(partition, to);
      if (!readBack || canonicalJson(readBack) !== canonicalJson(system)) {
        throw new Error(
          `[APPROVAL_MIGRATION_READBACK_FAILED] the partition copy of ${storageChannel}/${requestId} does not read back as written | ` +
            'next: inspect the partition copy; the system copy was kept | ' +
            `evidence: ${to}`
        );
      }
    }
    // The request's passkey challenges live beside it: move them in the same
    // locked step, before the system copy of the request goes away.
    const challenges = migrateLegacyPasskeyChallenges(role, partition, storageChannel, requestId);
    withExecutionContext(role, () => {
      const absolute = resolveGovernedArtifactPath(from);
      if (safeExistsSync(absolute)) safeUnlinkSync(absolute);
    });
    auditChain.record({
      agentId: 'approval-store-hygiene',
      action: 'approval_store_hygiene',
      operation: 'migrate_tenant_partition',
      result: 'completed',
      reason: 'tenant-scoped approval moved from the system tree into its tenant partition',
      metadata: {
        request_id: requestId,
        storage_channel: storageChannel,
        partition_tier: partition.tier,
        outcome,
        passkey_challenges_moved: challenges,
      },
    });
    return outcome;
  });
}

/**
 * Move the system-tree passkey challenges bound to `requestId` into the
 * partition (caller holds the record lock; each challenge also under its own
 * lock). Idempotent: an identical partition copy only has the system copy
 * removed; a different one refuses `[APPROVAL_MIGRATION_CONFLICT]` before the
 * request's system copy is removed. Each copy is read back before the system
 * copy is deleted. Returns how many were moved or de-duplicated.
 */
function migrateLegacyPasskeyChallenges(
  role: GovernedArtifactRole,
  partition: ApprovalTenantPartition,
  storageChannel: string,
  requestId: string
): number {
  const fromDir = approvalPasskeyChallengesLogicalDirAt(SYSTEM_APPROVAL_PARTITION, storageChannel);
  const toDir = approvalPasskeyChallengesLogicalDirAt(partition, storageChannel);
  let moved = 0;
  for (const entry of listApprovalDirAt(SYSTEM_APPROVAL_PARTITION, fromDir)) {
    if (!entry.endsWith('.json')) continue;
    const challengeId = entry.slice(0, -'.json'.length);
    const from = `${fromDir}/${entry}`;
    const to = `${toDir}/${entry}`;
    let bound: boolean;
    try {
      const probe = readApprovalJsonAt<{ request_id?: unknown }>(SYSTEM_APPROVAL_PARTITION, from);
      bound = probe?.request_id === requestId;
    } catch {
      continue; // an unreadable challenge is not this request's to move
    }
    if (!bound) continue;
    withApprovalPasskeyChallengeLock(storageChannel, challengeId, () => {
      const system = readApprovalJsonAt<Record<string, unknown>>(SYSTEM_APPROVAL_PARTITION, from);
      if (!system) return;
      const existing = readApprovalJsonAt<Record<string, unknown>>(partition, to);
      if (existing && canonicalJson(existing) !== canonicalJson(system)) {
        throw new Error(
          `[APPROVAL_MIGRATION_CONFLICT] the ${partition.tier} tenant partition already holds passkey challenge ${storageChannel}/${challengeId} with different content | ` +
            'next: compare both copies, keep one and remove the other; the request was not moved out of the system tree | ' +
            `evidence: ${from}`
        );
      }
      if (!existing) {
        writeApprovalJsonAt(role, partition, to, system, { fsync: true });
        const readBack = readApprovalJsonAt<Record<string, unknown>>(partition, to);
        if (!readBack || canonicalJson(readBack) !== canonicalJson(system)) {
          throw new Error(
            `[APPROVAL_MIGRATION_READBACK_FAILED] the partition copy of passkey challenge ${storageChannel}/${challengeId} does not read back as written | ` +
              'next: inspect the partition copy; the system copies were kept | ' +
              `evidence: ${to}`
          );
        }
      }
      removeApprovalFileAt(role, SYSTEM_APPROVAL_PARTITION, from);
      moved += 1;
    });
  }
  return moved;
}

export interface TenantPartitionMigrationResult extends ApprovalSweepResult<LegacyTenantApprovalRecord> {
  outcomes: Record<string, TenantPartitionMigrationOutcome>;
}

/**
 * Report (dry run) or move (apply) every legacy tenant record in the system
 * tree this process may bind. Old `approvals.jsonl` lines stay as history.
 */
export function migrateTenantApprovalPartitions(options: {
  dryRun: boolean;
  role?: GovernedArtifactRole;
  records?: readonly ApprovalRequestRecord[];
  isTenantActive?: (record: ApprovalRequestRecord) => boolean;
}): TenantPartitionMigrationResult {
  const role = options.role ?? 'infrastructure_sentinel';
  // Keep the caller's tenant binding inside the assumed role (as
  // withApprovalRecordLock does): a binding that comes only from the execution
  // scope must still hide other tenants' legacy records.
  const callerTenant = resolveIdentityContext().tenantSlug || undefined;
  const records =
    options.records ??
    withExecutionContext(role, listSystemTreeApprovalRequests, undefined, callerTenant);
  const candidates = findLegacyTenantApprovals(records, {
    ...(options.isTenantActive ? { isTenantActive: options.isTenantActive } : {}),
  });
  const result: TenantPartitionMigrationResult = {
    candidates,
    applied: [],
    errors: [],
    dryRun: options.dryRun,
    outcomes: {},
  };
  if (options.dryRun) return result;
  for (const candidate of candidates) {
    try {
      const outcome = migrateLegacyTenantApproval(role, candidate);
      result.outcomes[candidate.requestId] = outcome;
      if (outcome !== 'already_moved') result.applied.push(candidate.requestId);
    } catch (err) {
      result.errors.push(
        `${candidate.storageChannel}/${candidate.requestId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return result;
}
