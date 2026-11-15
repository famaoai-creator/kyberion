import {
  loadPersonalCredentialGrantRecord,
  writePersonalCredentialGrantRecord,
  newPersonalCredentialGrantId,
} from './personal-credential-grant-store.js';
/** Authenticated operator prerequisite only. No runtime broker or credential consumption. */
import { auditChain } from './audit-chain.js';
import { withAuthenticatedPersonalApprovals } from './authenticated-personal-approvals.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { createApprovalRequest } from './approval-request-create.js';
import { loadApprovalRequest, isApprovalRequestExpired } from './approval-store-reader.js';
import { assertApprovalUsable } from './approval-separation-of-duties.js';
import { markApprovalConsumed, revokeStandingEffectApproval } from './approval-revocation.js';
import { assuranceOfAuthMethod } from './approval-assurance.js';
import {
  personalCredentialApprovalMatches,
  verifyPersonalCredentialGrantApprovalBasis,
} from './personal-credential-grant-basis.js';
import type { ApprovalRequestRecord } from './approval-store.js';
import {
  GRANT_APPROVAL_CHANNEL,
  GRANT_APPROVAL_CONSUMER,
  requireStandingGrantPolicy,
  validatePersonalCredentialGrantRecord,
} from './grant-store.js';
import {
  PERSONAL_CREDENTIAL_CAPABILITY,
  PERSONAL_CREDENTIAL_RUNTIME_USE,
  normalizePersonalCredentialGrantScope,
  personalCredentialGrantEffect,
  personalCredentialGrantPayload,
  type PersonalCredentialGrantDraft,
  type PersonalCredentialGrantRecord,
} from './personal-credential-grant-scope.js';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import type { OnboardingAuthorityPrincipal } from '../organization/onboarding-authority.js';
import { inspectInstalledPersonalRuntime } from '../organization/personal-runtime-identity.js';
import { loadServiceBindingRecord } from '../service/service-binding-reader.js';
import { validateBindingOwner } from '../service/service-binding-owner.js';
import { getServiceEndpointRecord } from '../service/service-endpoint-registry.js';
import { loadLocalAccountRegistration } from '../secret/secret-guard.js';
import { resolveAssumedRole } from '../authority.js';
import { resolveMemberByPrincipal } from '../organization/member-registry.js';
import { getAgentIdentity } from '../agent/agent-identity.js';
import { parseNhiId } from '../contracts/nhi-id.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import { currentScopeEnvelope, mintScopeEnvelope, withScopeEnvelope } from '../scope-envelope.js';
import { withScopeEnvOnly } from '../foundation/scope-resolution-mode.js';

export interface PersonalCredentialGrantSelection {
  bindingId: string;
  projectId: string;
  missionId: string;
  taskId: string;
  allowedActions: string[];
  purpose: string;
  ttlDays: number;
}
const denied = (): never => {
  throw new Error('[PERSONAL_CREDENTIAL_GRANT_DENIED] Exact authenticated owner consent required');
};

function personalOperator<T>(
  principal: OnboardingAuthorityPrincipal,
  run: (owner: string, nhi: string) => T
): T {
  const identity = credentialExecutionIdentity();
  if (identity.tenantSlug || identity.personalClaim || !principal.personalOwner) return denied();
  const installed = inspectInstalledPersonalRuntime();
  if (!installed.ready || !installed.agentActive || installed.ownerId !== principal.accountableId)
    return denied();
  const result = withAuthenticatedPersonalApprovals(principal, () => ({
    value: run(installed.ownerId, installed.agentId),
  }));
  return result ? result.value : denied();
}

function prepare(
  owner: string,
  nhi: string,
  selection: PersonalCredentialGrantSelection
): PersonalCredentialGrantDraft {
  const binding = loadServiceBindingRecord(selection.bindingId);
  if (
    !binding ||
    validateBindingOwner(binding).length ||
    binding.owner_kind !== 'person' ||
    binding.owner_ref !== owner ||
    binding.tenant_slug ||
    binding.auth_mode !== 'secret-guard' ||
    !binding.service_id ||
    (binding.project_id && binding.project_id !== selection.projectId) ||
    !Array.isArray(selection.allowedActions) ||
    !selection.allowedActions.length ||
    selection.allowedActions.some(
      (action) =>
        !binding.allowed_actions.includes(action) || binding.approval_policy[action] === 'denied'
    )
  )
    return denied();
  const permitted =
    getServiceEndpointRecord(binding.service_id)?.credential_suffixes.accessToken.map(
      (suffix) => `${binding.service_id!.toUpperCase()}_${suffix}`
    ) ?? [];
  if (
    !binding.secret_refs.length ||
    new Set(binding.secret_refs).size !== binding.secret_refs.length ||
    binding.secret_refs.some((ref) => !permitted.includes(ref))
  )
    return denied();
  const registration = loadLocalAccountRegistration({
    serviceId: binding.service_id,
    bindingId: binding.binding_id,
    ownerKind: 'person',
    ownerRef: owner,
  });
  if (!registration.generation || registration.pendingApprovalId) return denied();
  const purpose = typeof selection.purpose === 'string' ? selection.purpose.trim() : '';
  const policy = requireStandingGrantPolicy(PERSONAL_CREDENTIAL_CAPABILITY);
  if (
    !purpose ||
    purpose.length > 500 ||
    !Number.isInteger(selection.ttlDays) ||
    selection.ttlDays < 1 ||
    selection.ttlDays > policy.max_ttl_days
  )
    return denied();
  return {
    scope: normalizePersonalCredentialGrantScope({
      owner_ref: owner,
      nhi_id: nhi,
      binding_id: binding.binding_id,
      service_id: binding.service_id,
      target: binding.target,
      secret_refs: binding.secret_refs,
      allowed_actions: selection.allowedActions,
      generation: registration.generation,
      project_id: selection.projectId,
      mission_id: selection.missionId,
      task_id: selection.taskId,
      runtime_use: PERSONAL_CREDENTIAL_RUNTIME_USE,
    }),
    purpose,
    ttl_days: selection.ttlDays,
  };
}

