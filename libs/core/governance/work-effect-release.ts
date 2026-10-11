/** Existing dot human-release proof, revalidated at the atomic WorkItem mutation boundary. */
import { loadApprovalRequest } from './approval-store-reader.js';
import { approvalUsabilityRefusal } from './approval-separation-of-duties.js';
import type { ApprovalRequestRecord } from './approval-store.js';
import { AUTONOMY_APPROVAL_CHANNEL } from './approval-store-paths.js';
import type { WorkEffectOwnership, WorkItem } from '../workforce/work-coordination-types.js';

export function assertWorkEffectReleaseApproval(
  item: WorkItem,
  hold: WorkEffectOwnership,
  requestId: string
): ApprovalRequestRecord {
  const record = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId);
  const dot = hold.actor_id.startsWith('dot:') ? hold.actor_id.slice(4) : undefined;
  if (
    !dot ||
    !record ||
    record.status !== 'approved' ||
    record.applyResult ||
    record.decidedByType !== 'human' ||
    record.authenticated !== true ||
    record.veto ||
    record.accountability?.finalDecision !== 'human_only'
  ) {
    throw new Error(
      'effect ownership release requires the existing authenticated human dot release approval'
    );
  }
  const refusal = approvalUsabilityRefusal(record, 'dot_release');
  if (refusal) throw new Error(refusal);
  if (
    record.correlationId !== `dot-release:${dot}:${item.item_id}` ||
    record.accountability.effectBinding !==
      `dot_work_item_release:${dot}:${item.item_id}@v${item.version}` ||
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
    hold.attempt_id !==
    (item.current_attempt_id ?? item.attempts?.at(-1)?.run_id ?? `legacy:${item.item_id}`)
  )
    throw new Error('effect ownership attempt changed; retained');
  return record;
}
