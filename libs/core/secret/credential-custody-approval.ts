/**
 * Owner approvals of credential custody changes (design §2.1, §2.3; review B1/S3):
 *
 * - `tenant_personal_owner` — marking a tenant as one person's own tenant
 *   (`personal_owner`), the only fact that makes a consumer subscription token
 *   eligible there. No bootstrap path writes it.
 * - `tenant_credential_overwrite` — replacing an already registered
 *   tenant-custody credential value.
 *
 * Same trust shape as the standing-grant approvals (grant-store.ts): a request
 * hash-bound to the exact effect, an authenticated human-only decision by the
 * named approver, separation-of-duties usability (`credential_custody`), and a
 * single consumption naming the applied effect.
 */
import { assertApprovalUsable } from '../governance/approval-separation-of-duties.js';
import { computeApprovalPayloadHash } from '../governance/approval-presentation.js';
import { createApprovalRequest } from '../governance/approval-request-create.js';
import {
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
} from '../governance/approval-store-reader.js';
import type { ApprovalRequestRecord } from '../governance/approval-store.js';
import { markApprovalConsumed } from '../governance/approval-revocation.js';
import {
  approvalRequesterActorId,
  resolveApprovalRequesterInput,
  type ApprovalRequesterInput,
} from '../governance/approval-requester.js';
import { serviceAllocationApprovedByOwner } from '../governance/service-credential-grant-scope.js';

export const CREDENTIAL_CUSTODY_APPROVAL_CHANNEL = 'credential-custody';
export const CREDENTIAL_CUSTODY_APPROVAL_CONSUMER = 'credential_custody';
const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

export type CredentialCustodyEffect =
  | { action: 'tenant_personal_owner'; tenant_slug: string; personal_owner: string | null }
  | {
      /** Every term of the record being written: any change needs a new approval (review 5). */
      action: 'tenant_credential_overwrite';
      credential_ref: string;
      kind: string;
      plan: string;
      terms: string;
      contract_tenant: string | null;
      token_expires_at: string | null;
      value_fingerprint: string;
    };

export function credentialCustodyEffectBinding(effect: CredentialCustodyEffect): string {
  return effect.action === 'tenant_personal_owner'
    ? `credential-custody:personal-owner:${effect.tenant_slug}`
    : `credential-custody:overwrite:${effect.credential_ref}`;
}

function payload(effect: CredentialCustodyEffect): Record<string, unknown> {
  return { ...effect, effect: credentialCustodyEffectBinding(effect) };
}

function describe(effect: CredentialCustodyEffect): { title: string; details: string } {
  return effect.action === 'tenant_personal_owner'
    ? {
        title: `Personal owner of tenant ${effect.tenant_slug}`,
        details: `Set tenant ${effect.tenant_slug} personal_owner to ${effect.personal_owner ?? '(none)'}. A consumer subscription token (Claude Pro/Max) of that person becomes usable for this tenant's work; clear it for any company or client tenant.`,
      }
    : {
        title: `Replace credential ${effect.credential_ref}`,
        details: `Overwrite the registered record of ${effect.credential_ref}: kind ${effect.kind}, plan ${effect.plan} (${effect.terms} terms)${effect.contract_tenant ? `, contract tenant ${effect.contract_tenant}` : ''}${effect.token_expires_at ? `, token expires ${effect.token_expires_at}` : ''}, value fingerprint ${effect.value_fingerprint}. Existing lending grants stop until re-approved for the new record.`,
      };
}

