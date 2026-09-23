import { loadApprovalRequest } from '@agent/core/approval-store';
import type { OrganizationDecisionRecord } from '@agent/core/organization-operating-model';

export function verifyDecisionApprovalRef(
  ref: string | undefined,
  decision: OrganizationDecisionRecord,
  status: 'approved' | 'rejected'
): string {
  const [channel, id, extra] = (ref || '').split(':');
  if (!channel || !id || extra) throw new Error('--approval-ref must be channel:id.');
  const approval = loadApprovalRequest(channel, id);
  const effect = `organization:decision:${decision.decision_id}:${status}`;
  if (
    !approval ||
    approval.status !== status ||
    approval.decidedByType !== 'human' ||
    approval.authenticated !== true ||
    !['surface_session', 'totp', 'passkey'].includes(approval.decidedAuthMethod || '') ||
    approval.accountability?.finalDecision !== 'human_only' ||
    approval.accountability.effectBinding !== effect ||
    approval.scope?.organization_id !== decision.organization_id ||
    approval.scope?.tier !== decision.tier ||
    approval.scope?.tenant_slug !== decision.tenant_slug ||
    !approval.justification?.requestedEffects?.includes(effect)
  ) {
    throw new Error(
      'Approval reference does not contain an authenticated human decision bound to this organization decision.'
    );
  }
  return ref!;
}
