/** Existing-account registration. Values enter only after exact human approval. */
import { withAccountProvisionAdmission } from '../foundation/account-provision-admission.js';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  loadApprovalRequest,
  listApprovalRequests,
  claimApprovalApply,
  recordApprovalApplyResult,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { isApprovalRequestExpired } from '../governance/approval-store-reader.js';
import { assertApprovalUsable } from '../governance/approval-separation-of-duties.js';
import { validateHumanFinalDecision } from '../governance/approval-human-decision.js';
import {
  approvalPresentedDigestMatches,
  computeApprovalPresentedDigest,
} from '../governance/approval-presentation.js';
import { withAuthenticatedPersonalApprovals } from '../governance/authenticated-personal-approvals.js';
import { readMemberProfile, isValidMemberId } from '../organization/member-registry.js';
import { inspectInstalledOnboardingRuntime } from '../organization/onboarding-runtime-identity.js';
import type { OnboardingAuthorityPrincipal } from '../organization/onboarding-authority.js';
import { loadServiceBindingRecord } from '../service/service-binding-reader.js';
import { validateBindingOwner } from '../service/service-binding-owner.js';
import { getServiceEndpointRecord } from '../service/service-endpoint-registry.js';
import { withLock } from '../foundation/lock-utils.js';
import { getPluginExecutionContext } from '../shell/sandbox-policy.js';
import { resolveAssumedRole } from '../authority.js';
import { credentialExecutionIdentity } from '../foundation/credential-binding.js';
import {
  loadLocalAccountRegistration,
  storeLocalAccountRegistration,
  storeLocalAccountMaterial,
  type LocalAccountMaterialIdentity,
} from './secret-guard.js';
import { describeAccountBroker, provisionAccountMaterial } from './account-broker.js';

export const ACCOUNT_INTRODUCTION_CHANNEL = 'account-introduction';

