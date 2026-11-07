/**
 * Governed entry point for system / person custody provider attestations
 * (INFORMATION_ASSET_SCOPE_MODEL_DESIGN_2026-11-05 P1, SM-06) — the
 * `pnpm onboarding llm attest --custody system|person` path.
 *
 * Same trust shape as the tenant path (`tenant-governance.ts`
 * `attestTenantProvider`): only providers declared in
 * provider-egress-policy.json can be attested, a claim may not outlive the
 * policy TTL, and `training_use: none` — the claim that opens tenantless
 * confidential / personal egress — is applied only under an approved,
 * unexpired, authenticated human approval bound by payload hash to the exact
 * claim and usable once. Separation of duties (self-approval refused) is the
 * approval store's own rule, as on the tenant path. `used` / `unknown` never
 * open egress and are recorded directly.
 *
 * Deciders (decided 2026-11-05, design option C):
 * - system custody is the installation's statement that the provider does not
 *   train, so the installation owner decides (`sovereign` / `owner`), and
 *   separation of duties refuses self-approval as before;
 * - person custody is that person's CONSENT to send their own personal
 *   material under that condition — not evidence that the provider does not
 *   train (the egress gate also needs the system attestation or a policy
 *   declaration). Only the person decides it: the request carries
 *   `accountability.consent` (`personCustodyConsentSubject`), the approval
 *   store refuses an approval by anyone else for a principal-keyed person,
 *   and the person deciding a request they opened is consent, not
 *   self-approval. On the `operator` key (single-user installation) the
 *   operator is both owner and subject, so the owner-role decision is the
 *   consent and does not deadlock on separation of duties.
 * There is no standing charter delegation for custody claims in P1: every
 * `none` needs its own human decision.
 *
 * A process bound to a tenant scope is refused: tenant material is decided by
 * the tenant's own attestation, and a tenant-bound caller must not author the
 * installation's or a person's statement.
 */
