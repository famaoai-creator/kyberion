/**
 * Dot executor quarantine release (split from `dot-executor.ts`).
 *
 * `pnpm kyberion dot release` asks for a human-only approval
 * ({@link requestDotWorkItemRelease}); the executor sweep applies only
 * authenticated human approvals of an unchanged item
 * ({@link applyApprovedDotReleases}). `dot-executor.ts` re-exports the public
 * names; this module never imports it (no runtime cycle).
 */

import { withExecutionContext } from '../authority.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import {
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  recordApprovalApplyResult,
  type ApprovalApplyResult,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { auditChain } from '../governance/audit-chain.js';
import { createLogger } from '../logger.js';
import { getWorkItem, updateWorkItem } from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';
import {
  GOVERNED_STORE_ROLE,
  activeTerminalResult,
  actorOf,
  addressedTo,
  bounded,
  dotItemTenantMismatch,
  hasUncertainAttempt,
  meta,
  nowOf,
  recordAudit,
  terminalWorkResults,
  type DotExecutorDeps,
  type DotOperatorVerification,
} from './dot-executor-reports.js';
import type { DotWorkResultRow } from './dot-state-paths.js';

const logger = createLogger('dot-executor');

/** Audit-chain operation of a human-approved release (requested by `pnpm kyberion dot release`). */
export const DOT_OPERATOR_RELEASE_OPERATION = 'dot_work_item_operator_release';

/** Approval action id of a dot WorkItem release request (`pnpm kyberion dot release`). */
export const DOT_RELEASE_ACTION_ID = 'dot_work_item_release';
/** Correlation prefix of release requests: `dot-release:<dot_id>:<work_item_id>`. */
export const DOT_RELEASE_CORRELATION_PREFIX = 'dot-release:';
/** A release request nobody decides expires (never hangs). */
export const DOT_RELEASE_EXPIRY_MINUTES = 72 * 60;

export interface RequestDotWorkItemReleaseInput {
  workItemId: string;
  /** What the requester verified about the item's effects. Required; shown to the approver. */
  reason: string;
  /** Requester label shown on the approval request. Never recorded as the verifier. */
  by?: string;
}

/** Approval-store ports of the release flow; default to the governed approval store. */
export interface DotReleaseApprovalPorts {
  getItem?: (itemId: string) => WorkItem | null;
  createApproval?: (params: Parameters<typeof createApprovalRequest>[1]) => ApprovalRequestRecord;
  listApprovals?: (params: Parameters<typeof listApprovalRequests>[0]) => ApprovalRequestRecord[];
  markApplied?: (
    record: ApprovalRequestRecord,
    applyResult: ApprovalApplyResult
  ) => ApprovalRequestRecord;
}

export interface RequestDotWorkItemReleaseDeps
  extends Pick<DotExecutorDeps, 'rootDir' | 'now' | 'resultsCache'>, DotReleaseApprovalPorts {}

export interface DotReleaseRequestResult {
  request: ApprovalRequestRecord;
  /** True when a pending request for the same item was returned instead of a new one. */
  reused: boolean;
}

function releaseCorrelationId(dotId: string, itemId: string): string {
  return `${DOT_RELEASE_CORRELATION_PREFIX}${dotId}:${itemId}`;
}

/** The approved effect: this item at this version (any change since the request voids it). */
function releaseEffectBinding(dotId: string, item: WorkItem): string {
  return `${DOT_RELEASE_ACTION_ID}:${dotId}:${item.item_id}@v${item.version}`;
}

function parseReleaseCorrelation(
  correlationId: string
): { dotId: string; itemId: string } | undefined {
  if (!correlationId.startsWith(DOT_RELEASE_CORRELATION_PREFIX)) return undefined;
  const rest = correlationId.slice(DOT_RELEASE_CORRELATION_PREFIX.length);
  const split = rest.indexOf(':'); // dot ids never contain ':' (charter schema)
  if (split <= 0 || split === rest.length - 1) return undefined;
  return { dotId: rest.slice(0, split), itemId: rest.slice(split + 1) };
}