const hash = (value: unknown) => computeApprovalPayloadHash({ value });
const denied = (reason = 'registration unavailable'): never => {
  throw new Error(`[ACCOUNT_INTRODUCTION] ${reason}`);
};
interface Plan {
  version: 1;
  binding_id: string;
  service_id: string;
  owner_kind: 'person' | 'organization';
  owner_ref: string;
  tenant_slug?: string;
  secret_refs: string[];
  expected_generation: string | null;
  binding_hash: string;
  broker_id: string | null;
  initiated_by: string;
  accountable_id: string;
  agent_id: string;
  statement: string;
}
function identity(plan: Plan): LocalAccountMaterialIdentity {
  return {
    serviceId: plan.service_id,
    bindingId: plan.binding_id,
    ownerKind: plan.owner_kind,
    ownerRef: plan.owner_ref,
    ...(plan.tenant_slug ? { tenantSlug: plan.tenant_slug } : {}),
  };
}
function selected(principal: OnboardingAuthorityPrincipal, bindingId: string) {
  if (
    getPluginExecutionContext() ||
    resolveAssumedRole() !== 'sovereign_concierge' ||
    credentialExecutionIdentity().tenantSlug ||
    credentialExecutionIdentity().personalClaim ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(bindingId) ||
    !principal.requesterId?.trim() ||
    !principal.accountableId?.startsWith('user:') ||
    !isValidMemberId(principal.accountableId.slice(5))
  )
    denied();
  const binding = loadServiceBindingRecord(bindingId);
  const member = readMemberProfile(principal.accountableId.slice(5));
  if (
    !binding ||
    validateBindingOwner(binding).length ||
    !member ||
    member.status !== 'active' ||
    !binding.owner_ref ||
    !['person', 'organization'].includes(binding.owner_kind ?? '') ||
    !binding.service_id ||
    binding.auth_mode !== 'secret-guard'
  )
    return denied();
  if (binding.owner_kind === 'person') {
    if (
      !principal.personalOwner ||
      member.member_id !== 'owner' ||
      binding.owner_ref !== principal.accountableId
    )
      denied();
  } else if (
    !binding.tenant_slug ||
    (principal.tenantSlugs !== 'all' && !principal.tenantSlugs.includes(binding.tenant_slug)) ||
    !member.memberships.some((m) => m.tenant_slug === binding.tenant_slug && m.role === 'owner')
  )
    denied();
  const service = getServiceEndpointRecord(binding.service_id);
  const allowed =
    service?.credential_suffixes?.accessToken?.map(
      (s) => `${binding.service_id!.toUpperCase()}_${s}`
    ) ?? [];
  if (
    !binding.secret_refs.length ||
    binding.secret_refs.length > 16 ||
    new Set(binding.secret_refs).size !== binding.secret_refs.length ||
    binding.secret_refs.some((ref) => !allowed.includes(ref))
  )
    denied('unsupported account token references');
  // Registration is an installed operator action, not a tenant execution.
  // Tenant ownership above remains independent of the requesting local NHI.
  const installed = inspectInstalledOnboardingRuntime({ kind: 'person' });
  if (!installed.ready || installed.ownerId !== principal.accountableId)
    return denied('installed owner identity required');
  return { binding, installed };
}
function approvalScope<T>(principal: OnboardingAuthorityPrincipal, plan: Plan, run: () => T): T {
  if (plan.owner_kind !== 'person') return run();
  const result = withAuthenticatedPersonalApprovals(principal, () => ({ value: run() }));
  if (!result) return denied('personal approval scope unavailable');
  return result.value;
}
function prepare(principal: OnboardingAuthorityPrincipal, bindingId: string): Plan {
  const { binding, installed } = selected(principal, bindingId);
  const plan: Plan = {
    version: 1,
    binding_id: bindingId,
    service_id: binding.service_id!,
    owner_kind: binding.owner_kind as Plan['owner_kind'],
    owner_ref: binding.owner_ref!,
    ...(binding.tenant_slug ? { tenant_slug: binding.tenant_slug } : {}),
    secret_refs: [...binding.secret_refs].sort(),
    expected_generation: null,
    binding_hash: hash(binding),
    broker_id:
      binding.owner_kind === 'organization' ? (describeAccountBroker()?.brokerId ?? null) : null,
    initiated_by: principal.requesterId,
    accountable_id: principal.accountableId,
    agent_id: installed.agentId,
    statement: '',
  };
  if (plan.owner_kind === 'organization' && !plan.broker_id)
    denied('configured account broker writer required');
  const state = loadLocalAccountRegistration(identity(plan));
  const incomplete = approvalScope(principal, plan, () =>
    listApprovalRequests({ storageChannels: [ACCOUNT_INTRODUCTION_CHANNEL] }).some(
      (record) =>
        accountIntroductionApprovalBindingId(record) === bindingId &&
        record.applyClaim &&
        record.applyResult?.result !== 'success'
    )
  );
  if (state.pendingApprovalId || incomplete) denied('recovery_required');
  plan.expected_generation = state.generation;
  plan.statement = [
    `Register tokens for existing connection ${plan.binding_id} (${plan.service_id}).`,
    `Owner: ${plan.owner_kind} ${plan.owner_ref}. Approver: ${plan.accountable_id}.`,
    `Registration requester: ${plan.agent_id} (installed local assistant, no tenant execution authority).`,
    `References: ${plan.secret_refs.join(', ')}. Previous generation: ${state.generation ?? 'none'}.`,
    plan.broker_id
      ? `Provision the configured organization broker ${plan.broker_id}.`
      : 'Encrypted local storage only. Personal runtime use is not enabled.',
    'This does not change ownership, allowed operations, grants or approval policy.',
  ].join('\n');
  return plan;
}
export function previewAccountIntroduction(
  principal: OnboardingAuthorityPrincipal,
  bindingId: string
) {
  const plan = prepare(principal, bindingId);
  return { ...plan, digest: hash(plan) };
}
function receipt(record: ApprovalRequestRecord) {
  return {
    approval_id: record.id,
    approval_channel: ACCOUNT_INTRODUCTION_CHANNEL,
    status: record.status,
    approval_url: `/?approvalId=${encodeURIComponent(record.id)}&approvalChannel=${ACCOUNT_INTRODUCTION_CHANNEL}`,
  };
}
export function proposeAccountIntroduction(
  principal: OnboardingAuthorityPrincipal,
  bindingId: string,
  expected: { digest: string; expected_generation: string | null }
) {
  const plan = prepare(principal, bindingId);
  const digest = hash(plan);
  if (expected.digest !== digest || expected.expected_generation !== plan.expected_generation)
    denied('preview changed');
  const now = new Date();
  return receipt(
    approvalScope(principal, plan, () =>
      createApprovalRequest('mission_controller', {
        channel: ACCOUNT_INTRODUCTION_CHANNEL,
        threadTs: now.toISOString(),
        correlationId: `account-introduction:${digest}`,
        requestedBy: plan.agent_id,
        requestedByContext: {
          surface: 'system',
          actorId: plan.agent_id,
          actorRole: 'account-introduction',
        },
        draft: {
          title: 'Register account tokens',
          summary: `Connection ${plan.binding_id}`,
          details: plan.statement,
          severity: 'high',
        },
        sourceText: JSON.stringify(plan),
        expiresAt: new Date(now.getTime() + 3600_000).toISOString(),
        accountability: { finalDecision: 'human_only', payloadHash: digest, effectBinding: digest },
        scope:
          plan.owner_kind === 'person'
            ? { tier: 'personal', scope_kind: 'system', nhi_id: plan.agent_id }
            : { tier: 'confidential', tenant_slug: plan.tenant_slug },
      })
    )
  );
}
export function accountIntroductionApprovalBindingId(record: ApprovalRequestRecord): string | null {
  if (record.channel !== ACCOUNT_INTRODUCTION_CHANNEL || !record.sourceText) return null;
  try {
    const plan: unknown = JSON.parse(record.sourceText);
    if (
      !plan ||
      typeof plan !== 'object' ||
      !('binding_id' in plan) ||
      typeof plan.binding_id !== 'string'
    )
      return null;
    return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(plan.binding_id) ? plan.binding_id : null;
  } catch {
    return null;
  }
}
function readPlan(
  principal: OnboardingAuthorityPrincipal,
  bindingId: string,
  approvalId: string,
  mode: 'continuation' | 'owner-review' = 'continuation'
) {
  const { binding, installed } = selected(principal, bindingId);
  // Scope derives from the existing authorized binding; an untrusted approval cannot select it.
  const scopePlan = { owner_kind: binding.owner_kind } as Plan;
  const record = approvalScope(principal, scopePlan, () =>
    loadApprovalRequest(ACCOUNT_INTRODUCTION_CHANNEL, approvalId)
  );
  if (!record?.sourceText || accountIntroductionApprovalBindingId(record) !== bindingId)
    return denied();
  let plan: Plan;
  try {
    plan = JSON.parse(record.sourceText) as Plan;
  } catch {
    return denied();
  }
  if (
    plan.version !== 1 ||
    plan.accountable_id !== principal.accountableId ||
    typeof plan.initiated_by !== 'string' ||
    !plan.initiated_by.trim() ||
    (mode === 'continuation' && plan.initiated_by !== principal.requesterId) ||
    plan.agent_id !== installed.agentId ||
    plan.owner_kind !== binding.owner_kind ||
    plan.owner_ref !== binding.owner_ref ||
    plan.tenant_slug !== binding.tenant_slug ||
    plan.service_id !== binding.service_id ||
    record.requestedBy !== plan.agent_id ||
    record.requestedByContext?.actorId !== plan.agent_id ||
    record.accountability?.finalDecision !== 'human_only' ||
    record.accountability.payloadHash !== hash(plan) ||
    record.accountability.effectBinding !== hash(plan) ||
    (plan.owner_kind === 'person'
      ? record.scope?.tier !== 'personal' ||
        record.scope.tenant_slug !== undefined ||
        record.scope.nhi_id !== plan.agent_id
      : record.scope?.tier !== 'confidential' || record.scope.tenant_slug !== plan.tenant_slug)
  )
    return denied();
  return { record, plan, binding };
}