import { nowIso } from '../foundation/time.js';
import { auditChain } from '../governance/audit-chain.js';
import { approvalRequesterActorId } from '../governance/approval-requester.js';
import {
  claimApprovalApply,
  computeApprovalPayloadHash,
  createApprovalRequest,
  evaluateApprovalUsability,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  recordApprovalApplyResult,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { resolveIdentityContext } from '../authority.js';
import { normalizeEventScope } from '../event/event-scope.js';
import { custodyOwnerLabel } from '../contracts/custody-owner.js';
import {
  assertPrintableCommandValue,
  shellQuoteArg,
  type AttestationInvoker,
  type ProviderAttestationApprovalRequest,
} from '../organization/tenant-governance.js';
import { DEFAULT_ATTESTATION_TTL_DAYS, loadProviderEgressPolicy } from './provider-egress-gate.js';
import { normalizeApprovalPrincipalId } from '../governance/approval-principal-id.js';
import type { ApprovalConsent } from '../governance/approval-separation-of-duties.js';
import {
  custodyProviderAttestationRelativePath,
  personCustodyConsentGap,
  personCustodyConsentSubject,
  personCustodyOwnerKey,
  writeCustodyProviderAttestationEntry,
  type CustodyProviderAttestationEntry,
  type NonTenantCustodyOwner,
} from './custody-provider-attestation-store.js';

/** Storage channel of the human approval a custody `training_use: none` attestation needs. */
export const CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL = 'custody-provider-attestation';

/**
 * Workflow roles a custody attestation request is decided through (the
 * surfaces decide as `sovereign`). For system custody the decider is the
 * installation owner; for person custody it must also be the person
 * (`accountability.consent`, checked at decision, apply and read time).
 */
export const CUSTODY_PROVIDER_ATTESTATION_DECISION_ROLES = ['sovereign', 'owner'] as const;

export interface AttestCustodyProviderInput {
  custody: NonTenantCustodyOwner;
  provider: string;
  training_use: 'none' | 'used' | 'unknown';
  plan?: string;
  basis?: string;
  attested_by?: string;
  valid_for_days?: number;
  /** Approved human request (required for training_use 'none'). */
  approvalRequestId?: string;
  actor?: string;
  invoker?: AttestationInvoker;
}

export interface CustodyProviderAttestationResult {
  custody: NonTenantCustodyOwner;
  provider: string;
  attestation: CustodyProviderAttestationEntry;
  store_path: string;
  approval?: { request_id: string; approved_by: string };
}

function custodyKey(custody: NonTenantCustodyOwner): string {
  return custody.kind === 'system'
    ? 'system'
    : `person:${personCustodyOwnerKey(custody.principal_id)}`;
}

export function custodyProviderAttestationEffectBinding(
  custody: NonTenantCustodyOwner,
  provider: string
): string {
  return `custody:${custodyKey(custody)}:attest-provider:${provider}`;
}

function approvalScope() {
  // Custody claims are installation configuration: the system approval tree,
  // hidden from tenant-bound processes.
  return { scope_kind: 'system' } as const;
}

/** The exact claim a human approves; the approval is bound to it by payload hash. */
export function custodyProviderAttestationApprovalPayload(
  input: Pick<
    AttestCustodyProviderInput,
    'custody' | 'provider' | 'training_use' | 'plan' | 'basis' | 'attested_by' | 'valid_for_days'
  >
): Record<string, unknown> {
  const provider = input.provider.trim();
  return {
    action: 'custody_provider_attestation',
    custody: custodyKey(input.custody),
    provider,
    training_use: input.training_use,
    plan: input.plan?.trim() || '',
    basis: input.basis?.trim() || '',
    attested_by: input.attested_by?.trim() || '',
    valid_for_days: typeof input.valid_for_days === 'number' ? input.valid_for_days : null,
    effect: custodyProviderAttestationEffectBinding(input.custody, provider),
  };
}

/** `--custody system` / `--custody person [--principal <id>]` as CLI flags. */
export function custodyCliArgs(custody: NonTenantCustodyOwner): string[] {
  return [
    '--custody',
    custody.kind,
    ...(custody.kind === 'person' && custody.principal_id
      ? ['--principal', custody.principal_id]
      : []),
  ];
}

/** The exact command that opens a fresh approval request for this claim (POSIX shell, quoted). */
export function custodyProviderAttestationRequestCommand(
  input: Pick<
    AttestCustodyProviderInput,
    'custody' | 'provider' | 'training_use' | 'plan' | 'basis' | 'attested_by' | 'valid_for_days'
  >
): string {
  return [
    'pnpm',
    'onboarding',
    'llm',
    'attest',
    ...custodyCliArgs(input.custody),
    '--provider',
    input.provider,
    '--training-use',
    input.training_use,
    ...(input.plan !== undefined ? ['--plan', input.plan] : []),
    ...(input.basis !== undefined ? ['--basis', input.basis] : []),
    ...(input.attested_by !== undefined ? ['--attested-by', input.attested_by] : []),
    ...(typeof input.valid_for_days === 'number' && Number.isFinite(input.valid_for_days)
      ? ['--valid-for-days', String(input.valid_for_days)]
      : []),
    '--request-approval',
  ]
    .map(shellQuoteArg)
    .join(' ');
}

function activeTenantSlug(): string | undefined {
  try {
    return resolveIdentityContext().tenantSlug?.trim() || undefined;
  } catch {
    return undefined;
  }
}

function custodySubject(custody: NonTenantCustodyOwner): string {
  return custody.kind === 'system'
    ? 'the installation (system custody)'
    : `person custody (${custodyOwnerLabel(custody)})`;
}

/** Checks shared by the request and the apply side. */
function validateCustodyAttestationInput(input: AttestCustodyProviderInput): {
  custody: NonTenantCustodyOwner;
  provider: string;
  ttlDays: number;
} {
  const custody = input.custody;
  if (!custody || (custody.kind !== 'system' && custody.kind !== 'person')) {
    throw new Error("[custody-attestation] custody must be 'system' or 'person'.");
  }
  const provider = input.provider?.trim();
  if (!provider) throw new Error('[custody-attestation] provider is required.');
  assertPrintableCommandValue('--plan', input.plan);
  assertPrintableCommandValue('--basis', input.basis);
  assertPrintableCommandValue('--attested-by', input.attested_by);
  if (custody.kind === 'person' && custody.principal_id !== undefined) {
    assertPrintableCommandValue('--principal', custody.principal_id);
  }
  for (const scoped of [input.invoker?.tenantSlug, activeTenantSlug()]) {
    if (scoped) {
      throw new Error(
        `[custody-attestation] the active tenant scope '${scoped}' cannot attest for ${custodySubject(custody)}: tenant material is decided by the tenant's own attestation (--tenant ${scoped}).`
      );
    }
  }
  if (
    input.training_use !== 'none' &&
    input.training_use !== 'used' &&
    input.training_use !== 'unknown'
  ) {
    throw new Error('[custody-attestation] training_use must be none, used or unknown.');
  }
  const loaded = loadProviderEgressPolicy();
  if (loaded.status !== 'ok') {
    throw new Error(
      `[custody-attestation] provider-egress-policy.json is ${loaded.status}; cannot verify provider '${provider}'.`
    );
  }
  const known = Object.keys(loaded.policy.providers).sort();
  if (!known.includes(provider)) {
    throw new Error(
      `[custody-attestation] unknown provider '${provider}'. Declared providers: ${known.join(', ')}.`
    );
  }
  const ttlDays =
    typeof loaded.policy.attestation_ttl_days === 'number' && loaded.policy.attestation_ttl_days > 0
      ? loaded.policy.attestation_ttl_days
      : DEFAULT_ATTESTATION_TTL_DAYS;
  if (
    input.valid_for_days !== undefined &&
    (!Number.isFinite(input.valid_for_days) || input.valid_for_days <= 0)
  ) {
    throw new Error('[custody-attestation] valid_for_days must be a finite positive number.');
  }
  if (typeof input.valid_for_days === 'number' && input.valid_for_days > ttlDays) {
    throw new Error(
      `[custody-attestation] valid_for_days ${input.valid_for_days} exceeds the policy attestation_ttl_days (${ttlDays}); re-attest within ${ttlDays} days instead.`
    );
  }
  if (input.training_use === 'none') {
    const missing = [
      !input.plan?.trim() ? 'plan' : '',
      !input.basis?.trim() ? 'basis' : '',
      !input.attested_by?.trim() ? 'attested_by' : '',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(
        `[custody-attestation] training_use 'none' requires ${missing.join(', ')} for an attributable attestation.`
      );
    }
  }
  return { custody, provider, ttlDays };
}

function matchesDecisionWorkflow(record: ApprovalRequestRecord): boolean {
  const workflow = record.workflow;
  const roles = CUSTODY_PROVIDER_ATTESTATION_DECISION_ROLES;
  return Boolean(
    workflow?.mode === 'any_of' &&
    workflow.stages.length === 0 &&
    workflow.requiredRoles.length === roles.length &&
    workflow.approvals.length === roles.length &&
    roles.every(
      (role) =>
        workflow.requiredRoles.includes(role) &&
        workflow.approvals.some((entry) => entry.role === role)
    )
  );
}

/** The consent a request for this custody owner must carry (none for system custody). */
function expectedConsent(custody: NonTenantCustodyOwner): ApprovalConsent | undefined {
  return custody.kind === 'person' ? personCustodyConsentSubject(custody) : undefined;
}

function matchesConsent(record: ApprovalRequestRecord, custody: NonTenantCustodyOwner): boolean {
  const expected = expectedConsent(custody);
  const actual = record.accountability?.consent;
  if (!expected || !actual) return !expected && !actual;
  return (
    actual.subject_only === expected.subject_only &&
    normalizeApprovalPrincipalId(actual.subject) === normalizeApprovalPrincipalId(expected.subject)
  );
}

function matchesApprovalScope(record: ApprovalRequestRecord): boolean {
  return (
    computeApprovalPayloadHash({ scope: record.scope }) ===
    computeApprovalPayloadHash({ scope: normalizeEventScope(approvalScope()) })
  );
}

/**
 * Open (or reuse) the human approval a custody `training_use: none`
 * attestation needs. A human decides once via `pnpm kyberion approvals
 * --approve <id>`; the claim is applied by re-running with
 * `--approval-request-id <id>`.
 */
export function requestCustodyProviderAttestationApproval(
  input: AttestCustodyProviderInput
): ProviderAttestationApprovalRequest {
  const { custody, provider } = validateCustodyAttestationInput(input);
  if (input.training_use !== 'none') {
    throw new Error(
      `[custody-attestation] only training_use 'none' needs an approval; '${input.training_use}' can be recorded directly.`
    );
  }
  const payload = custodyProviderAttestationApprovalPayload({ ...input, custody, provider });
  const payloadHash = computeApprovalPayloadHash(payload);
  const effectBinding = custodyProviderAttestationEffectBinding(custody, provider);
  const approveCommand = (id: string) => `pnpm kyberion approvals --approve ${id}`;
  const existing = listApprovalRequests({
    storageChannels: [CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      matchesApprovalScope(record) &&
      matchesDecisionWorkflow(record) &&
      matchesConsent(record, custody) &&
      record.accountability?.payloadHash === payloadHash &&
      !record.applyClaim &&
      !isApprovalRequestExpired(record) &&
      (record.status !== 'approved' || !evaluateApprovalUsability(record))
  );
  if (existing) {
    return {
      request_id: existing.id,
      created: false,
      status: existing.status,
      ...(existing.expiresAt ? { expires_at: existing.expiresAt } : {}),
      approve_command: approveCommand(existing.id),
    };
  }
  if (input.invoker?.approvalRequesterError) {
    throw new Error(input.invoker.approvalRequesterError);
  }
  const resolved = input.invoker?.approvalRequester;
  const requestedBy = input.actor || resolved?.requestedBy || input.invoker?.actor || 'operator';
  const requesterActor = resolved ? approvalRequesterActorId(resolved) : requestedBy;
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const consent = expectedConsent(custody);
  const tierEffect =
    custody.kind === 'system'
      ? 'confidential material that belongs to no tenant (system custody, e.g. system role drafts)'
      : 'personal material that belongs to no tenant (person custody)';
  const decider = consent
    ? consent.subject_only
      ? `Decided by: ${consent.subject} only — this is the person's own consent; nobody else can give it`
      : `Decided by: the installation owner, who is also the person (single-user consent)`
    : 'Decided by: the installation owner (not the requester)';
  const effect = consent
    ? `Effect if approved: the person consents to sending their own ${tierEffect} to '${provider}' under training_use none, until the attestation expires. Egress also needs the installation's training_use none attestation for '${provider}' (or a policy declaration); this consent is not that evidence. Tenant material is unaffected.`
    : `Effect if approved: ${tierEffect} may be sent to '${provider}' until the attestation expires. Tenant material is unaffected.`;
  const details = [
    `Custody: ${custodySubject(custody)}`,
    `Provider: ${provider}`,
    `Training use: none (the provider does not train on material sent to it)`,
    `Plan: ${String(payload.plan)}`,
    `Basis: ${String(payload.basis)}`,
    `Attested by: ${String(payload.attested_by)}`,
    `Valid for: ${payload.valid_for_days === null ? 'policy default' : `${String(payload.valid_for_days)} days`}`,
    `Requested by: ${requestedBy}`,
    decider,
    effect,
  ].join('\n');
  const record = createApprovalRequest('mission_controller', {
    scope: approvalScope(),
    channel: CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
    storageChannel: CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
    threadTs: `${custodyKey(custody)}:${provider}`,
    correlationId: effectBinding,
    requestedBy,
    ...(resolved?.displayName ? { requestedByDisplayName: resolved.displayName } : {}),
    expiresAt,
    kind: 'mission_gate',
    draft: {
      title: consent
        ? `Provider consent: ${provider} for ${custodySubject(custody)}`
        : `Provider attestation: ${provider} for ${custodySubject(custody)}`,
      summary: consent
        ? `Consent to sending your own ${tierEffect} to '${provider}' on the condition that its plan does not train on it.`
        : `Approve sending ${tierEffect} to '${provider}' on the basis that its plan does not train on it.`,
      details,
      severity: 'high',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: requesterActor,
      actorRole: 'custody-provider-attestation',
    },
    justification: {
      reason: `${custodySubject(custody)} provider attestation (training_use none) for ${provider}.`,
      requestedEffects: [effectBinding],
      impactSummary: details,
    },
    risk: {
      level: 'high',
      restartScope: 'manual',
      requiresStrongAuth: true,
      policyId: 'XP-03',
    },
    workflow: {
      workflowId: `xp-03-attest-${custody.kind}-${provider}`,
      mode: 'any_of',
      requiredRoles: [...CUSTODY_PROVIDER_ATTESTATION_DECISION_ROLES],
      stages: [],
      approvals: CUSTODY_PROVIDER_ATTESTATION_DECISION_ROLES.map((role) => ({
        role,
        status: 'pending',
      })),
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding,
      ...(consent ? { consent } : {}),
    },
  });
  return {
    request_id: record.id,
    created: true,
    status: record.status,
    expires_at: expiresAt,
    approve_command: approveCommand(record.id),
  };
}

function assertCustodyAttestationApproval(
  approvalRequestId: string,
  input: AttestCustodyProviderInput & { custody: NonTenantCustodyOwner; provider: string }
): { approval: ApprovalRequestRecord; humanDecider: string } {
  const approval = loadApprovalRequest(
    CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
    approvalRequestId
  );
  const humanApproval = approval?.workflow?.approvals?.find(
    (entry) =>
      CUSTODY_PROVIDER_ATTESTATION_DECISION_ROLES.some((role) => role === entry.role) &&
      entry.status === 'approved' &&
      entry.decidedByType === 'human' &&
      entry.authenticated === true
  );
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] custody provider attestation requires an approved request: ${approvalRequestId}${approval ? ` is ${approval.status}` : ' was not found'}`
    );
  }
  if (approval.applyClaim || approval.applyResult) {
    throw new Error(
      `[POLICY_VIOLATION] custody provider attestation approval ${approval.id} was already used; request a new approval to re-attest`
    );
  }
  if (isApprovalRequestExpired(approval)) {
    throw new Error(
      `[POLICY_VIOLATION] custody provider attestation approval has expired: ${approval.id}`
    );
  }
  if (!matchesApprovalScope(approval) || !matchesDecisionWorkflow(approval)) {
    throw new Error(
      '[POLICY_VIOLATION] custody provider attestation approval was not opened for an installation-owner decision; request a new approval'
    );
  }
  if (
    approval.accountability?.effectBinding !==
    custodyProviderAttestationEffectBinding(input.custody, input.provider)
  ) {
    throw new Error(
      '[POLICY_VIOLATION] custody provider attestation approval is bound to a different custody owner or provider'
    );
  }
  if (
    approval.accountability?.payloadHash !==
    computeApprovalPayloadHash(custodyProviderAttestationApprovalPayload(input))
  ) {
    throw new Error(
      '[POLICY_VIOLATION] custody provider attestation approval is bound to a different training_use/plan/basis/attested_by/valid_for_days'
    );
  }
  if (!matchesConsent(approval, input.custody)) {
    throw new Error(
      `[POLICY_VIOLATION] custody provider attestation approval ${approval.id} was not opened as ${input.custody.kind === 'person' ? "the person's own consent" : 'an installation-owner decision'} — ` +
        `a person-custody attestation is the person's consent and records its subject on the request | next: request a new approval with '${custodyProviderAttestationRequestCommand(input)}' | evidence: custody=${custodyOwnerLabel(input.custody)} consent_subject=${approval.accountability?.consent?.subject ?? '(none)'}`
    );
  }
  if (!humanApproval) {
    throw new Error(
      '[POLICY_VIOLATION] custody provider attestation requires an authenticated human approval'
    );
  }
  validateHumanFinalDecision({
    accountability: approval.accountability,
    decidedByType: humanApproval.decidedByType,
    authenticated: humanApproval.authenticated,
    authMethod: humanApproval.authMethod,
    payloadHash: humanApproval.payloadHash,
    effectBinding: humanApproval.effectBinding,
    phase: 'recheck',
  });
  const humanDecider = humanApproval.approvedBy || approval.decidedBy || 'unknown-human';
  const consentGap = personCustodyConsentGap(input.custody, humanDecider);
  if (consentGap) {
    throw new Error(
      `[POLICY_VIOLATION] person custody provider attestation approval ${approval.id} is not the person's consent — ${consentGap} | next: request a new approval with '${custodyProviderAttestationRequestCommand(input)}' and have the person decide it from their own signed-in session | evidence: custody=${custodyOwnerLabel(input.custody)} approved_by=${humanDecider}`
    );
  }
  // Separation of duties (revoked / self-approved records) is enforced when
  // the approval is claimed: claimApprovalApply runs the `apply_claim` check.
  return { approval, humanDecider };
}

