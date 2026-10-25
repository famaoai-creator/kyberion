/** Exact-effect, human-only activation shared by trusted Web and CLI adapters. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ResolvedPrincipal } from '../authn-principal-resolver.js';
import { humanActor } from '../actor.js';
import { getAgentIdentity } from '../agent/agent-identity.js';
import { parseNhiId } from '../nhi-id.js';
import { acquireLock, releaseLock } from '../foundation/lock-utils.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { isRecord, readTextFile } from '../foundation/text.js';
import { nowIso } from '../foundation/time.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeLstat } from '../secure-io.js';
import { runServicePreflight } from '../service/service-preflight.js';
import { verifySurfaceManagementAuthorization } from '../surface/surface-management-mutations.js';
import { checkAuthorizationShape } from '../surface/surface-management-validation.js';
import {
  requireGrant,
  type SurfaceManagementAuthorization,
} from '../surface/surface-management-contract.js';
import {
  claimApprovalApply,
  computeApprovalPayloadHash,
  computeApprovalPresentedDigest,
  createApprovalRequest,
  isApprovalRequestExpired,
  loadApprovalRequest,
  recordApprovalApplyResult,
  validateHumanFinalDecision,
  surfaceDecisionAuthMethod,
  assuranceOfAuthMethod,
  assuranceMeets,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { loadOnboardingContextBinding } from './onboarding-context.js';
import { readTenantProfile } from './tenant-registry.js';
import { readMemberProfile } from './member-registry.js';
import {
  assertOrganizationId,
  loadOrganizationOperationalState,
} from './organization-operating-model-persistence.js';
import {
  applyTenantActivation,
  isTenantActivationActive,
  loadTenantActivation,
  resolveTenantActivation,
  tenantActivationProbeEvidenceDir,
  TENANT_ACTIVATION_PROBE_CHECKS,
  TENANT_ACTIVATION_PROBE_EVIDENCE_KIND,
  type TenantActivationInput,
  type TenantActivationRecord,
} from './tenant-activation.js';

export const TENANT_ACTIVATION_APPROVAL_CHANNEL = 'tenant-activation';
export const TENANT_ACTIVATION_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000;
const EFFECT_PREFIX = 'tenant-activation:';

export interface RequestTenantActivationApprovalInput {
  customerSlug: string;
  organizationId: string;
  tier?: TenantActivationRecord['tier'];
  nhiIds: string[];
  serviceIds?: string[];
  /** Trusted adapter supplies its persisted server probe receipt, never an HTTP field. */
  evidenceRef: string;
}
export interface TenantActivationApprovalOptions {
  /** Internal fixture seam, never accepted from a remote command. */
  rootDir?: string;
}
export interface TenantActivationApprovalView {
  approval: ApprovalRequestRecord;
  presentedDigest: string;
}
const commandSchema = z
  .object({
    customerSlug: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
    tenantSlug: z.string().min(1),
    organizationId: z.string().min(1),
    tier: z.enum(['personal', 'confidential', 'public']),
    ownerId: z.string().min(1),
    nhiIds: z.array(z.string().min(1)).min(1),
    serviceIds: z.array(z.string().min(1)),
    evidenceRef: z.string().min(1),
  })
  .strict();
const payloadSchema = z
  .object({
    kind: z.literal('tenant_activation_approval'),
    version: z.literal('1.0.0'),
    command: commandSchema,
    snapshot: z.record(z.string(), z.unknown()),
  })
  .strict();
type ActivationCommand = z.infer<typeof commandSchema>;
type ActivationPayload = z.infer<typeof payloadSchema>;