/** Open (or reuse) the owner approval of one exact custody effect. */
export function requestCredentialCustodyApproval(
  effect: CredentialCustodyEffect,
  options: { requester: ApprovalRequesterInput; approver: string; now?: Date }
): ApprovalRequestRecord {
  const payloadHash = computeApprovalPayloadHash(payload(effect));
  const effectBinding = credentialCustodyEffectBinding(effect);
  const existing = listApprovalRequests({
    storageChannels: [CREDENTIAL_CUSTODY_APPROVAL_CHANNEL],
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      record.accountability?.payloadHash === payloadHash &&
      record.accountability?.effectBinding === effectBinding &&
      !record.consumption &&
      !isApprovalRequestExpired(record)
  );
  if (existing) return existing;
  const requester = resolveApprovalRequesterInput(options.requester);
  const now = options.now ?? new Date();
  const { title, details } = describe(effect);
  return createApprovalRequest('mission_controller', {
    channel: CREDENTIAL_CUSTODY_APPROVAL_CHANNEL,
    storageChannel: CREDENTIAL_CUSTODY_APPROVAL_CHANNEL,
    threadTs: effectBinding,
    correlationId: effectBinding,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    kind: 'channel-approval',
    draft: {
      title,
      summary: title,
      details: `${details}\nApprover: ${options.approver}`,
      severity: 'high',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: 'credential-custody',
    },
    justification: { reason: title, requestedEffects: [effectBinding], impactSummary: details },
    risk: { level: 'high', restartScope: 'manual', requiresStrongAuth: true, policyId: 'PG-03' },
    workflow: {
      workflowId: effectBinding,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      stages: [],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: { finalDecision: 'human_only', payloadHash, effectBinding },
  });
}

/**
 * Apply side: approved, unexpired, unused, usable, hash-bound to exactly this
 * effect and decided (authenticated, human-only) by an accepted approver.
 * Consumes the approval once; returns the decider.
 */
export function consumeCredentialCustodyApproval(
  effect: CredentialCustodyEffect,
  approvalRequestId: string,
  acceptApprover: (approver: string) => boolean,
  effectRef: string
): { humanDecider: string; approvalId: string; consumedAt: string } {
  const denied = (why: string) => new Error(`[CREDENTIAL_CUSTODY_APPROVAL_INVALID] ${why}`);
  const approval = loadApprovalRequest(CREDENTIAL_CUSTODY_APPROVAL_CHANNEL, approvalRequestId);
  if (!approval || approval.status !== 'approved')
    throw denied(`approval ${approvalRequestId} is ${approval?.status ?? 'missing'}, not approved`);
  if (isApprovalRequestExpired(approval)) throw denied(`approval ${approval.id} has expired`);
  if (approval.consumption || approval.applyClaim || approval.applyResult)
    throw denied(`approval ${approval.id} was already used`);
  assertApprovalUsable(approval, { consumer: 'credential_custody' });
  if (
    approval.accountability?.effectBinding !== credentialCustodyEffectBinding(effect) ||
    approval.accountability?.payloadHash !== computeApprovalPayloadHash(payload(effect))
  )
    throw denied('approval is bound to a different effect');
  const decider = approval.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  )?.approvedBy;
  if (!decider || !acceptApprover(decider) || !serviceAllocationApprovedByOwner(approval, decider))
    throw denied(`approval must be decided by the owner (decided by ${decider ?? 'nobody'})`);
  const consumed = markApprovalConsumed('mission_controller', {
    channel: CREDENTIAL_CUSTODY_APPROVAL_CHANNEL,
    requestId: approval.id,
    consumer: CREDENTIAL_CUSTODY_APPROVAL_CONSUMER,
    consumedBy: decider,
    effectRef,
  });
  const consumedAt = consumed.consumption?.consumedAt;
  if (!consumedAt) throw denied(`approval ${approval.id} consumption was not recorded`);
  return { humanDecider: decider, approvalId: approval.id, consumedAt };
}

/** Evidence written next to a tenant's `personal_owner` (tenant-personal-owner.ts only). */
export interface TenantPersonalOwnerBasis {
  approval_request_id: string;
  /** The approval's consumption time (also the change time). */
  decided_at: string;
  audit_id: string;
}

export function personalOwnerEffectRef(tenant: string): string {
  return `tenant:${tenant}:personal_owner`;
}

/**
 * Use-time check of a tenant's `personal_owner` (review 1; like verifyGrantBasis):
 * the basis names an approval on the custody channel that is approved, not
 * revoked, consumed by `credential_custody` for exactly this tenant at exactly
 * `decided_at`, hash-bound to setting exactly this person, and decided by that
 * person. A hand-edited field (no or foreign basis) verifies as false.
 */
export function verifyTenantPersonalOwnerBasis(
  tenant: string,
  personalOwner: string,
  basis: TenantPersonalOwnerBasis | undefined
): boolean {
  if (
    !basis ||
    typeof basis.approval_request_id !== 'string' ||
    typeof basis.decided_at !== 'string'
  )
    return false;
  try {
    const approval = loadApprovalRequest(
      CREDENTIAL_CUSTODY_APPROVAL_CHANNEL,
      basis.approval_request_id
    );
    if (!approval || approval.status !== 'approved' || approval.revocation) return false;
    const consumption = approval.consumption;
    if (
      consumption?.consumer !== CREDENTIAL_CUSTODY_APPROVAL_CONSUMER ||
      consumption.effectRef !== personalOwnerEffectRef(tenant) ||
      consumption.consumedAt !== basis.decided_at
    )
      return false;
    const effect: CredentialCustodyEffect = {
      action: 'tenant_personal_owner',
      tenant_slug: tenant,
      personal_owner: personalOwner,
    };
    return (
      approval.accountability?.effectBinding === credentialCustodyEffectBinding(effect) &&
      approval.accountability?.payloadHash === computeApprovalPayloadHash(payload(effect)) &&
      serviceAllocationApprovedByOwner(approval, personalOwner)
    );
  } catch {
    return false;
  }
}
