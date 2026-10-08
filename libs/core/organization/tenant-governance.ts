import * as path from 'node:path';
import { getRegisteredEnvText } from '../foundation/env.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  claimApprovalApply,
  computeApprovalPayloadHash,
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  recordApprovalApplyResult,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { nowIso } from '../foundation/time.js';
import {
  DEFAULT_TENANT_ISOLATION_POLICY,
  defaultTenantKnowledgeRoot,
  listTenantProfileSlugs,
  readTenantProfile,
  recordTenantProviderAttestation,
  tenantProfilePath,
  writeTenantProfile,
  type RecordProviderAttestationInput,
  type TenantProfile,
  type TenantRegistryPathOptions,
} from './tenant-registry.js';
import {
  DEFAULT_ATTESTATION_TTL_DAYS,
  loadProviderEgressPolicy,
} from '../provider/provider-egress-gate.js';
import { resolveIdentityContext } from '../authority.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir } from '../secure-io.js';

export type TenantLifecycleVerb = 'create' | 'update' | 'suspend' | 'resume' | 'archive';

export interface TenantMutationInput extends TenantRegistryPathOptions {
  verb: TenantLifecycleVerb;
  slug: string;
  displayName?: string;
  assignedRole?: string;
  knowledgeRoot?: string;
  metadata?: Record<string, unknown>;
  apply?: boolean;
  actor?: string;
}

export interface TenantMutationResult {
  status: 'dry-run' | 'applied';
  verb: TenantLifecycleVerb;
  profile: TenantProfile;
  profile_path: string;
  knowledge_root_path: string;
}

function assertOperational(profile: TenantProfile, verb: TenantLifecycleVerb): void {
  if (profile.status === 'archived') {
    throw new Error(`Tenant '${profile.tenant_slug}' is archived and cannot be mutated (${verb}).`);
  }
  if (verb === 'resume' && profile.status !== 'suspended') {
    throw new Error(`Tenant '${profile.tenant_slug}' is not suspended.`);
  }
  if (verb === 'suspend' && profile.status !== 'active') {
    throw new Error(`Tenant '${profile.tenant_slug}' is not active.`);
  }
}

function buildProfile(input: TenantMutationInput, current: TenantProfile | null): TenantProfile {
  const slug = input.slug.trim();
  const profile: TenantProfile = {
    tenant_slug: slug,
    tenant_id: current?.tenant_id || slug,
    display_name: input.displayName?.trim() || current?.display_name || slug,
    status:
      input.verb === 'suspend'
        ? 'suspended'
        : input.verb === 'archive'
          ? 'archived'
          : input.verb === 'resume'
            ? 'active'
            : current?.status || 'active',
    assigned_role: input.assignedRole?.trim() || current?.assigned_role || 'owner',
    knowledge_root:
      input.knowledgeRoot?.trim() || current?.knowledge_root || defaultTenantKnowledgeRoot(slug),
    // New tenants start strictly isolated (the same default as the bootstrap
    // `default` tenant): tenant activation's memory_policy check requires it,
    // and no CLI flag exists to set it afterwards without editing the registry.
    ...(current?.isolation_policy
      ? { isolation_policy: current.isolation_policy }
      : input.verb === 'create'
        ? { isolation_policy: { ...DEFAULT_TENANT_ISOLATION_POLICY } }
        : {}),
    ...(current?.allowed_reasoning_backends
      ? { allowed_reasoning_backends: current.allowed_reasoning_backends }
      : {}),
    ...(current?.provider_attestations
      ? { provider_attestations: current.provider_attestations }
      : {}),
    ...(current?.ingest_sources ? { ingest_sources: current.ingest_sources } : {}),
    ...(input.metadata || current?.metadata
      ? { metadata: { ...(current?.metadata || {}), ...(input.metadata || {}) } }
      : {}),
  };
  return profile;
}