export function requestPersonalCredentialGrantApproval(
  principal: OnboardingAuthorityPrincipal,
  selection: PersonalCredentialGrantSelection
): ApprovalRequestRecord {
  return personalOperator(principal, (owner, nhi) => {
    const draft = prepare(owner, nhi, selection);
    const effectBinding = personalCredentialGrantEffect(draft);
    return createApprovalRequest('mission_controller', {
      channel: GRANT_APPROVAL_CHANNEL,
      storageChannel: GRANT_APPROVAL_CHANNEL,
      threadTs: effectBinding,
      correlationId: effectBinding,
      requestedBy: nhi,
      requestedByContext: { surface: 'system', actorId: nhi, actorRole: 'grant-standing' },
      expiresAt: new Date(Date.now() + 72 * 3600_000).toISOString(),
      draft: {
        title: 'Personal account use consent',
        severity: 'high',
        summary: `Authorize ${draft.scope.binding_id} for this personal task for ${draft.ttl_days} days.`,
        details:
          JSON.stringify(personalCredentialGrantPayload(draft)) +
          '\nAuthorize selected read-only API token use for this exact owner, agent, account generation and project/mission/task. Only catalog-declared GET/HEAD operations with header authentication are admitted. Effects, sessions, provider credentials and organization sharing are not authorized.',
      },
      sourceText: JSON.stringify(draft),
      scope: { tier: 'personal', scope_kind: 'system', nhi_id: nhi },
      risk: { level: 'high', restartScope: 'manual', requiresStrongAuth: true, policyId: 'PG-03' },
      workflow: {
        workflowId: effectBinding,
        mode: 'all_required',
        requiredRoles: ['owner'],
        stages: [],
        approvals: [{ role: 'owner', status: 'pending' }],
      },
      accountability: {
        finalDecision: 'human_only',
        payloadHash: computeApprovalPayloadHash(personalCredentialGrantPayload(draft)),
        effectBinding,
      },
    });
  });
}

/** Operator scope lookup; runtime broker uses the exact addressed reader instead. */
export function verifyPersonalCredentialGrantBasis(record: PersonalCredentialGrantRecord): boolean {
  try {
    return verifyPersonalCredentialGrantApprovalBasis(
      record,
      loadApprovalRequest(GRANT_APPROVAL_CHANNEL, record.basis!.approval_request_id)
    );
  } catch {
    return false;
  }
}

export function grantPersonalCredentialUse(
  principal: OnboardingAuthorityPrincipal,
  selection: PersonalCredentialGrantSelection,
  approvalId: string
): PersonalCredentialGrantRecord {
  return personalOperator(principal, (owner, nhi) => {
    const draft = prepare(owner, nhi, selection);
    const approval = loadApprovalRequest(GRANT_APPROVAL_CHANNEL, approvalId);
    if (
      !approval ||
      isApprovalRequestExpired(approval) ||
      approval.consumption ||
      approval.applyClaim ||
      approval.applyResult ||
      !personalCredentialApprovalMatches(approval, draft)
    )
      return denied();
    assertApprovalUsable(approval, { consumer: GRANT_APPROVAL_CONSUMER });
    const grantId = newPersonalCredentialGrantId(new Date());
    const consumed = markApprovalConsumed('mission_controller', {
      channel: GRANT_APPROVAL_CHANNEL,
      requestId: approval.id,
      consumer: GRANT_APPROVAL_CONSUMER,
      consumedBy: owner,
      effectRef: grantId,
    });
    if (!consumed.consumption?.consumedAt) return denied();
    // Re-read selection and registration after consumption; any drift burns consent closed.
    if (
      computeApprovalPayloadHash(personalCredentialGrantPayload(prepare(owner, nhi, selection))) !==
      computeApprovalPayloadHash(personalCredentialGrantPayload(draft))
    )
      return denied();
    const at = consumed.consumption.consumedAt;
    const decision = approval.workflow!.approvals.find(
      (entry) =>
        entry.status === 'approved' &&
        entry.decidedByType === 'human' &&
        entry.authenticated === true &&
        entry.approvedBy === owner
    )!;
    const event = auditChain.record({
      agentId: nhi,
      actor: { kind: 'human', id: owner },
      action: 'grant.granted',
      operation: grantId,
      result: 'completed',
      metadata: {
        grant_id: grantId,
        capability: PERSONAL_CREDENTIAL_CAPABILITY,
        approval_request_id: approval.id,
        owner_ref: owner,
      },
    });
    const record: PersonalCredentialGrantRecord = {
      schema_version: 'grant-record.v1',
      grant_id: grantId,
      capability: PERSONAL_CREDENTIAL_CAPABILITY,
      custody: { kind: 'person', ref: owner.slice(5) },
      scope: draft.scope,
      purpose: draft.purpose,
      granted_by: {
        actor_id: owner,
        role: 'member_self',
        assurance: assuranceOfAuthMethod(decision.authMethod)!,
      },
      basis: { approval_request_id: approval.id, approval_channel: GRANT_APPROVAL_CHANNEL },
      granted_at: at,
      expires_at: new Date(Date.parse(at) + draft.ttl_days * 86400_000).toISOString(),
      audit_event_id: event.id,
    };
    const checked = validatePersonalCredentialGrantRecord(record);
    if (!checked.valid)
      throw new Error(`[PERSONAL_CREDENTIAL_GRANT_INVALID] ${checked.errors.join('; ')}`);
    if (!verifyPersonalCredentialGrantBasis(record)) return denied();
    writePersonalCredentialGrantRecord(record);
    return record;
  });
}