/** Throws unless `item` is a quarantined/escalated, unleased, open item of this dot and tenant. */
function assertReleasable(
  c: DotCharter,
  item: WorkItem,
  deps: Pick<DotExecutorDeps, 'rootDir' | 'resultsCache'>
): DotWorkResultRow | undefined {
  if (!addressedTo(c, item)) {
    throw new Error(
      `[DOT_RELEASE_SCOPE] WorkItem '${item.item_id}' is not addressed to dot '${c.dot_id}'`
    );
  }
  if (dotItemTenantMismatch(c, item)) {
    throw new Error(
      `[DOT_RELEASE_SCOPE] WorkItem '${item.item_id}' belongs to another tenant scope than dot '${c.dot_id}'`
    );
  }
  if (item.lease_id || item.status === 'in_progress') {
    throw new Error(
      `[DOT_RELEASE_LEASED] WorkItem '${item.item_id}' is still leased — wait for the reaper to quarantine it`
    );
  }
  if (item.status === 'done') {
    throw new Error(
      `[DOT_RELEASE_DONE] WorkItem '${item.item_id}' is already done — nothing to release`
    );
  }
  const terminal = activeTerminalResult(terminalWorkResults(c, deps), item);
  const escalated = Boolean(
    (item.metadata?.dot_executor as Record<string, unknown> | undefined)?.escalated
  );
  if (!terminal && !hasUncertainAttempt(item) && !escalated) {
    throw new Error(
      `[DOT_RELEASE_NOTHING] WorkItem '${item.item_id}' carries no quarantine or escalation to release`
    );
  }
  return terminal;
}

function charterApprovalScope(c: DotCharter) {
  return c.scope.tenant_slug
    ? {
        scope: {
          tenant_slug: c.scope.tenant_slug,
          ...(c.scope.organization_id ? { organization_id: c.scope.organization_id } : {}),
        },
      }
    : {};
}

/**
 * `pnpm kyberion dot release <dot_id> <work_item_id> --reason "<text>"`: asks
 * for a human decision to release a quarantined or escalated dot WorkItem.
 * Creates a human-only approval request (autonomy channel, visible in
 * `pnpm kyberion approvals`) describing the item, tenant, attempts and reason.
 * Nothing changes on the WorkItem here: the executor sweep applies the release
 * only after an authenticated human approves ({@link applyApprovedDotReleases}).
 */
export function requestDotWorkItemRelease(
  c: DotCharter,
  input: RequestDotWorkItemReleaseInput,
  deps: RequestDotWorkItemReleaseDeps = {}
): DotReleaseRequestResult {
  const reason = input.reason?.trim();
  if (!reason) throw new Error('[DOT_RELEASE_REASON] --reason "<what you verified>" is required');
  const item = (deps.getItem ?? ((id: string) => getWorkItem(id)))(input.workItemId);
  if (!item) throw new Error(`[DOT_RELEASE_NOT_FOUND] no WorkItem '${input.workItemId}'`);
  const terminal = assertReleasable(c, item, deps);
  const correlationId = releaseCorrelationId(c.dot_id, item.item_id);
  const effectBinding = releaseEffectBinding(c.dot_id, item);
  const now = nowOf(deps);
  const pending = (deps.listApprovals ?? listApprovalRequests)({
    storageChannels: [AUTONOMY_APPROVAL_CHANNEL],
    status: 'pending',
  }).find(
    (record) =>
      record.correlationId === correlationId &&
      record.accountability?.effectBinding === effectBinding &&
      !isApprovalRequestExpired(record, now.getTime())
  );
  if (pending) return { request: pending, reused: true };
  const attempts = item.attempts ?? [];
  const requester = input.by?.trim() || 'operator';
  const details = [
    `dot: ${c.dot_id} (${actorOf(c)})`,
    `work item: ${item.item_id} (${item.status}, version ${item.version})`,
    `tenant: ${item.context?.tenant_slug ?? '(none)'}`,
    `action: ${meta(item, 'action_ref') ?? item.item_id}`,
    `attempts: ${attempts.length}${attempts.length ? ` (last: ${attempts.at(-1)?.failure_reason ?? attempts.at(-1)?.status ?? 'unknown'})` : ''}`,
    ...(terminal ? [`recorded result: ${terminal.status} (${terminal.mode})`] : []),
    `requester's verification: ${bounded(reason, 300)}`,
    'Approving returns the item to ready; the dot executor re-runs it under a new attempt id.',
  ].join('\n');
  const request = withExecutionContext(GOVERNED_STORE_ROLE, () =>
    (deps.createApproval ?? ((params) => createApprovalRequest(GOVERNED_STORE_ROLE, params)))({
      channel: 'operator',
      storageChannel: AUTONOMY_APPROVAL_CHANNEL,
      threadTs: '',
      correlationId,
      requestedBy: requester,
      draft: {
        title: `[${actorOf(c)}] Release quarantined WorkItem ${item.item_id}`,
        summary: `Approve only if you verified that no unintended effect of ${item.item_id} remains.`,
        details,
        severity: 'high',
      },
      kind: 'channel-approval',
      expiresAt: new Date(now.getTime() + DOT_RELEASE_EXPIRY_MINUTES * 60_000).toISOString(),
      source: { agentId: actorOf(c) },
      ...charterApprovalScope(c),
      justification: { reason: bounded(reason, 300) },
      // A human's call: never a veto window, never an agent or service.
      accountability: { finalDecision: 'human_only', effectBinding },
    })
  );
  return { request, reused: false };
}