/**
 * Record a system / person custody provider attestation. `none` requires an
 * approved request (`approvalRequestId`), claimed at most once; the approval
 * basis is stored with the entry so a reader can refuse a `none` without one.
 * Every write is audited as `provider.attest_custody`.
 */
export function attestCustodyProvider(
  input: AttestCustodyProviderInput
): CustodyProviderAttestationResult {
  const { custody, provider } = validateCustodyAttestationInput(input);
  const actor = input.actor || input.invoker?.actor || 'operator';
  let approved:
    { approval: ApprovalRequestRecord; humanDecider: string; claimId: string } | undefined;
  if (input.training_use === 'none') {
    const requestId = input.approvalRequestId?.trim();
    if (!requestId) {
      throw new Error(
        `[custody-attestation] training_use 'none' opens tenantless egress and needs a human approval: request one with '${custodyProviderAttestationRequestCommand({ ...input, custody, provider })}', have a human run 'pnpm kyberion approvals --approve <id>', then re-run with --apply --accept --approval-request-id <id>.`
      );
    }
    const checked = assertCustodyAttestationApproval(requestId, { ...input, custody, provider });
    const claimId = claimApprovalApply('mission_controller', {
      channel: checked.approval.channel,
      storageChannel: CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
      requestId: checked.approval.id,
      appliedBy: actor,
      expectedRecordHash: computeApprovalPayloadHash({ record: checked.approval }),
      rerequestCommand: custodyProviderAttestationRequestCommand({ ...input, custody, provider }),
    }).applyClaim.claimId;
    approved = { ...checked, claimId };
  }
  const attestedAt = new Date();
  const entry: CustodyProviderAttestationEntry = {
    training_use: input.training_use,
    attested_at: attestedAt.toISOString(),
    ...(input.plan?.trim() ? { plan: input.plan.trim() } : {}),
    ...(input.basis?.trim() ? { basis: input.basis.trim() } : {}),
    ...(input.attested_by?.trim() ? { attested_by: input.attested_by.trim() } : {}),
    ...(typeof input.valid_for_days === 'number' && input.valid_for_days > 0
      ? {
          expires_at: new Date(
            attestedAt.getTime() + input.valid_for_days * 24 * 60 * 60 * 1000
          ).toISOString(),
        }
      : {}),
    ...(approved
      ? { approval: { request_id: approved.approval.id, approved_by: approved.humanDecider } }
      : {}),
  };
  let written: { path: string; entry: CustodyProviderAttestationEntry };
  try {
    written = writeCustodyProviderAttestationEntry(custody, provider, entry);
  } catch (error) {
    if (approved) {
      recordApprovalApplyResult('mission_controller', {
        channel: approved.approval.channel,
        storageChannel: CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
        requestId: approved.approval.id,
        claimId: approved.claimId,
        applyResult: { appliedAt: nowIso(), appliedBy: actor, result: 'failed' },
      });
    }
    throw error;
  }
  const audit = auditChain.record({
    agentId: actor,
    action: 'provider.attest_custody',
    operation: `custody:${custodyKey(custody)}:provider:${provider}`,
    result: 'completed',
    metadata: {
      custody: custody.kind,
      provider,
      training_use: entry.training_use,
      ...(entry.plan ? { plan: entry.plan } : {}),
      ...(entry.basis ? { basis: entry.basis } : {}),
      ...(entry.attested_by ? { attested_by: entry.attested_by } : {}),
      ...(entry.expires_at ? { expires_at: entry.expires_at } : {}),
      ...(approved
        ? { approved_by: approved.humanDecider, approval_request_id: approved.approval.id }
        : {}),
    },
  });
  if (approved) {
    recordApprovalApplyResult('mission_controller', {
      channel: approved.approval.channel,
      storageChannel: CUSTODY_PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
      requestId: approved.approval.id,
      claimId: approved.claimId,
      applyResult: {
        appliedAt: nowIso(),
        appliedBy: actor,
        result: 'success',
        ...(audit?.id ? { auditRef: audit.id } : {}),
      },
    });
  }
  return {
    custody,
    provider,
    attestation: written.entry,
    store_path: custodyProviderAttestationRelativePath(custody),
    ...(approved
      ? { approval: { request_id: approved.approval.id, approved_by: approved.humanDecider } }
      : {}),
  };
}
