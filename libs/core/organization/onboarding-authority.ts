/** Shared onboarding plan and once-only human-approved charter amendment.
 * Principals come from authenticated adapters, never from request JSON.
 */
import { humanActor } from '../actor.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { isValidMemberId, readMemberProfile } from './member-registry.js';
import type { CharterScope } from '../governance/accountability-charter.js';
import {
  acceptCharter,
  findActiveCharter,
  findLatestCharterForRenewal,
  loadCharterUsage,
  type AcceptCharterInput,
  type CharterPathOptions,
} from '../governance/accountability-charter-registry.js';
import {
  parseExternalOperationGrants,
  type ExternalOperationGrant,
} from '../governance/external-operation-runtime.js';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  recordApprovalApplyResult,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import {
  loadApprovalRequest,
  listApprovalRequests,
  isApprovalRequestExpired,
} from '../governance/approval-store-reader.js';
import { claimApprovalApply } from '../governance/approval-apply-claim.js';
import { validateHumanFinalDecision } from '../governance/approval-human-decision.js';
import { assertApprovalUsable } from '../governance/approval-separation-of-duties.js';
import {
  approvalPresentedDigestMatches,
  computeApprovalPresentedDigest,
} from '../governance/approval-presentation.js';
import { inspectInstalledOnboardingRuntime } from './onboarding-runtime-identity.js';
import { activateProvisionedAgentIdentity } from '../agent/agent-identity.js';
import { withExecutionContext } from '../authority.js';

