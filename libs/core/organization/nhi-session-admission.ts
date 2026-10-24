/** Approval-mediated NHI session admission.
 *
 * A signed-in member session is admitted to execute under an organization NHI
 * through one human-approved ceremony. The ceremony ends in a governed
 * `instance_bound` journal event carrying a random `session_id` and a bounded
 * `expires_at`; `instance_released` revokes it. Admission is then *consumed*
 * by `inspectInstalledOnboardingRuntime`: an org-scoped delegated external
 * operation is admitted only when the process claims an nhi_id whose identity
 * record holds a live binding with the same session token (KYBERION_NHI_ACTOR
 * + KYBERION_NHI_SESSION). The env pair selects a governed record — it can
 * never create one — so bare env spoofing fails closed.
 *
 * Principals come from authenticated adapters, never from request JSON —
 * mirrors onboarding-authority.ts.
 */
import { randomUUID } from 'node:crypto';
import { isValidTenantSlug } from '../entity-scope.js';
import { isValidMemberId, readMemberProfile } from './member-registry.js';
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
import { approvalPresentedDigestMatches } from '../governance/approval-presentation.js';
import {
  bindRuntimeInstance,
  getAgentIdentity,
  listAgentIdentities,
  parseNhiId,
  releaseRuntimeInstance,
  type AgentIdentityRecord,
  type AgentRuntimeInstanceBinding,
} from '../agent/agent-identity.js';
import { withExecutionContext } from '../authority.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import type { CharterPathOptions } from '../governance/accountability-charter-registry.js';

export const NHI_SESSION_ADMISSION_CHANNEL = 'nhi-session-admission';
/** Claimed session token selecting a governed runtime-instance binding. */
export const NHI_SESSION_ENV = 'KYBERION_NHI_SESSION';
export const ADMISSION_SESSION_PREFIX = 'kns1.';
export const ADMISSION_INSTANCE_PREFIX = 'nhi-session:';
export const DEFAULT_ADMISSION_TTL_SECONDS = 8 * 3600;
export const MAX_ADMISSION_TTL_SECONDS = 7 * 24 * 3600;

export interface NhiSessionAdmissionPrincipal {
  /** Authenticated actor driving the CLI; never taken from plan JSON. */
  requesterId: string;
  /** Accountable human resolved from the member registry by the adapter. */
  accountableId: string;
  tenantSlugs: 'all' | string[];
}

export interface NhiSessionAdmissionPlan {
  version: 1;
  kind: 'nhi_session_admission';
  nhi_id: string;
  tenant_slug: string;
  accountable_id: string;
  initiated_by: string;
  ttl_seconds: number;
  expires_at: string;
  requested_at: string;
}

interface Options extends CharterPathOptions {
  now?: Date;
}

function deny(message: string): never {
  throw new Error(`[NHI_SESSION_ADMISSION] ${message}`);
}
const hash = (value: unknown) => computeApprovalPayloadHash({ value });

function assertOrgAdmissionTarget(
  principal: NhiSessionAdmissionPrincipal,
  tenantSlug: string,
  nhiId: string,
  options: Options,
  checks: { lifecycle?: boolean } = {}
): { owner: { id: string }; agent: AgentIdentityRecord } {
  if (!isValidTenantSlug(tenantSlug)) deny('valid tenant slug required');
  if (
    !principal.requesterId?.trim() ||
    !principal.accountableId.startsWith('user:') ||
    !isValidMemberId(principal.accountableId.slice(5))
  )
    deny('authenticated requester and registered accountable human required');
  const member = readMemberProfile(principal.accountableId.slice(5), options);
  if (!member || member.status !== 'active') deny('accountable member unavailable');
  if (
    (principal.tenantSlugs !== 'all' && !principal.tenantSlugs.includes(tenantSlug)) ||
    !member.memberships.some((m) => m.tenant_slug === tenantSlug && m.role === 'owner')
  )
    deny('tenant owner required');
  if (!parseNhiId(nhiId)) deny('canonical nhi_id required');
  const agent = getAgentIdentity(nhiId);
  if (!agent) deny('NHI is not registered');
  if (checks.lifecycle !== false && ['suspended', 'retired'].includes(agent.lifecycle_status))
    deny('NHI is suspended or retired');
  if (agent.accountable_human_id !== principal.accountableId)
    deny('NHI accountable human differs from the admitting member');
  // Fail closed on organization scope: the admitted NHI must belong to the
  // tenant's organization — never let an ambient other-tenant identity serve.
  if (
    agent.affiliation.tenant_slug !== tenantSlug &&
    agent.affiliation.organization_id !== tenantSlug
  )
    deny('NHI is not affiliated with this tenant');
  return { owner: { id: principal.accountableId }, agent };
}