/** Why an approved release request must not take effect, or undefined when it may. */
function releaseRefusal(
  c: DotCharter,
  record: ApprovalRequestRecord,
  item: WorkItem | null
): string | undefined {
  if (record.decidedByType !== 'human' || record.authenticated !== true) {
    return 'not decided by an authenticated human';
  }
  if (record.veto || record.accountability?.finalDecision !== 'human_only') {
    return 'not a human-only decision';
  }
  if (
    record.expiresAt &&
    (!record.decidedAt || Date.parse(record.decidedAt) > Date.parse(record.expiresAt))
  ) {
    return 'decided after the request expired';
  }
  if (!item) return 'WorkItem no longer exists';
  const requestTenant = record.scope?.tenant_slug || undefined;
  if (requestTenant !== (item.context?.tenant_slug || undefined)) {
    return 'request tenant differs from the WorkItem tenant';
  }
  if (record.accountability.effectBinding !== releaseEffectBinding(c.dot_id, item)) {
    return 'WorkItem changed since the request — request a new release';
  }
  return undefined;
}

/**
 * Executor-sweep settle step: apply human-approved release requests of the
 * given charters. A release takes effect only when an authenticated human
 * approved it (not a veto window, agent or service), the request tenant and
 * the charter tenant both match the item, and the item is unchanged since the
 * request. The verification is recorded from the approval record's decider
 * (`operator_verified_by` = `decidedBy`), audited, and the request is marked
 * applied (or failed with the refusal) so it is settled once. Pending,
 * rejected, expired and cancelled requests never change anything.
 */