export const ONBOARDING_AUTHORITY_CHANNEL = 'onboarding-authority';
export interface OnboardingAuthorityPrincipal {
  /** Authenticated actor opening/applying a plan; an agent may only request/apply an approved plan. */
  requesterId: string;
  /** Intended human owner resolved from the real member registry by the adapter. */
  accountableId: string;
  /** Only the verified local operator transport can manage the personal scope. */
  personalOwner: boolean;
  tenantSlugs: 'all' | string[];
}
export interface OnboardingAuthorityInput {
  scope_kind: 'person' | 'organization';
  tenant_slug?: string;
  grants: ExternalOperationGrant[];
  expires_at: string;
  mode: 'grant' | 'revoke';
  renew_existing?: boolean;
}
interface Plan {
  version: 1;
  input: OnboardingAuthorityInput;
  scope: CharterScope;
  accountable: { id: string; display_name: string };
  initiated_by: string;
  base_hash: string;
  renewal: boolean;
  draft: AcceptCharterInput['draft'];
  replaces?: string;
  statement: string;
  runtime?: { agent_id: string; activate: boolean };
}
type Options = CharterPathOptions & { now?: Date };
function deny(message: string): never {
  throw new Error(`[ONBOARDING_AUTHORITY] ${message}`);
}
const hash = (value: unknown) => computeApprovalPayloadHash({ value });
function ownerFor(principal: OnboardingAuthorityPrincipal, scope: CharterScope, options: Options) {
  if (
    !principal.requesterId?.trim() ||
    !principal.accountableId.startsWith('user:') ||
    !isValidMemberId(principal.accountableId.slice(5))
  )
    return deny('authenticated requester and registered accountable human required');
  const member = readMemberProfile(principal.accountableId.slice(5), options);
  if (!member || member.status !== 'active') return deny('accountable member unavailable');
  if (scope.kind === 'person') {
    if (!principal.personalOwner || member.member_id !== 'owner')
      return deny('local personal owner required');
  } else if (
    (principal.tenantSlugs !== 'all' && !principal.tenantSlugs.includes(scope.tenant_slug)) ||
    !member.memberships.some((m) => m.tenant_slug === scope.tenant_slug && m.role === 'owner')
  )
    return deny('tenant owner required');
  return { id: principal.accountableId, display_name: member.display_name };
}
export function onboardingAuthorityScope(raw: unknown): CharterScope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return deny('scope required');
  const value = raw as Record<string, unknown>;
  if (value.scope_kind === 'person' && value.tenant_slug === undefined) return { kind: 'person' };
  if (
    value.scope_kind === 'organization' &&
    typeof value.tenant_slug === 'string' &&
    isValidTenantSlug(value.tenant_slug)
  )
    return { kind: 'organization', tenant_slug: value.tenant_slug };
  return deny('valid actual scope required; personal scope has no tenant');
}
function parseInput(raw: unknown, now: Date): OnboardingAuthorityInput {
  const scope = onboardingAuthorityScope(raw);
  const value = raw as Record<string, unknown>;
  const allowed = ['scope_kind', 'tenant_slug', 'grants', 'expires_at', 'mode', 'renew_existing'];
  if (Object.keys(value).some((k) => !allowed.includes(k))) return deny('unknown plan field');
  const grants = parseExternalOperationGrants(value.grants);
  if (!grants?.length) return deny('choose at least one exact operation and target');
  const expires = typeof value.expires_at === 'string' ? Date.parse(value.expires_at) : NaN;
  if (
    !Number.isFinite(expires) ||
    expires <= now.getTime() ||
    expires > now.getTime() + 365 * 86_400_000
  )
    return deny('expiry must be in the next 365 days');
  if (value.mode !== 'grant' && value.mode !== 'revoke')
    return deny('mode must be grant or revoke');
  if (value.renew_existing !== undefined && typeof value.renew_existing !== 'boolean')
    return deny('renew_existing must be boolean');
  return {
    scope_kind: scope.kind,
    ...(scope.kind === 'organization' ? { tenant_slug: scope.tenant_slug } : {}),
    grants,
    expires_at: new Date(expires).toISOString(),
    mode: value.mode,
    ...(value.renew_existing === true ? { renew_existing: true } : {}),
  };
}
function buildPlan(principal: OnboardingAuthorityPrincipal, raw: unknown, options: Options): Plan {
  const now = options.now ?? new Date();
  const input = parseInput(raw, now);
  const scope = onboardingAuthorityScope(input);
  const accountable = ownerFor(principal, scope, options);
  const installed = inspectInstalledOnboardingRuntime(scope);
  if (scope.kind === 'person' && (!installed.ready || installed.ownerId !== accountable.id))
    return deny('complete installed operator and registered agent identity setup first');
  const runtime =
    installed.ready && installed.ownerId === accountable.id
      ? { agent_id: installed.agentId, activate: !installed.agentActive }
      : undefined;
  const live = findActiveCharter(scope, now, options);
  const active = live ?? findLatestCharterForRenewal(scope, options);
  if (active && !live && !input.renew_existing)
    return deny(
      'expired or retired charter requires explicit renew_existing consent and full limits review'
    );
  if (active && active.accountable.actor !== accountable.id)
    return deny('only the existing accountable human may amend');
  if (active && loadCharterUsage(active, now, options).tripwires_hit.length)
    return deny('charter is stopped; use its governed stop/clear flow before amending');
  if (input.mode === 'revoke' && !active) return deny('no active grant to revoke');
  const base_hash = hash(active);
  const old = active?.envelope.external_operations ?? [];
  const byKey = new Map(old.map((grant) => [hash(grant), grant]));
  for (const grant of input.grants) {
    if (input.mode === 'grant') byKey.set(hash(grant), grant);
    else if (!byKey.delete(hash(grant))) return deny('revoked target is not currently granted');
  }
  const grants = [...byKey.values()].sort((a, b) => hash(a).localeCompare(hash(b)));
  const envelope = active
    ? structuredClone(active.envelope)
    : {
        money: { currency: 'JPY', per_action: 0, per_day: 0, per_month: 0 },
        data_tier: { read: ['public'], write: [] },
        external_effects: {},
        irreversible: 'named_actions_only' as const,
      };
  envelope.external_operations = grants;
  if (input.mode === 'grant' && envelope.irreversible !== 'allow') {
    // Names under a global forbid were inactive, not existing delegated authority.
    const activeNames =
      envelope.irreversible === 'forbid' ? [] : (envelope.irreversible_named_actions ?? []);
    envelope.irreversible = 'named_actions_only';
    envelope.irreversible_named_actions = [
      ...new Set([...activeNames, ...grants.map((g) => g.operation_id)]),
    ];
  }
  if (input.mode === 'grant' && active?.appetite.reputational_class_max === 'A')
    return deny('existing risk appetite does not permit class B work; review charter limits first');
  // An onboarding amendment does not extend existing authority incidentally.
  const expires_at =
    live && Date.parse(live.accountable.expires_at) < Date.parse(input.expires_at)
      ? active.accountable.expires_at
      : input.expires_at;
  const id =
    'chr-onboarding-' + hash({ input, base_hash, accountable: accountable.id }).slice(0, 32);
  const draft: AcceptCharterInput['draft'] = {
    charter_id: id,
    scope,
    accountable: active
      ? { ...active.accountable, expires_at }
      : {
          actor: accountable.id,
          authority_basis: {
            kind: 'owner',
            evidence_ref: `member-registry:${accountable.id}:owner@${scope.kind === 'person' ? 'person' : scope.tenant_slug}`,
          },
          expires_at,
          deputies: [],
        },
    envelope,
    appetite: active
      ? structuredClone(active.appetite)
      : {
          max_loss_per_incident: 0,
          reputational_class_max: 'B',
          blast_radius_max: { recipients: 1, systems: 1 },
          tripwires: ['manual-stop'],
        },
  };
  const statement = [
    `Receiving execution agent requests this delegation: ${runtime?.agent_id ?? 'not installed'}`,
    `Initiated by: ${principal.requesterId}; this is owner consent, not independent substantive review.`,
    `Accountable human: ${accountable.display_name} (${accountable.id})`,
    `Scope: ${scope.kind === 'person' ? 'person (no tenant)' : scope.tenant_slug}`,
    `Change: ${input.mode}`,
    ...input.grants.map((g) => JSON.stringify(g)),
    `Expires: ${expires_at}`,
    ...(active && !live
      ? [
          'Explicit renewal of expired or retired charter, including all displayed retained authority.',
          `Renewed envelope: ${JSON.stringify(envelope)}`,
          `Renewed risk appetite: ${JSON.stringify(draft.appetite)}`,
        ]
      : []),
    `Execution identity: ${runtime?.agent_id ?? 'an assigned, registered organization agent is required'}`,
    ...(runtime?.activate
      ? [
          'This approval also activates this existing provisioned execution identity. Suspended and retired identities cannot be reactivated here.',
        ]
      : []),
    'Standing execution is restricted to verified public-data work. Connection authentication is separate.',
    'Target-scoped operations have reputational class B. URL queries and fragments require individual approval.',
    'Arbitrary browser click/evaluate/submit and GitHub merge are not delegated.',
    'Existing unrelated grants, limits and restrictions are retained; replacement follows the canonical charter lifecycle.',
    `Replaces: ${active?.charter_id ?? 'none'}; existing charter fingerprint: ${base_hash}`,
    'Stopping delegation blocks future admissions; it does not cancel effects already started.',
  ].join('\n');
  return {
    version: 1,
    input,
    scope,
    accountable,
    initiated_by: principal.requesterId,
    base_hash,
    renewal: Boolean(active && !live),
    draft,
    ...(active ? { replaces: active.charter_id } : {}),
    statement,
    ...(runtime ? { runtime } : {}),
  };
}
export function previewOnboardingAuthority(
  principal: OnboardingAuthorityPrincipal,
  raw: unknown,
  options: Options = {}
) {
  const plan = buildPlan(principal, raw, options);
  return {
    ok: true as const,
    statement: plan.statement,
    digest: hash(plan),
    base_hash: plan.base_hash,
  };
}
export function requestOnboardingAuthority(
  principal: OnboardingAuthorityPrincipal,
  raw: unknown,
  expected: { digest: string; base_hash: string },
  options: Options = {}
) {
  const plan = buildPlan(principal, raw, options);
  const digest = hash(plan);
  // The receiving NHI asks for permission; the authenticated initiator is
  // separately frozen in the plan. Never accept a caller-nominated requester.
  const installed = inspectInstalledOnboardingRuntime(plan.scope);
  if (
    !installed.ready ||
    installed.ownerId !== plan.accountable.id ||
    installed.agentId !== plan.runtime?.agent_id
  )
    return deny('verified receiving execution identity required for delegation proposal');
  const requesterId = installed.agentId;
  if (expected.digest !== digest || expected.base_hash !== plan.base_hash)
    return deny('review changed; preview again');
  const correlationId = `onboarding-authority:${digest}`;
  const prior = listApprovalRequests({ storageChannels: [ONBOARDING_AUTHORITY_CHANNEL] }).find(
    (r) => r.correlationId === correlationId && !isApprovalRequestExpired(r)
  );
  if (prior && prior.requestedBy === requesterId && !prior.applyClaim) return requestReceipt(prior);
  const now = options.now ?? new Date();
  const record = createApprovalRequest('mission_controller', {
    channel: ONBOARDING_AUTHORITY_CHANNEL,
    threadTs: now.toISOString(),
    correlationId,
    requestedBy: requesterId,
    requestedByContext: {
      surface: 'system',
      actorId: requesterId,
      actorRole: 'delegation-recipient-proposal-service',
    },
    draft: {
      title: 'Onboarding action authority',
      summary: `${plan.input.mode}: ${plan.input.grants.map((g) => g.operation_id).join(', ')}`,
      details: plan.statement,
      severity: 'high',
    },
    sourceText: JSON.stringify(plan),
    expiresAt: new Date(
      Math.min(Date.parse(plan.draft.accountable.expires_at), now.getTime() + 86_400_000)
    ).toISOString(),
    accountability: { finalDecision: 'human_only', payloadHash: digest, effectBinding: digest },
    scope:
      plan.scope.kind === 'person'
        ? { tier: 'personal', scope_kind: 'system' }
        : { tier: 'confidential', tenant_slug: plan.scope.tenant_slug },
  });
  return requestReceipt(record);
}
function requestReceipt(record: ApprovalRequestRecord) {
  return {
    ok: true as const,
    request_id: record.id,
    status: record.status,
    approval_url: `/?approvalId=${encodeURIComponent(record.id)}&approvalChannel=${ONBOARDING_AUTHORITY_CHANNEL}`,
  };
}
function readPlan(
  principal: OnboardingAuthorityPrincipal,
  scope: CharterScope,
  id: string,
  options: Options
) {
  const record = loadApprovalRequest(ONBOARDING_AUTHORITY_CHANNEL, id);
  if (!record?.sourceText || record.channel !== ONBOARDING_AUTHORITY_CHANNEL)
    return deny('request not found');
  let plan: Plan;
  try {
    plan = JSON.parse(record.sourceText);
  } catch {
    return deny('invalid stored plan');
  }
  if (plan.version !== 1 || hash(plan.scope) !== hash(scope))
    return deny('request outside selected scope');
  if (
    scope.kind === 'person'
      ? record.scope?.tier !== 'personal' || record.scope?.tenant_slug !== undefined
      : record.scope?.tier !== 'confidential' || record.scope?.tenant_slug !== scope.tenant_slug
  )
    return deny('approval storage scope does not match plan');
  const owner = ownerFor(principal, scope, options);
  if (
    plan.accountable.id !== owner.id ||
    !plan.initiated_by ||
    !plan.runtime?.agent_id ||
    record.requestedBy !== plan.runtime.agent_id ||
    record.requestedByContext?.actorId !== plan.runtime.agent_id ||
    record.accountability?.payloadHash !== hash(plan) ||
    record.accountability.effectBinding !== hash(plan) ||
    record.accountability.finalDecision !== 'human_only'
  )
    return deny('stored plan binding is invalid');
  return { record, plan };
}
function assertHumanApproved(record: ApprovalRequestRecord, plan: Plan) {
  if (
    record.status !== 'approved' ||
    isApprovalRequestExpired(record) ||
    record.decidedBy !== plan.accountable.id
  )
    return deny('current approval by the accountable human required');
  assertApprovalUsable(record, { consumer: 'onboarding_authority' });
  if (
    !record.verifiedPresentedDigest ||
    !approvalPresentedDigestMatches(record, record.verifiedPresentedDigest)
  )
    return deny('approved presentation is missing or changed');
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
export function onboardingAuthorityRequestStatus(
  principal: OnboardingAuthorityPrincipal,
  scope: CharterScope,
  id: string,
  options: Options = {}
) {
  const { record, plan } = readPlan(principal, scope, id, options);
  let can_apply = false;
  try {
    assertHumanApproved(record, plan);
    can_apply = !record.applyClaim && !record.applyResult;
  } catch {
    /* status is visible; no authority is inferred */
  }
  return {
    ...requestReceipt(record),
    statement: plan.statement,
    presented_digest: computeApprovalPresentedDigest(record),
    approval_channel: ONBOARDING_AUTHORITY_CHANNEL,
    status:
      record.applyResult?.result === 'success'
        ? 'applied'
        : record.applyClaim
          ? 'reconciliation_required'
          : isApprovalRequestExpired(record)
            ? 'expired'
            : record.status,
    ...(record.applyClaim && record.applyResult?.result !== 'success'
      ? {
          recovery:
            'Application started without a confirmed success receipt. Inspect the charter and execution identity before creating another request; do not retry this claim.',
        }
      : {}),
    can_apply,
  };
}
export function applyOnboardingAuthority(
  principal: OnboardingAuthorityPrincipal,
  scope: CharterScope,
  id: string,
  options: Options = {}
) {
  const { record, plan } = readPlan(principal, scope, id, options);
  assertHumanApproved(record, plan);
  const live = findActiveCharter(scope, options.now ?? new Date(), options);
  const current = live ?? findLatestCharterForRenewal(scope, options);
  if (Boolean(current && !live) !== plan.renewal)
    return deny('charter lifecycle changed after review; preview explicit renewal again');
  if (hash(current) !== plan.base_hash)
    return deny('charter changed after review; request a new plan');
  if (current && loadCharterUsage(current, options.now ?? new Date(), options).tripwires_hit.length)
    return deny('charter stopped after review');
  const installed = inspectInstalledOnboardingRuntime(scope);
  if (
    plan.runtime &&
    (!installed.ready ||
      installed.ownerId !== plan.accountable.id ||
      installed.agentId !== plan.runtime.agent_id)
  )
    return deny('reviewed execution identity changed or was suspended');
  const claimed = claimApprovalApply('mission_controller', {
    channel: record.channel,
    requestId: record.id,
    appliedBy: principal.requesterId,
    expectedRecordHash: computeApprovalPayloadHash({ record }),
  });
  // A started claim is never retried automatically if acceptance or result persistence fails.
  const charter = acceptCharter(
    {
      draft: plan.draft,
      statement: plan.statement,
      acceptedBy: humanActor(plan.accountable.id.slice(5), plan.accountable.display_name),
      validation: { holder_role: 'owner' },
      expected_lifecycle: plan.renewal ? 'renewal' : plan.replaces ? 'active' : 'new',
      now: options.now ?? new Date(),
      ...(plan.replaces ? { replaces: plan.replaces } : {}),
    },
    options
  );
  if (plan.runtime?.activate) {
    // The exact existing identity and activation were part of the signed plan.
    withExecutionContext('mission_controller', () =>
      activateProvisionedAgentIdentity(plan.runtime!.agent_id)
    );
  }
  recordApprovalApplyResult('mission_controller', {
    channel: record.channel,
    requestId: record.id,
    claimId: claimed.applyClaim.claimId,
    applyResult: {
      result: 'success',
      appliedAt: (options.now ?? new Date()).toISOString(),
      appliedBy: principal.requesterId,
    },
  });
  return {
    ok: true as const,
    charter_id: charter.charter_id,
    expires_at: charter.accountable.expires_at,
  };
}
export function readOnboardingAuthority(
  principal: OnboardingAuthorityPrincipal,
  scope: CharterScope,
  options: Options = {}
) {
  const accountable = ownerFor(principal, scope, options);
  const charter = findActiveCharter(scope, options.now ?? new Date(), options);
  const renewal = charter ? null : findLatestCharterForRenewal(scope, options);
  const pending_requests = listApprovalRequests({ storageChannels: [ONBOARDING_AUTHORITY_CHANNEL] })
    .flatMap((record) => {
      try {
        return [onboardingAuthorityRequestStatus(principal, scope, record.id, options)];
      } catch {
        return [];
      }
    })
    .filter((record) => !['applied', 'rejected', 'expired'].includes(record.status));
  const runtime = inspectInstalledOnboardingRuntime(scope);
  return {
    ok: true as const,
    scope,
    accountable,
    pending_requests,
    renewal_required: Boolean(renewal),
    renewal: renewal
      ? { id: renewal.charter_id, envelope: renewal.envelope, appetite: renewal.appetite }
      : null,
    runtime:
      runtime.ready && runtime.ownerId === accountable.id
        ? {
            ready: runtime.agentActive,
            agent_id: runtime.agentId,
            reason: runtime.agentActive ? 'ready' : 'activation_requires_approval',
          }
        : {
            ready: false,
            reason: 'reason' in runtime ? runtime.reason : 'agent_accountability_mismatch',
          },
    charter: charter
      ? {
          id: charter.charter_id,
          expires_at: charter.accountable.expires_at,
          grants: charter.envelope.external_operations ?? [],
          stopped:
            loadCharterUsage(charter, options.now ?? new Date(), options).tripwires_hit.length > 0,
        }
      : null,
  };
}