export function requestNhiSessionAdmission(
  principal: NhiSessionAdmissionPrincipal,
  input: { nhi_id: string; tenant_slug: string; ttl_seconds?: number },
  options: Options = {}
) {
  const ttl = input.ttl_seconds ?? DEFAULT_ADMISSION_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_ADMISSION_TTL_SECONDS)
    deny(`ttl_seconds must be within 1..${MAX_ADMISSION_TTL_SECONDS}`);
  assertOrgAdmissionTarget(principal, input.tenant_slug, input.nhi_id, options);
  const now = options.now ?? new Date();
  const plan: NhiSessionAdmissionPlan = {
    version: 1,
    kind: 'nhi_session_admission',
    nhi_id: input.nhi_id,
    tenant_slug: input.tenant_slug,
    accountable_id: principal.accountableId,
    initiated_by: principal.requesterId,
    ttl_seconds: ttl,
    expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
    requested_at: now.toISOString(),
  };
  const digest = hash(plan);
  const correlationId = `nhi-session-admission:${digest}`;
  const prior = listApprovalRequests({ storageChannels: [NHI_SESSION_ADMISSION_CHANNEL] }).find(
    (r) => r.correlationId === correlationId && !isApprovalRequestExpired(r)
  );
  if (
    prior &&
    prior.requestedBy === input.nhi_id &&
    ['pending', 'approved'].includes(prior.status) &&
    !prior.applyClaim
  )
    return requestReceipt(prior, plan);
  const record = createApprovalRequest('mission_controller', {
    channel: NHI_SESSION_ADMISSION_CHANNEL,
    threadTs: now.toISOString(),
    correlationId,
    requestedBy: input.nhi_id,
    requestedByContext: {
      surface: 'system',
      actorId: input.nhi_id,
      actorRole: 'nhi-session-admission-service',
    },
    draft: {
      title: 'NHI session admission',
      summary: `Admit this operator session to act as ${input.nhi_id} for tenant ${input.tenant_slug} until ${plan.expires_at}`,
      details: `Session binding: ${input.nhi_id} · tenant ${input.tenant_slug} · ttl ${ttl}s · accountable ${plan.accountable_id}`,
      severity: 'high',
    },
    sourceText: JSON.stringify(plan),
    expiresAt: new Date(
      Math.min(Date.parse(plan.expires_at), now.getTime() + 86_400_000)
    ).toISOString(),
    accountability: { finalDecision: 'human_only', payloadHash: digest, effectBinding: digest },
    scope: { tier: 'confidential', tenant_slug: input.tenant_slug },
  });
  return requestReceipt(record, plan);
}

function requestReceipt(record: ApprovalRequestRecord, plan: NhiSessionAdmissionPlan) {
  return {
    ok: true as const,
    request_id: record.id,
    status: record.status,
    plan,
    digest: hash(plan),
    approval_url: `/?approvalId=${encodeURIComponent(record.id)}&approvalChannel=${NHI_SESSION_ADMISSION_CHANNEL}`,
  };
}