function refuse(message: string): never {
  throw new Error('[TENANT_ACTIVATION_APPROVAL] ' + message);
}
function canonicalSet(values: readonly string[]): string[] {
  if (
    !Array.isArray(values) ||
    values.some((value) => typeof value !== 'string' || !value.trim() || value !== value.trim())
  )
    refuse('Nonempty canonical identifiers are required.');
  return [...new Set(values)].sort();
}
function same(left: unknown, right: unknown): boolean {
  return (
    computeApprovalPayloadHash({ value: left }) === computeApprovalPayloadHash({ value: right })
  );
}
function assertPrincipal(
  auth: SurfaceManagementAuthorization,
  principal: ResolvedPrincipal,
  organizationId?: string,
  tier?: TenantActivationRecord['tier']
): void {
  checkAuthorizationShape(auth);
  const method = surfaceDecisionAuthMethod(principal, principal?.memberId === auth.memberId);
  const assurance = assuranceOfAuthMethod(method);
  if (
    !principal ||
    principal.actor.kind !== 'human' ||
    principal.source === 'agent' ||
    principal.actor.id !== auth.actorId ||
    principal.memberId !== auth.memberId ||
    !assurance ||
    !assuranceMeets(assurance, 'A2') ||
    !['medium', 'high'].includes(principal.assurance)
  )
    refuse('A currently verified A2 human member session is required.');
  if (
    principal.expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(principal.expiresAt)) ||
      Date.parse(principal.expiresAt) <= Date.now())
  )
    refuse('The authenticated principal has expired.');
  requireGrant(principal.tenantSlugs, auth.tenantSlug);
  if (organizationId) {
    assertOrganizationId(organizationId);
    requireGrant(auth.allowedOrganizationIds, organizationId);
    requireGrant(principal.organizationIds, organizationId);
  }
  if (tier && !principal.tierAccess.includes(tier))
    refuse('The tier is outside the verified principal scope.');
}
function effectBinding(command: ActivationCommand): string {
  return (
    EFFECT_PREFIX +
    [command.tenantSlug, command.customerSlug, command.organizationId, command.tier]
      .map(encodeURIComponent)
      .join(':')
  );
}
function activationInput(command: ActivationCommand, rootDir: string): TenantActivationInput {
  return {
    customerSlug: command.customerSlug,
    tenantSlug: command.tenantSlug,
    organizationId: command.organizationId,
    tier: command.tier,
    ownerId: command.ownerId,
    nhiIds: command.nhiIds,
    rootDir,
    checks: Object.fromEntries(TENANT_ACTIVATION_PROBE_CHECKS.map((check) => [check, true])),
    probeRefs: Object.fromEntries(
      TENANT_ACTIVATION_PROBE_CHECKS.map((check) => [check, command.evidenceRef])
    ),
  };
}
function readProbe(command: ActivationCommand, rootDir: string) {
  // Reject schemes, arbitrary files and symlink escapes, even for valid-looking JSON.
  const expectedDir = tenantActivationProbeEvidenceDir(command, rootDir);
  const file = assertSafeRepositoryPath(path.resolve(rootDir, command.evidenceRef), {
    allowMissingLeaf: false,
    rootDir,
  });
  if (
    path.dirname(file) !== expectedDir ||
    !/^probe-[A-Za-z0-9-]+\.json$/.test(path.basename(file)) ||
    !safeLstat(file).isFile()
  )
    refuse('A server-created probe in this exact activation scope is required.');
  const bytes = readTextFile(file);
  const evidence = parseSafeJsonInput(bytes, 'tenant activation probe');
  if (
    !isRecord(evidence) ||
    evidence.version !== '1.0.0' ||
    evidence.kind !== TENANT_ACTIVATION_PROBE_EVIDENCE_KIND ||
    evidence.customer_slug !== command.customerSlug ||
    evidence.tenant_slug !== command.tenantSlug ||
    evidence.organization_id !== command.organizationId ||
    evidence.tier !== command.tier ||
    !Array.isArray(evidence.nhi_ids) ||
    !same(canonicalSet(evidence.nhi_ids as string[]), command.nhiIds)
  )
    refuse('The structured probe has a different scope, tier or NHI set.');
  const createdAt = typeof evidence.created_at === 'string' ? Date.parse(evidence.created_at) : NaN;
  const age = Date.now() - createdAt;
  if (!Number.isFinite(createdAt) || age < 0 || age > TENANT_ACTIVATION_EVIDENCE_MAX_AGE_MS)
    refuse('Probe evidence is stale or future-dated; run fresh probes.');
  const results = evidence.results;
  if (
    !isRecord(results) ||
    TENANT_ACTIVATION_PROBE_CHECKS.some(
      (check) => !isRecord(results[check]) || results[check].passed !== true
    )
  )
    refuse('Every structured activation probe must pass.');
  const serviceResult = results.service_readiness;
  if (
    !isRecord(serviceResult) ||
    !isRecord(serviceResult.services) ||
    !same(Object.keys(serviceResult.services).sort(), command.serviceIds) ||
    Object.values(serviceResult.services).some((entry) => !isRecord(entry) || entry.passed !== true)
  )
    refuse('The probe service set or service readiness does not match.');
  return { digest: createHash('sha256').update(bytes).digest('hex'), createdAt, evidence };
}
async function inspectServices(command: ActivationCommand) {
  const services = [];
  for (const serviceId of command.serviceIds) {
    const preflight = await runServicePreflight({ serviceId });
    if (!preflight.ready || !preflight.reports.length)
      refuse('A declared service is no longer ready.');
    services.push({
      serviceId,
      reports: preflight.reports.map((report) => ({
        serviceId: report.serviceId,
        status: report.status,
        authReady: report.authReady,
        directProbeReady: report.directProbeReady,
        runtimeReady: report.runtimeReady,
      })),
    });
  }
  return services;
}