export function mutateTenant(input: TenantMutationInput): TenantMutationResult {
  const options: TenantRegistryPathOptions = { rootDir: input.rootDir, env: input.env };
  const current = readTenantProfile(input.slug, options);
  if (input.verb === 'create' && current) {
    throw new Error(`Tenant '${input.slug}' already exists.`);
  }
  if (input.verb !== 'create' && !current) {
    throw new Error(`Tenant '${input.slug}' does not exist.`);
  }
  if (current) assertOperational(current, input.verb);
  const profile = buildProfile(input, current);
  const profilePath = tenantProfilePath(profile.tenant_slug, options);
  const knowledgeRootPath = path.resolve(
    input.rootDir ?? pathResolver.rootDir(),
    profile.knowledge_root!
  );
  if (input.apply) {
    const saved = writeTenantProfile(profile, options);
    if (!safeExistsSync(knowledgeRootPath)) safeMkdir(knowledgeRootPath, { recursive: true });
    auditChain.record({
      agentId: input.actor || getRegisteredEnvText('KYBERION_PERSONA') || 'operator',
      action: `tenant.${input.verb}`,
      operation: `tenant:${profile.tenant_slug}`,
      result: 'completed',
      tenantSlug: profile.tenant_slug,
      metadata: { status: saved.status, knowledge_root: saved.knowledge_root },
    });
    return {
      status: 'applied',
      verb: input.verb,
      profile: saved,
      profile_path: profilePath,
      knowledge_root_path: knowledgeRootPath,
    };
  }
  return {
    status: 'dry-run',
    verb: input.verb,
    profile,
    profile_path: profilePath,
    knowledge_root_path: knowledgeRootPath,
  };
}

export function listTenants(options: TenantRegistryPathOptions = {}): TenantProfile[] {
  return listTenantProfileSlugs(options)
    .map((slug) => readTenantProfile(slug, options))
    .filter((profile): profile is TenantProfile => Boolean(profile));
}

export function showTenant(slug: string, options: TenantRegistryPathOptions = {}): TenantProfile {
  const profile = readTenantProfile(slug, options);
  if (!profile) throw new Error(`Tenant '${slug}' does not exist.`);
  return profile;
}

export interface TenantProviderAttestationResult {
  slug: string;
  provider: string;
  attestation: NonNullable<TenantProfile['provider_attestations']>[string];
  profile_path: string;
  /** Set when the attestation was applied under a human approval. */
  approval?: { request_id: string; approved_by: string };
}

export interface AttestationInvoker {
  /** Who asked for the attestation, captured before any role elevation. */
  actor: string;
  /** The tenant scope the invoking process was bound to, if any. */
  tenantSlug?: string;
}

/**
 * Capture the invoking identity *before* a facade elevates to its governed
 * role: once inside `withExecutionContext('sovereign_concierge', …)` the
 * persona and tenant binding are the facade's, not the operator's, so an audit
 * actor or a tenant check read there would describe the elevation instead.
 */
export function captureAttestationInvoker(): AttestationInvoker {
  let persona = '';
  let role: string | undefined;
  let tenantSlug: string | undefined;
  try {
    const identity = resolveIdentityContext();
    persona = String(identity.persona || '');
    role = identity.role;
    tenantSlug = identity.tenantSlug?.trim() || undefined;
  } catch {
    // An unresolvable identity still gets a named actor below.
  }
  const base =
    persona && persona !== 'unknown'
      ? persona
      : getRegisteredEnvText('KYBERION_PERSONA')?.trim() || 'operator';
  return {
    actor: role ? `${base}:${role}` : base,
    ...(tenantSlug ? { tenantSlug } : {}),
  };
}

