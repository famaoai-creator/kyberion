import {
  approvalRequestLogicalPath,
  expireApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  type ApprovalRequestRecord,
} from './approval-store.js';
import type { GovernedArtifactRole } from './artifact-store.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync } from './secure-io.js';
import { appendRetentionAudit, softDeleteToTrash } from './storage-janitor.js';

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

export function isFixtureApproval(
  record: Pick<ApprovalRequestRecord, 'storageChannel' | 'requestedBy'> &
    Partial<Pick<ApprovalRequestRecord, 'kind' | 'target' | 'justification'>> & {
      title?: string;
      decidedBy?: string;
    }
): boolean {
  const channel = record.storageChannel || '';
  const requester = record.requestedBy || '';
  const decider = record.decidedBy || '';
  return (
    FIXTURE_TOKEN.test(channel) ||
    FIXTURE_CHANNEL_PREFIX.test(channel) ||
    FIXTURE_TOKEN.test(requester) ||
    FIXTURE_REQUESTER.test(requester) ||
    FIXTURE_TOKEN.test(decider) ||
    FIXTURE_DECIDER.test(decider) ||
    (channel === 'plugin-install' && FIXTURE_PLUGIN_TITLE.test(record.title || '')) ||
    (record.kind === 'secret_mutation' &&
      record.target?.serviceId === 'gemini' &&
      SECRET_INTRODUCTION_TEST_REASONS.has(record.justification?.reason || ''))
  );
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
 * closing it fails safe, leaving it open does not.
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
    } else if (typeof record.expiresAt !== 'string' || record.expiresAt.trim() === '') {
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
  logicalPath: string;
}

export function findFixtureApprovals(
  records: readonly ApprovalRequestRecord[]
): FixtureApprovalRecord[] {
  return records.filter(isFixtureApproval).map((record) => ({
    storageChannel: record.storageChannel,
    requestId: record.id,
    logicalPath: approvalRequestLogicalPath(record.storageChannel, record.id),
  }));
}

/**
 * Move fixture approval records to the soft-delete trash (30-day restore
 * window via `restoreFromTrash`). Runs under the caller's identity, like the
 * storage janitor: only an operator context may write `active/archive/.trash`.
 */
export function purgeFixtureApprovals(options: {
  dryRun: boolean;
  records?: readonly ApprovalRequestRecord[];
}): ApprovalSweepResult<FixtureApprovalRecord> {
  const records = options.records ?? listApprovalRequests();
  const candidates = findFixtureApprovals(records);
  const result: ApprovalSweepResult<FixtureApprovalRecord> = {
    candidates,
    applied: [],
    errors: [],
    dryRun: options.dryRun,
  };
  if (options.dryRun) return result;
  for (const candidate of candidates) {
    try {
      const absolute = pathResolver.resolve(candidate.logicalPath);
      if (!safeExistsSync(absolute)) continue;
      const { trashPath } = softDeleteToTrash(absolute);
      result.applied.push(candidate.requestId);
      appendRetentionAudit({
        event: 'APPROVAL_FIXTURE_TRASHED',
        path: candidate.logicalPath,
        trash_path: trashPath,
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