async function snapshot(command: ActivationCommand, rootDir: string) {
  // Refuse invalid local scope/ownership before any declared external service probe.
  snapshotState(command, rootDir, []);
  const services = await inspectServices(command);
  return snapshotState(command, rootDir, services);
}

/** No awaits: this state is read again immediately before the apply claim. */
function snapshotState(
  command: ActivationCommand,
  rootDir: string,
  services: Awaited<ReturnType<typeof inspectServices>>
) {
  const viewerScopeMode = getRegisteredEnvText('KYBERION_VIEWER_SCOPE') || 'warn';
  if (!['warn', 'enforce'].includes(viewerScopeMode))
    refuse('Viewer scope must currently be audited or enforced.');
  const binding = loadOnboardingContextBinding(command.customerSlug, rootDir);
  if (
    !binding ||
    binding.customer_slug !== command.customerSlug ||
    binding.tenant_slug !== command.tenantSlug ||
    binding.organization_id !== command.organizationId ||
    binding.tier !== command.tier ||
    binding.owner_id !== command.ownerId
  )
    refuse('The current server-owned organization binding or accountable owner changed.');
  if (!binding.default_service_ids.every((id) => command.serviceIds.includes(id)))
    refuse('The bound service set changed; request a new activation approval.');
  const ownerMemberId = command.ownerId.slice('human:'.length);
  if (
    !command.ownerId.startsWith('human:') ||
    humanActor(ownerMemberId).id !== 'user:' + ownerMemberId
  )
    refuse('The accountable resource is not a canonical human member.');
  const owner = readMemberProfile(ownerMemberId, { rootDir });
  if (
    !owner ||
    owner.status !== 'active' ||
    !owner.memberships.some(
      (entry) => entry.tenant_slug === command.tenantSlug && entry.role === 'owner'
    )
  )
    refuse('The accountable human no longer has active owner membership.');
  const tenant = readTenantProfile(command.tenantSlug, { rootDir });
  const organization = loadOrganizationOperationalState(command.organizationId, {
    tier: command.tier,
    tenantSlug: command.tenantSlug,
    rootDir,
  });
  const nhi = command.nhiIds.map((id) => {
    const parsed = parseNhiId(id);
    const identity = getAgentIdentity(id);
    if (
      !parsed ||
      parsed.organization_id !== command.organizationId ||
      !identity ||
      !['active', 'provisioned'].includes(identity.lifecycle_status) ||
      identity.affiliation.organization_id !== command.organizationId ||
      identity.affiliation.tenant_slug !== command.tenantSlug ||
      ![command.ownerId, humanActor(ownerMemberId).id].includes(identity.accountable_human_id)
    )
      refuse('The NHI must be provisioned, tenant-bound and accountable to this owner.');
    const { runtime_instances: _ephemeral, ...stable } = identity;
    return stable;
  });
  const probe = readProbe(command, rootDir);
  const ready = resolveTenantActivation(activationInput(command, rootDir)).record;
  if (ready.blockers.length || ready.status !== 'ready')
    refuse('Activation is blocked or already active: ' + ready.blockers.join('; '));
  // The resolver creates timestamps on every read. They are not evidence of a change.
  const {
    created_at: _created,
    updated_at: _updated,
    activated_at: _activated,
    ...readiness
  } = ready;
  const ownerSnapshot = {
    member_id: owner.member_id,
    status: owner.status,
    memberships: owner.memberships.filter((entry) => entry.tenant_slug === command.tenantSlug),
  };
  return {
    tenant: {
      tenant_slug: command.tenantSlug,
      status: tenant?.status,
      isolation_policy: tenant?.isolation_policy,
      profileDigest: computeApprovalPayloadHash({ tenant }),
    },
    viewerScopeMode,
    binding,
    owner: ownerSnapshot,
    organization,
    nhi,
    services,
    readiness,
    priorActivation: loadTenantActivation(command, rootDir),
    probeDigest: probe.digest,
    probeCreatedAt: probe.createdAt,
  };
}
function readPayload(record: ApprovalRequestRecord): ActivationPayload {
  const parsed = payloadSchema.safeParse(
    parseSafeJsonInput(record.sourceText || '', 'activation approval payload')
  );
  if (!parsed.success) refuse('Invalid activation approval payload.');
  return parsed.data;
}
function assertRecordScope(
  record: ApprovalRequestRecord,
  command: ActivationCommand,
  auth: SurfaceManagementAuthorization
): void {
  if (
    record.channel !== TENANT_ACTIVATION_APPROVAL_CHANNEL ||
    record.storageChannel !== TENANT_ACTIVATION_APPROVAL_CHANNEL ||
    record.kind !== 'mission_gate' ||
    record.scope?.scope_kind !== 'tenant' ||
    record.scope.tenant_slug !== auth.tenantSlug ||
    record.scope.organization_id !== command.organizationId ||
    record.scope.tier !== command.tier ||
    command.tenantSlug !== auth.tenantSlug ||
    command.ownerId !== 'human:' + auth.memberId ||
    record.accountability?.finalDecision !== 'human_only' ||
    record.accountability.effectBinding !== effectBinding(command)
  )
    refuse('Approval scope or accountable human does not match the verified owner.');
}

