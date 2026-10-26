/** Authenticated human release proofs, revalidated at the atomic WorkItem mutation boundary. */
import { loadApprovalRequest } from './approval-store-reader.js';
import { approvalUsabilityRefusal } from './approval-separation-of-duties.js';
import type { ApprovalRequestRecord } from './approval-store.js';
import { AUTONOMY_APPROVAL_CHANNEL } from './approval-store-paths.js';

export function workEffectReleaseProofBinding(
  item: WorkItem,
  hold: WorkEffectOwnership
): { correlationId: string; effectBinding: string } {
  const dot = hold.actor_id.startsWith('dot:') ? hold.actor_id.slice(4) : undefined;
  return {
    correlationId: dot
      ? `dot-release:${dot}:${item.item_id}`
      : `work-effect-release:${item.item_id}:${hold.attempt_id}`,
    effectBinding: dot
      ? `dot_work_item_release:${dot}:${item.item_id}@v${item.version}`
      : `work_effect_release:${hold.actor_id}:${item.item_id}:${hold.attempt_id}@v${item.version}`,
  };
}
import type { WorkEffectOwnership, WorkItem } from '../workforce/work-coordination-types.js';

export function assertWorkEffectReleaseApproval(
  item: WorkItem,
  hold: WorkEffectOwnership,
  requestId: string
): ApprovalRequestRecord {
  const record = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId);
  const dot = hold.actor_id.startsWith('dot:') ? hold.actor_id.slice(4) : undefined;
  const binding = workEffectReleaseProofBinding(item, hold);
  if (
    !record ||
    record.status !== 'approved' ||
    record.applyResult ||
    record.decidedByType !== 'human' ||
    record.authenticated !== true ||
    record.veto ||
    record.accountability?.finalDecision !== 'human_only'
  ) {
    throw new Error('effect ownership release requires an authenticated human release approval');
  }
  const refusal = approvalUsabilityRefusal(record, dot ? 'dot_release' : 'work_effect_release');
  if (refusal) throw new Error(refusal);
  if (
    record.correlationId !== binding.correlationId ||
    record.accountability.effectBinding !== binding.effectBinding ||
    (record.scope?.tenant_slug || undefined) !== hold.tenant_slug ||
    hold.tenant_slug !== item.context?.tenant_slug ||
    (record.expiresAt &&
      (!record.decidedAt || Date.parse(record.decidedAt) > Date.parse(record.expiresAt)))
  ) {
    throw new Error(
      'effect ownership release approval does not bind this unchanged item, owner and tenant'
    );
  }
  if (
    !dot &&
    ['organization_id', 'project_id', 'mission_id', 'task_id'].some((key) => {
      const field = key as 'organization_id' | 'project_id' | 'mission_id' | 'task_id';
      return (record.scope?.[field] || undefined) !== (item.context?.[field] || undefined);
    })
  )
    throw new Error('effect ownership release approval does not bind the work item entity scope');
  if (
    hold.attempt_id !==
    (item.current_attempt_id ?? item.attempts?.at(-1)?.run_id ?? `legacy:${item.item_id}`)
  )
    throw new Error('effect ownership attempt changed; retained');
  return record;
}
