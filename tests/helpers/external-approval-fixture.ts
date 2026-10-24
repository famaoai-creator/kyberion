/** Exact synthetic approval for transport unit tests whose gate/store are mocked. */
import { computeApprovalPayloadHash } from '@agent/core/governance/approval-presentation';
import type { ApprovalGateParams } from '@agent/core/governance/approval-gate';
import type { ApprovalRequestRecord } from '@agent/core/governance/approval-store';
export function externalApprovalFixture(
  params: ApprovalGateParams,
  id: string
): ApprovalRequestRecord {
  return {
    id,
    kind: 'channel-approval',
    channel: 'external-operation',
    storageChannel: 'external-operation',
    correlationId: params.correlationId,
    threadTs: 'fixture',
    requestedBy: params.agentId,
    requestedAt: '2026-10-24T00:00:00Z',
    status: 'approved',
    decidedBy: 'user:fixture-owner',
    decidedByType: 'human',
    authenticated: true,
    title: 'Exact fixture action',
    summary: 'Synthetic approved transport request',
    accountability: {
      finalDecision: 'human_only',
      payloadHash: computeApprovalPayloadHash(params.payload),
      effectBinding: params.operationId,
    },
  };
}
