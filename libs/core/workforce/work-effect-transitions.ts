/** Preparations only: callers must hold the WorkItem coordination fence through snapshot append. */
import { WorkCoordinationError } from './work-coordination-error.js';
import { assertVersion } from './work-coordination-identity.js';
import {
  declaredWorkTarget,
  findHeldWorkTarget,
  settledWorkEffect,
  workEffectOwnership,
} from './work-effect-ownership.js';
import { assertWorkEffectReleaseApproval } from '../governance/work-effect-release.js';
import type {
  WorkItem,
  WorkEffectOwnership,
  ReleaseWorkItemInput,
  AppendCoordinationEventInput,
} from './work-coordination-types.js';
export interface EffectReleaseInput {
  itemId: string;
  expectedVersion: number;
  approvalRequestId: string;
}
export function assertEffectClaimable(
  current: WorkItem,
  items: readonly WorkItem[]
): string | undefined {
  if (workEffectOwnership(current)?.state === 'held')
    throw new WorkCoordinationError(
      'lease_conflict',
      'this item retains unresolved effect ownership; governed human release required'
    );
  const target = declaredWorkTarget(current);
  const held = target ? findHeldWorkTarget(items, target, current.context?.tenant_slug) : undefined;
  if (held)
    throw new WorkCoordinationError(
      'lease_conflict',
      `target ownership retained by ${held.item_id}; verify stopped execution and use governed human release before conflicting work`,
      { item_id: current.item_id, holding_item_id: held.item_id }
    );

  return target;
}
export function claimedEffectOwnership(
  current: WorkItem,
  target: string | undefined,
  attemptId: string,
  actorId: string,
  now: string
): WorkEffectOwnership | undefined {
  return target && typeof current.metadata?.dot_id === 'string'
    ? {
        target,
        attempt_id: attemptId,
        actor_id: actorId,
        ...(current.context?.tenant_slug ? { tenant_slug: current.context.tenant_slug } : {}),
        state: 'held',
        acquired_at: now,
      }
    : current.effect_ownership;
}
export function prepareEffectSettlement(
  current: WorkItem,
  input: ReleaseWorkItemInput,
  now: string
): WorkEffectOwnership | undefined {
  if (
    input.effectDisposition &&
    !(
      (input.effectDisposition === 'completed' && input.nextStatus === 'done') ||
      (input.effectDisposition === 'pre_effect' &&
        ['ready', 'archived'].includes(input.nextStatus ?? '') &&
        (input.metadata?.dot_executor as Record<string, unknown> | undefined)?.reason_code ===
          'pre_effect_failure')
    )
  )
    throw new WorkCoordinationError(
      'validation_error',
      'effect settlement does not match the durable executor outcome'
    );
  return input.effectDisposition
    ? settledWorkEffect(current, input.effectDisposition, now)
    : workEffectOwnership(current);
}
export function prepareHumanEffectRelease(
  item: WorkItem | null,
  input: EffectReleaseInput,
  verifiedAt: string
): WorkItem {
  if (!item) throw new WorkCoordinationError('item_not_found', 'effect ownership item missing');
  assertVersion(item, input.expectedVersion);
  const hold = workEffectOwnership(item);
  if (!hold || hold.state !== 'held' || item.lease_id || item.status === 'in_progress')
    throw new WorkCoordinationError(
      'lease_conflict',
      'effect ownership is not a quarantined unleased attempt'
    );
  const approval = assertWorkEffectReleaseApproval(item, hold, input.approvalRequestId);
  const previousExecutor = item.metadata?.dot_executor as Record<string, unknown> | undefined;
  return {
    ...item,
    status: 'ready',
    version: item.version + 1,
    updated_at: verifiedAt,
    metadata: {
      ...item.metadata,
      ...(hold.actor_id.startsWith('dot:')
        ? {
            dot_executor: {
              ...previousExecutor,
              operator_verified_at: verifiedAt,
              operator_verified_by: approval.decidedBy,
              operator_verified_reason: String(approval.justification?.reason ?? '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 300),
              operator_verified_approval_id: approval.id,
              released_from: item.status,
            },
          }
        : {
            execution_recovery: {
              verified_at: verifiedAt,
              verified_by: approval.decidedBy,
              approval_request_id: input.approvalRequestId,
            },
            execution_outcome: 'reconciled',
            recovery_required: false,
          }),
    },
    effect_ownership: {
      ...hold,
      state: 'settled',
      settlement: 'human_verified',
      settled_at: verifiedAt,
      approval_request_id: input.approvalRequestId,
    },
  };
}
export function effectReleaseEvent(item: WorkItem): AppendCoordinationEventInput {
  return {
    eventType: 'item_updated',
    itemId: item.item_id,
    status: 'ready',
    note: 'authenticated human reconciled effect ownership',
    payload: {
      approval_request_id: item.effect_ownership?.approval_request_id,
      attempt_id: item.effect_ownership?.attempt_id,
    },
  };
}