/** Creates a pending request only. A separate human-authenticated decision surface decides it. */
export async function requestTenantActivationApproval(
  auth: SurfaceManagementAuthorization,
  input: RequestTenantActivationApprovalInput,
  principal: ResolvedPrincipal,
  options: TenantActivationApprovalOptions = {}
): Promise<TenantActivationApprovalView> {
  const allowed = ['customerSlug', 'organizationId', 'tier', 'nhiIds', 'serviceIds', 'evidenceRef'];
  if (!input || Object.keys(input).some((key) => !allowed.includes(key)))
    refuse('Unsupported activation request fields.');
  assertPrincipal(auth, principal, input.organizationId, input.tier || 'confidential');
  await verifySurfaceManagementAuthorization(auth);
  const rootDir = options.rootDir || pathResolver.rootDir();
  const binding = loadOnboardingContextBinding(input.customerSlug, rootDir);
  const command = commandSchema.parse({
    ...input,
    tenantSlug: auth.tenantSlug,
    tier: input.tier || 'confidential',
    ownerId: 'human:' + auth.memberId,
    nhiIds: canonicalSet(input.nhiIds),
    serviceIds: canonicalSet([
      ...(binding?.default_service_ids ?? []),
      ...(input.serviceIds ?? []),
    ]),
  });
  const payload: ActivationPayload = {
    kind: 'tenant_activation_approval',
    version: '1.0.0',
    command,
    snapshot: await snapshot(command, rootDir),
  };
  assertPrincipal(auth, principal, command.organizationId, command.tier);
  await verifySurfaceManagementAuthorization(auth);
  // The approval's scope (auth tenant) and the activated tenant (command) must be one tenant.
  if (command.tenantSlug !== auth.tenantSlug)
    refuse('The activation command names another tenant than the verified owner.');
  const expiry = Number(payload.snapshot.probeCreatedAt) + TENANT_ACTIVATION_EVIDENCE_MAX_AGE_MS;
  if (expiry <= Date.now()) refuse('Probe evidence expired while preparing approval.');
  const approval = createApprovalRequest('mission_controller', {
    channel: TENANT_ACTIVATION_APPROVAL_CHANNEL,
    threadTs: command.organizationId,
    correlationId: effectBinding(command),
    requestedBy: auth.actorId,
    kind: 'mission_gate',
    scope: {
      scope_kind: 'tenant',
      tenant_slug: auth.tenantSlug,
      organization_id: command.organizationId,
      tier: command.tier,
    },
    sourceText: JSON.stringify(payload),
    // A request for a tenant that is not yet active stays in the system
    // approval tree; an already-active tenant's lands in its partition.
    tenantActive: isTenantActivationActive(command, rootDir),
    expiresAt: new Date(expiry).toISOString(),
    draft: {
      title: 'Activate ' + command.customerSlug,
      severity: 'high',
      summary:
        'Activate tenant ' +
        command.tenantSlug +
        ', organization ' +
        command.organizationId +
        ' (' +
        command.tier +
        ') under ' +
        auth.actorId +
        '.',
      details:
        'NHI: ' +
        command.nhiIds.join(', ') +
        '\nServices: ' +
        (command.serviceIds.join(', ') || 'none') +
        '\nProbe: ' +
        command.evidenceRef +
        '\nThis approval enables the tenant activation gate once. It does not start first work.',
    },
    requestedByContext: { surface: 'api', actorId: auth.actorId, actorRole: 'owner' },
    risk: { level: 'high', restartScope: 'none', requiresStrongAuth: true },
    accountability: {
      finalDecision: 'human_only',
      min_assurance: 'A2',
      payloadHash: computeApprovalPayloadHash(payload),
      effectBinding: effectBinding(command),
    },
  });
  return { approval, presentedDigest: computeApprovalPresentedDigest(approval) };
}