/**
 * Authenticated human approval surfaces only. The accountable human may review
 * an agent-initiated request; this does not transfer its continuation or apply
 * authority. Decision authentication and the presented digest remain enforced
 * by the existing approval surface/store.
 */
export function reviewAccountIntroductionApproval(
  principal: OnboardingAuthorityPrincipal,
  bindingId: string,
  approvalId: string
) {
  if (principal.requesterId !== principal.accountableId)
    denied('accountable human review required');
  const { record, plan } = readPlan(principal, bindingId, approvalId, 'owner-review');
  return {
    ok: true as const,
    ...receipt(record),
    statement: plan.statement,
    presented_digest: computeApprovalPresentedDigest(record),
  };
}
function approved(record: ApprovalRequestRecord, plan: Plan) {
  if (
    record.status !== 'approved' ||
    isApprovalRequestExpired(record) ||
    record.decidedBy !== plan.accountable_id ||
    !record.verifiedPresentedDigest ||
    !approvalPresentedDigestMatches(record, record.verifiedPresentedDigest)
  )
    denied('human approval required');
  assertApprovalUsable(record, { consumer: 'account_introduction' });
  validateHumanFinalDecision({
    accountability: record.accountability,
    decidedByType: record.decidedByType,
    authenticated: record.authenticated,
    authMethod: record.decidedAuthMethod,
    payloadHash: record.accountability?.payloadHash,
    effectBinding: record.accountability?.effectBinding,
    mode: 'enforce',
    channel: record.channel,
  });
}
function unchanged(principal: OnboardingAuthorityPrincipal, plan: Plan) {
  const { binding, installed } = selected(principal, plan.binding_id);
  if (
    hash(binding) !== plan.binding_hash ||
    installed.agentId !== plan.agent_id ||
    hash([...binding.secret_refs].sort()) !== hash(plan.secret_refs) ||
    (plan.owner_kind === 'organization' && describeAccountBroker()?.brokerId !== plan.broker_id)
  )
    denied('review changed');
}
export function accountIntroductionStatus(
  principal: OnboardingAuthorityPrincipal,
  bindingId: string,
  approvalId: string
) {
  const { record, plan } = readPlan(principal, bindingId, approvalId);
  const state = loadLocalAccountRegistration(identity(plan));
  let can_apply = false;
  try {
    approved(record, plan);
    unchanged(principal, plan);
    can_apply =
      !record.applyClaim &&
      !record.applyResult &&
      !state.pendingApprovalId &&
      state.generation === plan.expected_generation;
  } catch {
    /* A pending request is visible but is not executable. */
  }
  return {
    ok: true as const,
    ...receipt(record),
    statement: plan.statement,
    presented_digest: computeApprovalPresentedDigest(record),
    min_assurance: record.accountability?.min_assurance ?? 'A2',
    can_apply,
    recovery_required: Boolean(
      state.pendingApprovalId || (record.applyClaim && record.applyResult?.result !== 'success')
    ),
    status:
      state.pendingApprovalId || (record.applyClaim && record.applyResult?.result !== 'success')
        ? 'recovery_required'
        : record.applyResult?.result === 'success'
          ? 'applied'
          : isApprovalRequestExpired(record)
            ? 'expired'
            : record.status,
  };
}
export async function applyAccountIntroduction(
  principal: OnboardingAuthorityPrincipal,
  bindingId: string,
  input: { approval_id: string; material: Record<string, string> }
) {
  return withLock(`account-introduction:${bindingId}`, async () => {
    const { record, plan } = readPlan(principal, bindingId, input.approval_id);
    approved(record, plan);
    unchanged(principal, plan);
    const address = identity(plan);
    const state = loadLocalAccountRegistration(address);
    if (state.pendingApprovalId || record.applyClaim || record.applyResult)
      denied('recovery_required');
    if (state.generation !== plan.expected_generation) denied('generation_conflict');
    const material = input.material;
    if (
      !material ||
      typeof material !== 'object' ||
      Array.isArray(material) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(material)) ||
      hash(Object.keys(material).sort()) !== hash(plan.secret_refs) ||
      Object.values(material).some(
        (value) =>
          typeof value !== 'string' ||
          !value ||
          Buffer.byteLength(value, 'utf8') > 16384 ||
          value.includes('\0')
      )
    )
      denied('invalid token material');
    // Freeze a copy before the first await; caller mutation must not change approved fields.
    const values = Object.freeze({ ...material });
    const claimed = approvalScope(principal, plan, () =>
      claimApprovalApply('mission_controller', {
        channel: record.channel,
        requestId: record.id,
        appliedBy: principal.requesterId,
        expectedRecordHash: computeApprovalPayloadHash({ record }),
      })
    );
    try {
      storeLocalAccountRegistration(address, { ...state, pendingApprovalId: record.id });
      const reference = storeLocalAccountMaterial(address, values);
      if (plan.owner_kind === 'organization') {
        const provisionInput = Object.freeze({
          brokerId: plan.broker_id!,
          reference: Object.freeze(reference),
          expectedGeneration: plan.expected_generation,
          material: values,
        });
        await withAccountProvisionAdmission(provisionInput, () =>
          provisionAccountMaterial(provisionInput)
        );
      }
      unchanged(principal, plan);
      approved(readPlan(principal, bindingId, record.id).record, plan);
      const pending = loadLocalAccountRegistration(address);
      if (
        pending.pendingApprovalId !== record.id ||
        pending.generation !== plan.expected_generation
      )
        denied('registration changed');
      storeLocalAccountRegistration(address, {
        generation: reference.generation,
        pendingApprovalId: record.id,
      });
      approvalScope(principal, plan, () =>
        recordApprovalApplyResult('mission_controller', {
          channel: record.channel,
          requestId: record.id,
          claimId: claimed.applyClaim.claimId,
          applyResult: {
            result: 'success',
            appliedAt: new Date().toISOString(),
            appliedBy: principal.requesterId,
          },
        })
      );
      storeLocalAccountRegistration(address, { generation: reference.generation });
      return { ok: true as const, status: 'applied' as const, generation: reference.generation };
    } catch {
      return denied('recovery_required');
    }
  });
}