function readPlan(
  principal: NhiSessionAdmissionPrincipal,
  tenantSlug: string,
  id: string,
  options: Options
): { record: ApprovalRequestRecord; plan: NhiSessionAdmissionPlan } {
  const record = loadApprovalRequest(NHI_SESSION_ADMISSION_CHANNEL, id);
  if (!record?.sourceText || record.channel !== NHI_SESSION_ADMISSION_CHANNEL)
    deny('request not found');
  let plan: NhiSessionAdmissionPlan;
  try {
    plan = JSON.parse(record.sourceText);
  } catch {
    deny('invalid stored plan');
  }
  if (
    plan.version !== 1 ||
    plan.kind !== 'nhi_session_admission' ||
    plan.tenant_slug !== tenantSlug
  )
    deny('request outside selected tenant scope');
  if (record.scope?.tier !== 'confidential' || record.scope?.tenant_slug !== plan.tenant_slug)
    deny('approval storage scope does not match plan');
  assertOrgAdmissionTarget(principal, plan.tenant_slug, plan.nhi_id, options);
  if (
    plan.accountable_id !== principal.accountableId ||
    !plan.initiated_by ||
    record.requestedBy !== plan.nhi_id ||
    record.requestedByContext?.actorId !== plan.nhi_id ||
    record.accountability?.payloadHash !== hash(plan) ||
    record.accountability.effectBinding !== hash(plan) ||
    record.accountability.finalDecision !== 'human_only'
  )
    deny('stored plan binding is invalid');
  return { record, plan };
}

function assertHumanApproved(record: ApprovalRequestRecord, plan: NhiSessionAdmissionPlan) {
  if (
    record.status !== 'approved' ||
    isApprovalRequestExpired(record) ||
    record.decidedBy !== plan.accountable_id ||
    record.decidedByIdentitySource === 'caller_supplied' ||
    Boolean(record.decidedInAgentSession)
  )
    deny('current approval by the accountable human required');
  assertApprovalUsable(record, { consumer: 'nhi_session_admission' });
  if (
    !record.verifiedPresentedDigest ||
    !approvalPresentedDigestMatches(record, record.verifiedPresentedDigest)
  )
    deny('approved presentation is missing or changed');
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

export function nhiSessionAdmissionStatus(
  principal: NhiSessionAdmissionPrincipal,
  tenantSlug: string,
  id: string,
  options: Options = {}
) {
  const { record, plan } = readPlan(principal, tenantSlug, id, options);
  let can_apply = false;
  try {
    assertHumanApproved(record, plan);
    can_apply = !record.applyClaim && !record.applyResult;
  } catch {
    /* status is visible; no authority is inferred */
  }
  return {
    ...requestReceipt(record, plan),
    status:
      record.applyResult?.result === 'success'
        ? 'applied'
        : record.applyClaim
          ? 'reconciliation_required'
          : isApprovalRequestExpired(record)
            ? 'expired'
            : record.status,
    can_apply,
  };
}

/**
 * Apply an approved admission: bind a fresh runtime instance carrying the
 * session token to the NHI (auto-activating a provisioned identity), then
 * return the env pair the operator session should export. Once-only via the
 * approval apply claim.
 */
export function applyNhiSessionAdmission(
  principal: NhiSessionAdmissionPrincipal,
  tenantSlug: string,
  id: string,
  options: Options & { provider?: string; modelId?: string } = {}
) {
  const { record, plan } = readPlan(principal, tenantSlug, id, options);
  assertHumanApproved(record, plan);
  const claimed = claimApprovalApply('mission_controller', {
    channel: record.channel,
    requestId: record.id,
    appliedBy: principal.requesterId,
    expectedRecordHash: computeApprovalPayloadHash({ record }),
  });
  const instanceId = `${ADMISSION_INSTANCE_PREFIX}${randomUUID()}`;
  const sessionId = `${ADMISSION_SESSION_PREFIX}${randomUUID().replace(/-/g, '')}`;
  const bound = withExecutionContext('mission_controller', () =>
    bindRuntimeInstance({
      nhiId: plan.nhi_id,
      instanceId,
      sessionId,
      provider: options.provider ?? 'operator-session',
      ...(options.modelId ? { modelId: options.modelId } : {}),
      expiresAt: plan.expires_at,
      tenantSlug: plan.tenant_slug,
    })
  );
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
    nhi_id: plan.nhi_id,
    tenant_slug: plan.tenant_slug,
    instance_id: instanceId,
    session_id: sessionId,
    expires_at: plan.expires_at,
    lifecycle_status: bound.lifecycle_status,
    env: {
      KYBERION_NHI_ACTOR: plan.nhi_id,
      [NHI_SESSION_ENV]: sessionId,
    },
  };
}