export function applyApprovedDotReleases(
  charters: readonly LoadedDotCharter[],
  deps: Pick<DotExecutorDeps, 'rootDir' | 'now' | 'audit' | 'update' | 'resultsCache'> &
    DotReleaseApprovalPorts = {}
): WorkItem[] {
  let approved: ApprovalRequestRecord[];
  try {
    approved = (deps.listApprovals ?? listApprovalRequests)({
      storageChannels: [AUTONOMY_APPROVAL_CHANNEL],
      status: 'approved',
    }).filter(
      (record) =>
        record.correlationId.startsWith(DOT_RELEASE_CORRELATION_PREFIX) && !record.applyResult
    );
  } catch (error) {
    logger.warn(
      `release approvals unreadable — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep | evidence: approval store (${AUTONOMY_APPROVAL_CHANNEL})`
    );
    return [];
  }
  const released: WorkItem[] = [];
  const settle = (
    record: ApprovalRequestRecord,
    result: 'success' | 'failed',
    auditRef?: string
  ) => {
    try {
      withExecutionContext(GOVERNED_STORE_ROLE, () =>
        (
          deps.markApplied ??
          ((r: ApprovalRequestRecord, applyResult: ApprovalApplyResult) =>
            recordApprovalApplyResult(GOVERNED_STORE_ROLE, {
              channel: r.channel,
              storageChannel: r.storageChannel,
              requestId: r.id,
              applyResult,
            }))
        )(record, {
          appliedAt: nowOf(deps).toISOString(),
          appliedBy: 'dot-executor',
          result,
          ...(auditRef ? { auditRef } : {}),
        })
      );
    } catch (error) {
      logger.warn(
        `release request ${record.id} not marked ${result} — ${error instanceof Error ? error.message : String(error)} | next: re-evaluated next sweep (the item version guard prevents a second release) | evidence: ${record.id}`
      );
    }
  };
  for (const record of approved) {
    const target = parseReleaseCorrelation(record.correlationId);
    const charter = target && charters.find(({ charter: c }) => c.dot_id === target.dotId)?.charter;
    if (!target || !charter) continue; // not this runtime's dot; another sweep settles it
    let item: WorkItem | null;
    try {
      item = (deps.getItem ?? ((id: string) => getWorkItem(id)))(target.itemId);
    } catch (error) {
      logger.warn(
        `release target ${target.itemId} unreadable — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep | evidence: ${record.id}`
      );
      continue;
    }
    let refusal = releaseRefusal(charter, record, item);
    let terminal: DotWorkResultRow | undefined;
    if (!refusal && item) {
      try {
        terminal = withExecutionContext(
          charter.authority.authority_role,
          () => assertReleasable(charter, item!, deps),
          undefined,
          charter.scope.tenant_slug,
          charter.scope.organization_id
        );
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
    }
    if (refusal || !item) {
      logger.warn(
        `release request ${record.id} refused — ${refusal} | next: the item stays quarantined; request a new release if still needed | evidence: ${target.itemId}`
      );
      recordAudit(
        charter,
        'denied',
        {
          work_item_id: target.itemId,
          approval_request_id: record.id,
          reason: `release refused: ${refusal}`,
        },
        deps
      );
      settle(record, 'failed');
      continue;
    }
    const decider = String(record.decidedBy);
    const verification: DotOperatorVerification = {
      operator_verified_at: nowOf(deps).toISOString(),
      operator_verified_by: decider,
      operator_verified_reason: bounded(record.justification?.reason ?? '', 300),
      operator_verified_approval_id: record.id,
    };
    const priorExecutor =
      (item.metadata?.dot_executor as Record<string, unknown> | undefined) ?? {};
    let updated: WorkItem;
    try {
      updated = withExecutionContext(GOVERNED_STORE_ROLE, () =>
        (deps.update ?? updateWorkItem)({
          itemId: item!.item_id,
          expectedVersion: item!.version,
          status: 'ready',
          metadata: {
            ...item!.metadata,
            dot_executor: {
              ...priorExecutor,
              ...verification,
              released_from: item!.status,
            },
          },
        })
      );
    } catch (error) {
      logger.warn(
        `applying release ${record.id} failed — ${error instanceof Error ? error.message : String(error)} | next: retried next sweep; a changed item voids the request | evidence: ${item.item_id}`
      );
      continue;
    }
    try {
      (deps.audit ?? ((entry) => auditChain.record(entry)))({
        agentId: decider,
        actor: { kind: 'human', id: decider },
        action: 'dot_action',
        operation: DOT_OPERATOR_RELEASE_OPERATION,
        result: 'allowed',
        metadata: {
          dot_id: charter.dot_id,
          work_item_id: item.item_id,
          action_ref: meta(item, 'action_ref') ?? item.item_id,
          released_from: item.status,
          approval_request_id: record.id,
          operator_verified_at: verification.operator_verified_at,
          ...(terminal ? { superseded_result_status: terminal.status } : {}),
          // Tenant prose stays out of the shared audit chain.
          ...(charter.scope.tenant_slug ? {} : { reason: verification.operator_verified_reason }),
        },
        ...(charter.scope.tenant_slug ? { tenantSlug: charter.scope.tenant_slug } : {}),
      });
    } catch (error) {
      logger.warn(
        `release audit failed for ${item.item_id} — ${error instanceof Error ? error.message : String(error)} | next: the WorkItem metadata and the approval record still carry the decision | evidence: ${record.id}`
      );
    }
    settle(record, 'success');
    released.push(updated);
  }
  return released;
}