export function revokePersonalCredentialGrant(
  principal: OnboardingAuthorityPrincipal,
  grantId: string,
  reason: string
): PersonalCredentialGrantRecord {
  // Human withdrawal cannot depend on the assistant still being active or installed.
  const identity = credentialExecutionIdentity();
  const parent = currentScopeEnvelope();
  if (
    resolveAssumedRole() !== 'sovereign_concierge' ||
    !principal.personalOwner ||
    identity.tenantSlug ||
    identity.personalClaim ||
    getPluginExecutionContext() ||
    (parent &&
      (parent.identity.tier !== 'personal' ||
        parent.identity.tenant_slug ||
        parent.identity.organization_id ||
        !parent.policy.read_tiers.includes('personal') ||
        parent.policy.write_tier !== 'personal'))
  )
    return denied();
  const member = resolveMemberByPrincipal({ source: 'loopback' });
  if (
    !member ||
    member.status !== 'active' ||
    `user:${member.member_id}` !== principal.accountableId
  )
    return denied();
  const owner = principal.accountableId;
  // Private operator ceremony only; never exported as a scope or callback capability.
  const envelopeFor = (nhi?: string) =>
    withScopeEnvOnly(() =>
      mintScopeEnvelope({
        identity: {
          tier: 'personal',
          session_id: `personal-grant-withdraw:${grantId}`,
          ...(nhi ? { nhi_id: nhi } : {}),
        },
        policy: {
          purpose: 'withdraw exact personal credential consent',
          read_tiers: ['public', 'personal'],
          write_tier: 'personal',
          external_egress: 'deny',
        },
        env: {
          ...process.env,
          MISSION_ID: '',
          KYBERION_TASK_ID: '',
          KYBERION_PROJECT_ID: '',
          KYBERION_ORGANIZATION_ID: '',
          KYBERION_TENANT: '',
          KYBERION_TIER: 'personal',
        },
      })
    );
  return withScopeEnvelope(envelopeFor(), () => {
    const record = loadPersonalCredentialGrantRecord(owner, grantId);
    if (
      !record ||
      record.revoked ||
      typeof reason !== 'string' ||
      !reason.trim() ||
      reason.length > 500
    )
      return denied();
    const nhi = record.scope.nhi_id;
    const parsed = parseNhiId(nhi);
    const registered = getAgentIdentity(nhi);
    if (
      !parsed ||
      parsed.legacy ||
      parsed.tenant_slug !== null ||
      parsed.organization_id !== null ||
      !registered ||
      registered.accountable_human_id !== owner ||
      registered.affiliation.tenant_slug
    )
      return denied();
    // Withdraw the independently persisted approval before changing the grant record.
    withScopeEnvelope(envelopeFor(nhi), () =>
      revokeStandingEffectApproval('mission_controller', {
        channel: GRANT_APPROVAL_CHANNEL,
        requestId: record.basis!.approval_request_id,
        revokedBy: owner,
        reason,
        consumer: GRANT_APPROVAL_CONSUMER,
        effectRef: grantId,
      })
    );
    const at = new Date().toISOString();
    const event = auditChain.record({
      agentId: nhi,
      actor: { kind: 'human', id: owner },
      action: 'grant.revoked',
      operation: grantId,
      result: 'completed',
      metadata: { grant_id: grantId, capability: PERSONAL_CREDENTIAL_CAPABILITY, owner_ref: owner },
    });
    const revoked: PersonalCredentialGrantRecord = {
      ...record,
      revoked: { at, by: owner, by_kind: 'human', reason, audit_event_id: event.id },
    };
    writePersonalCredentialGrantRecord(revoked);
    return revoked;
  });
}
