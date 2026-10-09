/**
 * Terminal approval decisions (`pnpm kyberion approvals --approve/--deny/--revoke`,
 * `pnpm kyberion approve|reject`). The terminal decides as the local owner
 * member (`user:<member_id>`, see `cli-operator-principal.ts`) with the
 * onboarding display name recorded beside it; with separation of duties on, a
 * missing identity or an agent session is reported instead of decided.
 */
import {
  decideApprovalRequest,
  listApprovalRequests,
  revokeApprovalRequest,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import {
  detectCliAgentPrincipal,
  resolveCliApprovalDecider,
  resolveCliOperatorIdentity,
  type CliOperatorPrincipalOptions,
} from '@agent/core/governance/cli-operator-principal';

export function decideApprovalFromCli(
  request: ApprovalRequestRecord,
  params: CliOperatorPrincipalOptions & { decision: 'approved' | 'rejected'; note: string }
): ApprovalRequestRecord {
  const decider = resolveCliApprovalDecider({ ...params, decision: params.decision });
  return decideApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    decision: params.decision,
    decidedBy: decider.decidedBy,
    decidedByDisplayName: decider.decidedByDisplayName,
    decidedByRole: 'sovereign',
    authMethod: 'manual',
    decidedByType: 'human',
    authenticated: true,
    payloadHash: request.accountability?.payloadHash,
    effectBinding: request.accountability?.effectBinding,
    note: params.note,
  });
}

/** Approved records that were neither claimed, applied nor revoked. */
export function findRevocableApproval(
  requestId: string,
  storageChannels?: string[]
): ApprovalRequestRecord | undefined {
  return listApprovalRequests({ status: 'approved', storageChannels }).find(
    (entry) => entry.id === requestId
  );
}

/**
 * Revoke from the terminal. An agent session revokes as that agent (allowed
 * only for its own requests); otherwise the local owner member revokes with
 * owner authority; without an owner member, the display name may revoke only
 * what it requested or approved itself.
 */
export function revokeApprovalFromCli(
  request: ApprovalRequestRecord,
  params: CliOperatorPrincipalOptions & { reason?: string }
): ApprovalRequestRecord {
  const agent = detectCliAgentPrincipal(params.env);
  const identity = resolveCliOperatorIdentity(params);
  const revoker = agent
    ? { revokedBy: agent }
    : identity.principalId
      ? {
          revokedBy: identity.principalId,
          revokedByDisplayName: identity.displayName,
          revokerAuthority: 'owner' as const,
        }
      : { revokedBy: identity.displayName };
  return revokeApprovalRequest('mission_controller', {
    channel: request.channel,
    storageChannel: request.storageChannel,
    requestId: request.id,
    ...revoker,
    reason: params.reason?.trim() || 'revoked from terminal via pnpm kyberion approvals --revoke',
  });
}