/**
 * Governed revocation: release the bound runtime instance. Safe direction —
 * no approval ceremony; the journal entry is the audit record.
 */
export function revokeNhiSessionAdmission(
  principal: NhiSessionAdmissionPrincipal,
  input: { nhi_id: string; tenant_slug: string; instance_id?: string; session_id?: string },
  options: Options = {}
) {
  // Revocation stays available while suspended — the safe direction must
  // never be blocked by the lifecycle state that prompted it.
  const { agent } = assertOrgAdmissionTarget(principal, input.tenant_slug, input.nhi_id, options, {
    lifecycle: false,
  });
  const matches = (agent.runtime_instances ?? []).filter(
    (entry) =>
      entry.instance_id.startsWith(ADMISSION_INSTANCE_PREFIX) &&
      (input.instance_id ? entry.instance_id === input.instance_id : true) &&
      (input.session_id ? entry.session_id === input.session_id : true)
  );
  if (matches.length === 0) deny('no live admission binding matches');
  if (matches.length > 1 && !input.instance_id && !input.session_id)
    deny('multiple live bindings — select with --instance or --session');
  return withExecutionContext('mission_controller', () =>
    releaseRuntimeInstance(input.nhi_id, matches[0].instance_id, 'operator_revoked')
  );
}

/** Read-only projection: live + expired session bindings for a tenant/org. */
export function listNhiSessionAdmissions(
  filter: { tenant_slug?: string } = {},
  now: Date = new Date()
): Array<{
  nhi_id: string;
  lifecycle_status: string;
  instance: AgentRuntimeInstanceBinding;
  expired: boolean;
}> {
  return listAgentIdentities()
    .filter(
      (agent) =>
        !filter.tenant_slug ||
        agent.affiliation.tenant_slug === filter.tenant_slug ||
        agent.affiliation.organization_id === filter.tenant_slug
    )
    .flatMap((agent) =>
      (agent.runtime_instances ?? [])
        .filter((entry) => entry.instance_id.startsWith(ADMISSION_INSTANCE_PREFIX))
        .map((instance) => ({
          nhi_id: agent.nhi_id,
          lifecycle_status: agent.lifecycle_status,
          instance,
          expired: Boolean(instance.expires_at && Date.parse(instance.expires_at) <= now.getTime()),
        }))
    );
}

/**
 * Consumption seam for `inspectInstalledOnboardingRuntime` (org scope): the
 * claimed session token must match a live governed binding on the claimed NHI,
 * bound to the approved tenant, on an identity that is not suspended/retired.
 */
export function findLiveSessionAdmission(
  nhiId: string,
  sessionId: string,
  tenantSlug: string,
  now: Date = new Date()
): AgentRuntimeInstanceBinding | undefined {
  const agent = getAgentIdentity(nhiId);
  if (!agent || ['suspended', 'retired'].includes(agent.lifecycle_status)) return undefined;
  return (agent.runtime_instances ?? []).find(
    (entry) =>
      entry.instance_id.startsWith(ADMISSION_INSTANCE_PREFIX) &&
      entry.session_id === sessionId &&
      entry.tenant_slug === tenantSlug &&
      (!entry.expires_at || Date.parse(entry.expires_at) > now.getTime())
  );
}

/** The session token this process was configured with, if any. */
export function claimedSessionId(): string | undefined {
  return getRegisteredEnvText(NHI_SESSION_ENV)?.trim() || undefined;
}