function activeTenantSlug(): string | undefined {
  try {
    return resolveIdentityContext().tenantSlug?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface AttestTenantProviderInput extends RecordProviderAttestationInput {
  actor?: string;
  invoker?: AttestationInvoker;
  /** Approved human request (required for training_use 'none'). */
  approvalRequestId?: string;
}

/** Storage channel of the human approval a `training_use: none` attestation needs. */
export const PROVIDER_ATTESTATION_APPROVAL_CHANNEL = 'tenant-provider-attestation';

export function providerAttestationEffectBinding(slug: string, provider: string): string {
  return `tenant:${slug}:attest-provider:${provider}`;
}

/** The exact claim a human approves; the approval is bound to it by payload hash. */
export function providerAttestationApprovalPayload(
  input: Pick<
    RecordProviderAttestationInput,
    'slug' | 'provider' | 'training_use' | 'plan' | 'basis' | 'attested_by' | 'valid_for_days'
  >
): Record<string, unknown> {
  const slug = input.slug.trim();
  const provider = input.provider.trim();
  return {
    action: 'tenant_provider_attestation',
    tenant_slug: slug,
    provider,
    training_use: input.training_use,
    plan: input.plan?.trim() || '',
    basis: input.basis?.trim() || '',
    attested_by: input.attested_by?.trim() || '',
    valid_for_days: typeof input.valid_for_days === 'number' ? input.valid_for_days : null,
    effect: providerAttestationEffectBinding(slug, provider),
  };
}

/**
 * Checks shared by the request and the apply side: a declared provider, the
 * caller's tenant scope, the re-verification cap and the evidence fields.
 */
function validateAttestationInput(input: AttestTenantProviderInput): {
  slug: string;
  provider: string;
} {
  const provider = input.provider?.trim();
  if (!provider) throw new Error('[tenant-governance] provider is required.');
  const slug = input.slug?.trim();
  if (!slug) throw new Error('[tenant-governance] tenant slug is required.');
  // A process bound to one tenant must not attest on behalf of another: the
  // attestation is what lets that tenant's confidential material leave.
  for (const scoped of [input.invoker?.tenantSlug, activeTenantSlug()]) {
    if (scoped && scoped !== slug) {
      throw new Error(
        `[tenant-governance] cross-tenant attestation refused: the active tenant scope '${scoped}' cannot attest for tenant '${slug}'.`
      );
    }
  }
  const loaded = loadProviderEgressPolicy();
  if (loaded.status !== 'ok') {
    throw new Error(
      `[tenant-governance] provider-egress-policy.json is ${loaded.status}; cannot verify provider '${provider}'.`
    );
  }
  const known = Object.keys(loaded.policy.providers).sort();
  if (!known.includes(provider)) {
    throw new Error(
      `[tenant-governance] unknown provider '${provider}'. Declared providers: ${known.join(', ')}.`
    );
  }
  // A claim nobody re-verifies is not evidence: an attestation may not
  // outlive the policy's re-verification interval.
  const ttlDays =
    typeof loaded.policy.attestation_ttl_days === 'number' && loaded.policy.attestation_ttl_days > 0
      ? loaded.policy.attestation_ttl_days
      : DEFAULT_ATTESTATION_TTL_DAYS;
  if (
    input.valid_for_days !== undefined &&
    (!Number.isFinite(input.valid_for_days) || input.valid_for_days <= 0)
  ) {
    throw new Error('[tenant-governance] valid_for_days must be a finite positive number.');
  }
  if (typeof input.valid_for_days === 'number' && input.valid_for_days > ttlDays) {
    throw new Error(
      `[tenant-governance] valid_for_days ${input.valid_for_days} exceeds the policy attestation_ttl_days (${ttlDays}); re-attest within ${ttlDays} days instead.`
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
        `[tenant-governance] training_use 'none' requires ${missing.join(', ')} for an attributable attestation.`
      );
    }
  }
  return { slug, provider };
}

export interface ProviderAttestationApprovalRequest {
  request_id: string;
  created: boolean;
  status: ApprovalRequestRecord['status'];
  expires_at?: string;
  /** The command a human runs to decide (agents must not run it for them). */
  approve_command: string;
}

/**
 * Open (or reuse) the human approval a `training_use: none` attestation needs.
 * Same trust shape as the mission scope-approve flow: the request is hash-bound
 * to the exact claim, a human decides once via `pnpm kyberion approvals
 * --approve <id>`, and the attestation is applied by re-running with
 * `--approval-request-id <id>`.
 */
export function requestTenantProviderAttestationApproval(
  input: AttestTenantProviderInput
): ProviderAttestationApprovalRequest {
  const { slug, provider } = validateAttestationInput(input);
  if (input.training_use !== 'none') {
    throw new Error(
      `[tenant-governance] only training_use 'none' needs an approval; '${input.training_use}' can be recorded directly.`
    );
  }
  const options: TenantRegistryPathOptions = input.rootDir ? { rootDir: input.rootDir } : {};
  const profile = readTenantProfile(slug, options);
  if (!profile) throw new Error(`[tenant-governance] tenant '${slug}' does not exist.`);
  if (profile.status !== 'active') {
    throw new Error(`[tenant-governance] tenant '${slug}' is ${profile.status}; cannot attest.`);
  }
  const payload = providerAttestationApprovalPayload({ ...input, slug, provider });
  const payloadHash = computeApprovalPayloadHash(payload);
  const effectBinding = providerAttestationEffectBinding(slug, provider);
  const approveCommand = (id: string) => `pnpm kyberion approvals --approve ${id}`;
  const existing = listApprovalRequests({
    storageChannels: [PROVIDER_ATTESTATION_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      record.accountability?.payloadHash === payloadHash &&
      !record.applyClaim &&
      !isApprovalRequestExpired(record)
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
  const requestedBy =
    input.actor || input.invoker?.actor || getRegisteredEnvText('KYBERION_PERSONA') || 'operator';
  // A stale approval must not open egress long after the decision context
  // moved on (72h, the scope-approve precedent).
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
  const details = [
    `Tenant: ${slug}`,
    `Provider: ${provider}`,
    `Training use: none (the provider does not train on material sent to it)`,
    `Plan: ${String(payload.plan)}`,
    `Basis: ${String(payload.basis)}`,
    `Attested by: ${String(payload.attested_by)}`,
    `Valid for: ${payload.valid_for_days === null ? 'policy default' : `${String(payload.valid_for_days)} days`}`,
    `Requested by: ${requestedBy}`,
    `Effect if approved: confidential and personal material of tenant '${slug}' may be sent to '${provider}' (for example LLM mission distillation) until the attestation expires.`,
  ].join('\n');
  const record = createApprovalRequest('mission_controller', {
    channel: PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
    storageChannel: PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
    threadTs: `${slug}:${provider}`,
    correlationId: effectBinding,
    requestedBy,
    expiresAt,
    kind: 'mission_gate',
    draft: {
      title: `Provider attestation: ${provider} for tenant ${slug}`,
      summary: `Approve sending tenant '${slug}' confidential material to '${provider}' on the basis that its plan does not train on it.`,
      details,
      severity: 'high',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: requestedBy,
      actorRole: 'tenant-provider-attestation',
    },
    justification: {
      reason: `Tenant ${slug} provider attestation (training_use none) for ${provider}.`,
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
      workflowId: `xp-03-attest-${slug}-${provider}`,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      stages: [],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding,
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

function assertProviderAttestationApproval(
  approvalRequestId: string,
  input: AttestTenantProviderInput & { slug: string; provider: string }
): { approval: ApprovalRequestRecord; humanDecider: string } {
  const approval = loadApprovalRequest(PROVIDER_ATTESTATION_APPROVAL_CHANNEL, approvalRequestId);
  const humanApproval = approval?.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] provider attestation requires an approved request: ${approvalRequestId}${approval ? ` is ${approval.status}` : ' was not found'}`
    );
  }
  if (approval.applyClaim || approval.applyResult) {
    throw new Error(
      `[POLICY_VIOLATION] provider attestation approval ${approval.id} was already used; request a new approval to re-attest`
    );
  }
  if (isApprovalRequestExpired(approval)) {
    throw new Error(`[POLICY_VIOLATION] provider attestation approval has expired: ${approval.id}`);
  }
  if (
    approval.accountability?.effectBinding !==
    providerAttestationEffectBinding(input.slug, input.provider)
  ) {
    throw new Error(
      '[POLICY_VIOLATION] provider attestation approval is bound to a different tenant or provider'
    );
  }
  if (
    approval.accountability?.payloadHash !==
    computeApprovalPayloadHash(providerAttestationApprovalPayload(input))
  ) {
    throw new Error(
      '[POLICY_VIOLATION] provider attestation approval is bound to a different training_use/plan/basis/attested_by/valid_for_days'
    );
  }
  if (!humanApproval) {
    throw new Error(
      '[POLICY_VIOLATION] provider attestation requires an authenticated human approval'
    );
  }
  validateHumanFinalDecision({
    accountability: approval.accountability,
    decidedByType: humanApproval.decidedByType,
    authenticated: humanApproval.authenticated,
    authMethod: humanApproval.authMethod,
    payloadHash: humanApproval.payloadHash,
    effectBinding: humanApproval.effectBinding,
  });
  return {
    approval,
    humanDecider: humanApproval.approvedBy || approval.decidedBy || 'unknown-human',
  };
}

/**
 * Governed entry point for recording a tenant provider attestation — shared by
 * `pnpm tenant attest-provider` and `pnpm onboarding llm attest`.
 *
 * Only providers declared in provider-egress-policy.json can be attested: the
 * gate never lets an attestation invent an egress identity. `training_use:
 * none` opens confidential egress, so it is applied only under an approved,
 * unexpired human approval bound to the exact claim (used once). `used` /
 * `unknown` never open egress and are recorded directly. Every attestation is
 * written to the audit chain (`tenant.attest_provider`) with the invoking actor
 * and, when approved, the human approver.
 */
export function attestTenantProvider(
  input: AttestTenantProviderInput
): TenantProviderAttestationResult {
  const { slug, provider } = validateAttestationInput(input);
  const actor =
    input.actor || input.invoker?.actor || getRegisteredEnvText('KYBERION_PERSONA') || 'operator';
  let approved:
    { approval: ApprovalRequestRecord; humanDecider: string; claimId: string } | undefined;
  if (input.training_use === 'none') {
    if (!input.approvalRequestId?.trim()) {
      throw new Error(
        "[tenant-governance] training_use 'none' opens confidential egress and needs a human approval: request one with --request-approval, have a human run 'pnpm kyberion approvals --approve <id>', then re-run with --approval-request-id <id>."
      );
    }
    const checked = assertProviderAttestationApproval(input.approvalRequestId.trim(), {
      ...input,
      slug,
      provider,
    });
    // At most once: an approval cannot be replayed to keep extending the claim.
    const claimId = claimApprovalApply('mission_controller', {
      channel: checked.approval.channel,
      storageChannel: PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
      requestId: checked.approval.id,
      appliedBy: actor,
      expectedRecordHash: computeApprovalPayloadHash({ record: checked.approval }),
    }).applyClaim.claimId;
    approved = { ...checked, claimId };
  }
  const {
    actor: _actor,
    invoker: _invoker,
    approvalRequestId: _approvalRequestId,
    ...recordInput
  } = input;
  let profile: TenantProfile;
  try {
    profile = recordTenantProviderAttestation({ ...recordInput, slug, provider });
  } catch (error) {
    if (approved) {
      recordApprovalApplyResult('mission_controller', {
        channel: approved.approval.channel,
        storageChannel: PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
        requestId: approved.approval.id,
        claimId: approved.claimId,
        applyResult: { appliedAt: nowIso(), appliedBy: actor, result: 'failed' },
      });
    }
    throw error;
  }
  const attestation = profile.provider_attestations![provider]!;
  const options: TenantRegistryPathOptions = input.rootDir ? { rootDir: input.rootDir } : {};
  const audit = auditChain.record({
    agentId: actor,
    action: 'tenant.attest_provider',
    operation: `tenant:${profile.tenant_slug}:provider:${provider}`,
    result: 'completed',
    tenantSlug: profile.tenant_slug,
    metadata: {
      provider,
      training_use: attestation.training_use,
      ...(attestation.plan ? { plan: attestation.plan } : {}),
      ...(attestation.basis ? { basis: attestation.basis } : {}),
      ...(attestation.attested_by ? { attested_by: attestation.attested_by } : {}),
      ...(attestation.expires_at ? { expires_at: attestation.expires_at } : {}),
      ...(approved
        ? { approved_by: approved.humanDecider, approval_request_id: approved.approval.id }
        : {}),
    },
  });
  if (approved) {
    recordApprovalApplyResult('mission_controller', {
      channel: approved.approval.channel,
      storageChannel: PROVIDER_ATTESTATION_APPROVAL_CHANNEL,
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
    slug: profile.tenant_slug,
    provider,
    attestation,
    profile_path: tenantProfilePath(profile.tenant_slug, options),
    ...(approved
      ? { approval: { request_id: approved.approval.id, approved_by: approved.humanDecider } }
      : {}),
  };
}
