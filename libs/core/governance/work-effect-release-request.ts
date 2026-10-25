/** Request a human decision in the existing approval store; this grants no release authority. */
import { createHash } from 'node:crypto';
import { getWorkItem, listActiveWorkLeases } from '../workforce/work-coordination.js';
import { workEffectOwnership } from '../workforce/work-effect-ownership.js';
import { normalizeEventScope } from '../event-scope.js';
import { createApprovalRequest } from './approval-store.js';
import { AUTONOMY_APPROVAL_CHANNEL } from './approval-store-paths.js';
import { workEffectReleaseProofBinding } from './work-effect-release.js';

export function requestWorkEffectReleaseApproval(input: {
  itemId: string;
  expectedVersion: number;
  requestedBy: string;
}) {
  const item = getWorkItem(input.itemId);
  if (!item || !Number.isInteger(input.expectedVersion) || item.version !== input.expectedVersion)
    throw new Error(
      'Work item version changed; inspect the held attempt before requesting recovery'
    );
  const hold = workEffectOwnership(item);
  if (hold?.state !== 'held') throw new Error('Work item has no unresolved effect ownership');
  if (
    item.status === 'in_progress' ||
    listActiveWorkLeases().some((lease) => lease.item_id === item.item_id)
  )
    throw new Error(
      'Stop and verify the exact runtime, then release its scheduling lease to blocked before requesting effect recovery'
    );
  const security = item.metadata?.security_scope as { write_tier?: unknown } | undefined;
  const tier =
    security && ['public', 'confidential', 'personal'].includes(String(security.write_tier))
      ? (security.write_tier as 'public' | 'confidential' | 'personal')
      : item.context?.tenant_slug
        ? 'confidential'
        : 'public';
  const scope = normalizeEventScope({ ...item.context, tier });
  const binding = workEffectReleaseProofBinding(item, hold);
  const payloadHash = createHash('sha256')
    .update(JSON.stringify({ item_id: item.item_id, version: item.version, hold, scope }))
    .digest('hex');
  return createApprovalRequest('mission_controller', {
    channel: 'terminal',
    storageChannel: AUTONOMY_APPROVAL_CHANNEL,
    threadTs: '',
    requestedBy: input.requestedBy,
    correlationId: binding.correlationId,
    scope,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    accountability: {
      finalDecision: 'human_only',
      effectBinding: binding.effectBinding,
      payloadHash,
    },
    draft: {
      title: `Reconcile held execution ${item.item_id}`,
      summary: `Verify runtime ${hold.actor_id} stopped and reconcile effects of attempt ${hold.attempt_id} before allowing a new claim. This decision binds work item version ${item.version}.`,
      details: `Target: ${hold.target}. Approval alone does not run or retry work; apply release-effect using the same item version after the human decision.`,
    },
  });
}