/** Read the existing approval without changing its decision or extending evidence freshness. */
export async function readTenantActivationApproval(
  auth: SurfaceManagementAuthorization,
  input: { approvalRequestId: string },
  principal: ResolvedPrincipal
): Promise<TenantActivationApprovalView> {
  assertPrincipal(auth, principal);
  await verifySurfaceManagementAuthorization(auth);
  const approval = loadApprovalRequest(TENANT_ACTIVATION_APPROVAL_CHANNEL, input.approvalRequestId);
  if (!approval) refuse('Approval request not found.');
  const payload = readPayload(approval);
  assertRecordScope(approval, payload.command, auth);
  assertPrincipal(auth, principal, payload.command.organizationId, payload.command.tier);
  return { approval, presentedDigest: computeApprovalPresentedDigest(approval) };
}

/** At-most-once application; failed or interrupted claims require explicit recovery/new approval. */
export async function applyApprovedTenantActivation(
  auth: SurfaceManagementAuthorization,
  input: { approvalRequestId: string },
  principal: ResolvedPrincipal,
  options: TenantActivationApprovalOptions = {}
): Promise<TenantActivationRecord> {
  const view = await readTenantActivationApproval(auth, input, principal);
  const approval = view.approval;
  const payload = readPayload(approval);
  if (
    approval.status !== 'approved' ||
    isApprovalRequestExpired(approval) ||
    approval.applyClaim ||
    approval.applyResult
  )
    refuse('A current, unused approved request is required.');
  if (
    approval.decidedBy !== auth.actorId ||
    approval.decidedByIdentitySource === 'caller_supplied' ||
    approval.verifiedPresentedDigest !== view.presentedDigest ||
    approval.assuranceShortfall
  )
    refuse('A verified presented decision by this accountable owner is required.');
  validateHumanFinalDecision({
    accountability: approval.accountability,
    channel: approval.channel,
    decidedByType: approval.decidedByType,
    authenticated: approval.authenticated,
    authMethod: approval.decidedAuthMethod,
    payloadHash: computeApprovalPayloadHash(payload),
    effectBinding: effectBinding(payload.command),
    phase: 'decision',
    mode: 'enforce',
  });
  const lock =
    'tenant-activation-' + computeApprovalPayloadHash({ scope: effectBinding(payload.command) });
  if (!(await acquireLock(lock))) refuse('Activation is busy; reload its status before retrying.');
  try {
    assertPrincipal(auth, principal, payload.command.organizationId, payload.command.tier);
    await verifySurfaceManagementAuthorization(auth);
    const rootDir = options.rootDir || pathResolver.rootDir();
    const current = await snapshot(payload.command, rootDir);
    if (!same(current, payload.snapshot))
      refuse('Activation state changed after review; run probes and request a new approval.');
    assertPrincipal(auth, principal, payload.command.organizationId, payload.command.tier);
    await verifySurfaceManagementAuthorization(auth);
    assertPrincipal(auth, principal, payload.command.organizationId, payload.command.tier);
    if (!same(snapshotState(payload.command, rootDir, current.services), payload.snapshot))
      refuse('Activation state changed before apply; run probes and request a new approval.');
    // The exact record hash is compared under the approval transition lock: revocation wins the race.
    const claimed = claimApprovalApply('mission_controller', {
      channel: approval.channel,
      requestId: approval.id,
      appliedBy: auth.actorId,
      expectedRecordHash: computeApprovalPayloadHash({ record: approval }),
    });
    let activated: TenantActivationRecord;
    try {
      activated = applyTenantActivation({
        ...activationInput(payload.command, rootDir),
        accept: true,
      });
    } catch (error) {
      recordApprovalApplyResult('mission_controller', {
        channel: approval.channel,
        requestId: approval.id,
        claimId: claimed.applyClaim.claimId,
        applyResult: { result: 'failed', appliedAt: nowIso(), appliedBy: auth.actorId },
      });
      throw error;
    }
    recordApprovalApplyResult('mission_controller', {
      channel: approval.channel,
      requestId: approval.id,
      claimId: claimed.applyClaim.claimId,
      applyResult: { result: 'success', appliedAt: nowIso(), appliedBy: auth.actorId },
    });
    return activated;
  } finally {
    releaseLock(lock);
  }
}
