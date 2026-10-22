/**
 * MSN-AUTONOMY-CONCEPT R5: a lightweight human confirmation card in front of
 * the existing human mission admission.
 *
 * When the watchdog sees a covered `mission_start` mandate whose autonomous
 * gate verdict is shadow, it opens ONE human-only card bound to the WorkItem id,
 * version and mandate ({@link openMissionAdmissionConfirmation}). The card is
 * not a mission admission and creates no mission. When an authenticated human
 * approves it, the next sweep hands the item to the existing preparation path
 * ({@link applyApprovedMissionAdmissionConfirmation} → `continueHumanMissionAdmission`
 * with `prepare`), which opens the real hash-bound `mission_gate` request.
 * Rejected, cancelled or expired cards never reopen for the same version, and
 * accepting a card is never mandate learning: shadow stays non-authority.
 */
import { withExecutionContext } from '@agent/core/authority';
import { createLogger } from '@agent/core/logger';
import { t } from '@agent/core/t';
import { AUTONOMY_APPROVAL_CHANNEL } from '@agent/core/governance/approval-decision-card';
import {
  approvalUsabilityRefusal,
  claimApprovalApply,
  computeApprovalPayloadHash,
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  recordApprovalApplyResult,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import type { WorkItem } from '@agent/core/workforce/work-coordination-types';
import { withLockSync } from '@agent/core/foundation/lock-utils';
import { isOperationsHalted } from '@agent/core/governance/operations-halt';
import {
  continueHumanMissionAdmission,
  type AdmissionContinuationResult,
} from './mission_admission_continuation.js';

const logger = createLogger('mission-admission-confirmation');

/** Correlation prefix of confirmation cards: `mission-admission-confirm:<work_item_id>`. */
export const MISSION_ADMISSION_CONFIRMATION_PREFIX = 'mission-admission-confirm:';
/** Approval action id a confirmation card's effect binding names. */
export const MISSION_ADMISSION_CONFIRMATION_ACTION_ID = 'mission_admission_confirmation';
/** A card nobody decides expires (never hangs). */
export const MISSION_ADMISSION_CONFIRMATION_EXPIRY_MINUTES = 72 * 60;
const ROLE = 'infrastructure_sentinel';
const APPLIER = 'daemon-watchdog';

type ConfirmationDeps = {
  rootDir?: string;
  now?: () => Date;
  /** Preparation port; defaults to the existing human admission continuation. */
  prepare?: typeof continueHumanMissionAdmission;
};

function correlationOf(item: WorkItem): string {
  return MISSION_ADMISSION_CONFIRMATION_PREFIX + item.item_id;
}

/** The confirmed effect: this item at this version under this mandate. */
function effectBindingOf(item: WorkItem, mandateId: string): string {
  return `${MISSION_ADMISSION_CONFIRMATION_ACTION_ID}:${item.item_id}@v${item.version}:${mandateId}`;
}

function cardsOf(item: WorkItem): ApprovalRequestRecord[] {
  return listApprovalRequests({ storageChannels: [AUTONOMY_APPROVAL_CHANNEL] }).filter(
    (record) => record.correlationId === correlationOf(item)
  );
}

/**
 * Open the confirmation card for a covered mandate under a shadow verdict.
 * Idempotent: any card for the same item, version and mandate — pending or
 * already decided — is returned instead of a new one.
 */
export function openMissionAdmissionConfirmation(
  item: WorkItem,
  mandateId: string,
  deps: ConfirmationDeps = {}
): { request: ApprovalRequestRecord; created: boolean } {
  // Check-then-create under one lock so overlapping sweeps open one card.
  return withLockSync(MISSION_ADMISSION_CONFIRMATION_PREFIX + item.item_id, () =>
    openConfirmationUnlocked(item, mandateId, deps)
  );
}

function openConfirmationUnlocked(
  item: WorkItem,
  mandateId: string,
  deps: ConfirmationDeps
): { request: ApprovalRequestRecord; created: boolean } {
  const tenant = item.context?.tenant_slug;
  if (!tenant) throw new Error('mission admission confirmation requires a tenant-scoped item');
  const effectBinding = effectBindingOf(item, mandateId);
  const existing = cardsOf(item).find(
    (record) => record.accountability?.effectBinding === effectBinding
  );
  if (existing) return { request: existing, created: false };
  const missionId =
    typeof item.metadata?.mission_id === 'string' ? item.metadata.mission_id : item.item_id;
  const now = deps.now?.() ?? new Date();
  const details = [
    t('dot_confirmation:card_detail_item', { item: item.item_id, version: item.version }),
    t('dot_confirmation:card_detail_scope', { tenant, mandate: mandateId }),
    t('dot_confirmation:card_detail_goal', { goal: item.description.slice(0, 300) }),
    t('dot_confirmation:card_detail_assurance'),
    t('dot_confirmation:card_detail_not_learning'),
  ].join('\n');
  const request = withExecutionContext(ROLE, () =>
    createApprovalRequest(ROLE, {
      channel: 'operator',
      storageChannel: AUTONOMY_APPROVAL_CHANNEL,
      threadTs: '',
      correlationId: correlationOf(item),
      requestedBy: APPLIER,
      draft: {
        title: t('dot_confirmation:card_title', { item: item.item_id }),
        summary: t('dot_confirmation:card_summary', { mission: missionId }),
        details,
        severity: 'medium',
      },
      kind: 'channel-approval',
      expiresAt: new Date(
        now.getTime() + MISSION_ADMISSION_CONFIRMATION_EXPIRY_MINUTES * 60_000
      ).toISOString(),
      source: { agentId: APPLIER, taskId: item.item_id },
      scope: {
        tenant_slug: tenant,
        ...(item.context?.organization_id ? { organization_id: item.context.organization_id } : {}),
        ...(item.context?.project_id ? { project_id: item.context.project_id } : {}),
        // No mission exists yet, so the item is bound via source.taskId, not scope.task_id.
      },
      justification: { reason: `mandate ${mandateId} covered; autonomous start is shadow` },
      // A human's call: never a veto window, never an agent or service.
      accountability: { finalDecision: 'human_only', effectBinding },
    })
  );
  logger.info(
    `[CONFIRM] mission admission card opened for ${item.item_id} | next: pnpm kyberion approvals --approve ${request.id} | evidence: ${request.id}`
  );
  return { request, created: true };
}

function recordConfirmationFailure(
  record: ApprovalRequestRecord,
  deps: ConfirmationDeps,
  claimId?: string
): void {
  withExecutionContext(ROLE, () =>
    recordApprovalApplyResult(ROLE, {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId: record.id,
      ...(claimId ? { claimId } : {}),
      applyResult: {
        result: 'failed',
        appliedAt: (deps.now?.() ?? new Date()).toISOString(),
        appliedBy: APPLIER,
      },
    })
  );
}

/** Why an approved card must not take effect, or undefined when it may. */
function confirmationRefusal(record: ApprovalRequestRecord, item: WorkItem): string | undefined {
  if (record.decidedByType !== 'human' || record.authenticated !== true)
    return 'not decided by an authenticated human';
  if (record.veto || record.accountability?.finalDecision !== 'human_only')
    return 'not a human-only decision';
  // Under warn-mode assurance a shortfall decision is recorded as approved, but the
  // later mission approval refuses it; never begin an admission that must stall.
  if (record.assuranceShortfall) return 'decision has an assurance shortfall (A1+ required)';
  const sodRefusal = approvalUsabilityRefusal(record, MISSION_ADMISSION_CONFIRMATION_ACTION_ID);
  if (sodRefusal) return sodRefusal;
  if (
    record.expiresAt &&
    (!record.decidedAt || Date.parse(record.decidedAt) > Date.parse(record.expiresAt))
  )
    return 'decided after the card expired';
  if ((record.scope?.tenant_slug || undefined) !== (item.context?.tenant_slug || undefined))
    return 'card tenant differs from the WorkItem tenant';
  return undefined;
}

/**
 * Apply an approved, unapplied card for this item and mandate by entering the
 * existing preparation path exactly once. Returns undefined when no approved
 * card awaits application (pending, rejected, expired, cancelled or settled).
 */
export async function applyApprovedMissionAdmissionConfirmation(
  item: WorkItem,
  mandateId: string,
  deps: ConfirmationDeps = {}
): Promise<AdmissionContinuationResult | { status: 'refused'; reason: string } | undefined> {
  const effectBinding = effectBindingOf(item, mandateId);
  const record = cardsOf(item).find(
    (row) =>
      row.status === 'approved' &&
      !row.applyResult &&
      !row.applyClaim &&
      row.accountability?.effectBinding === effectBinding
  );
  if (!record) return undefined;
  const refusal = confirmationRefusal(record, item);
  if (refusal) {
    logger.warn(
      `[CONFIRM] mission admission card ${record.id} refused — ${refusal} | next: the item stays held; a changed item gets a new card | evidence: ${item.item_id}`
    );
    recordConfirmationFailure(record, deps);
    return { status: 'refused', reason: refusal };
  }
  // A temporary halt must not consume the human's approval: leave the card
  // unclaimed so the next sweep after the halt applies it.
  if (isOperationsHalted()) return undefined;
  // Approved in time but expired before a sweep reached it: the claim would
  // refuse on every sweep, so settle it once and ask for a fresh request.
  if (isApprovalRequestExpired(record)) {
    logger.warn(
      `[CONFIRM] mission admission card ${record.id} expired before it could be applied | next: node dist/scripts/mission_alignment_request.js --work-item ${item.item_id} | evidence: ${item.item_id}`
    );
    recordConfirmationFailure(record, deps);
    return { status: 'refused', reason: 'card expired before it could be applied' };
  }
  const claimed = withExecutionContext(ROLE, () =>
    claimApprovalApply(ROLE, {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId: record.id,
      appliedBy: APPLIER,
      expectedRecordHash: computeApprovalPayloadHash({ record }),
    })
  );
  let continuation: AdmissionContinuationResult;
  try {
    continuation = await (deps.prepare ?? continueHumanMissionAdmission)(item.item_id, {
      ...(deps.rootDir ? { rootDir: deps.rootDir } : {}),
      ...(deps.now ? { now: deps.now } : {}),
      prepare: true,
      expectedVersion: item.version,
    });
  } catch (error) {
    // Settle the claim so the card is never left half-applied and silent.
    recordConfirmationFailure(record, deps, claimed.applyClaim.claimId);
    throw error;
  }
  const ok = ['pending_approval', 'approved', 'completed'].includes(continuation.status);
  withExecutionContext(ROLE, () =>
    recordApprovalApplyResult(ROLE, {
      channel: record.channel,
      storageChannel: record.storageChannel,
      requestId: record.id,
      claimId: claimed.applyClaim.claimId,
      applyResult: {
        result: ok ? 'success' : 'failed',
        appliedAt: (deps.now?.() ?? new Date()).toISOString(),
        appliedBy: APPLIER,
        ...(continuation.requestId ? { auditRef: 'approval:' + continuation.requestId } : {}),
      },
    })
  );
  if (!ok)
    logger.warn(
      `[CONFIRM] confirmed admission did not prepare — ${continuation.reason ?? continuation.status} | next: inspect the work item; request explicit alignment if still wanted | evidence: ${item.item_id}`
    );
  return continuation;
}
