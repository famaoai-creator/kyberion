import { serviceAllocationApprovedByOwner } from './service-credential-grant-scope.js';
import { PERSONAL_CREDENTIAL_CAPABILITY } from './personal-credential-grant-scope.js';
export type { ServiceCredentialAllocationScope } from './service-credential-grant-scope.js';
/**
 * PG-03: standing grants — scoped, time-bounded permissions that are decided
 * ahead of time instead of right before the work
 * (docs/developer/improvement-plans-2026-10/PERMISSION_GRANT_UNIFICATION_PLAN_2026-10-19.ja.md §2.3, §5, §6).
 *
 * Storage: `active/shared/runtime/grants/<tier>/<tenant|shared>/<grant_id>.json`
 * — a registered tier/tenant-partitioned runtime state root
 * (`PARTITIONED_RUNTIME_STATE_ROOTS.grants`), so tier-guard applies the
 * tenant check of `knowledge/<tier>/<tenant>/` to every read and write.
 * Tenant grants live in the confidential tier and never under `system/`.
 *
 * Mirrors work-inventory-consent.ts:
 *   - the audit event is recorded before the record is written, so a grant
 *     never exists without an audit trail;
 *   - revocation keeps the record and adds `revoked`;
 *   - a stored record that fails the schema or a semantic rule (expiry beyond
 *     the capability's max_ttl_days, missing scope key, external_io without an
 *     approval basis, misplaced file) is treated as absent: it grants nothing.
 *
 * Granting an `external_io` capability needs a human approval bound by
 * payloadHash to exactly the draft (capability, tenant, meetings, purpose,
 * lifetime): `requestGrantApproval` files it on the `grant-standing` approval
 * channel, a human decides with `pnpm kyberion approvals --approve <id>`, and
 * `grantStanding` re-validates and consumes it once (same flow as
 * mission scope-approve). Other standing capabilities are granted directly by
 * the terminal's operator principal (`grantStandingDirect`).
 */
import { createHash, randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { withStoreGrant } from '../authority.js';
import { auditChain } from './audit-chain.js';
import { parseActorRef } from '../contracts/actor.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeUnlinkSync,
} from '../secure-io.js';
import {
  PARTITIONED_RUNTIME_STATE_ROOTS,
  storagePartitionSegments,
  type StorageDataTier,
} from '../storage-layout.js';
import type { StandingGrantCapabilityPolicy } from './grant-capability-policy.js';
import {
  assertApprovalUsable,
  evaluateApprovalUsability,
} from './approval-separation-of-duties.js';
import { assuranceOfAuthMethod } from './approval-assurance.js';
import { computeApprovalPayloadHash } from './approval-presentation.js';
import { createApprovalRequest } from './approval-request-create.js';
import {
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
} from './approval-store-reader.js';
import { validateHumanFinalDecision } from './approval-human-decision.js';
import {
  memberIdOfPrincipal,
  personPrincipal,
  type CredentialLendingScope,
} from '../secret/credential-custody.js';
import type { ApprovalAssuranceLevel, ApprovalRequestRecord } from './approval-store.js';
import { markApprovalConsumed, revokeStandingEffectApproval } from './approval-revocation.js';
import {
  approvalRequesterActorId,
  resolveApprovalRequesterInput,
  type ApprovalRequesterInput,
} from './approval-requester.js';
import {
  CLI_OPERATOR_PROVISION_COMMAND,
  detectCliAgentPrincipal,
  resolveCliOperatorIdentity,
} from './cli-operator-principal.js';
import {
  DAY_MS,
  GRANT_APPROVAL_CHANNEL,
  GrantError,
  codepointCompare,
  grantBaseExpiry,
  normalizeGrantDraft,
  requireStandingGrantPolicy,
  validateGrantRecord,
  type GrantDraft,
  type GrantExtension,
  type GrantRecord,
  type GrantedBy,
  type NormalizedGrantDraft,
} from './grant-record.js';
export {
  GRANT_APPROVAL_CHANNEL,
  GrantError,
  grantBaseExpiry,
  normalizeGrantDraft,
  normalizeMeetingUrl,
  requireStandingGrantPolicy,
  validateGrantRecord,
  validatePersonalCredentialGrantRecord,
} from './grant-record.js';
export type {
  GrantDraft,
  GrantErrorCode,
  GrantExtension,
  GrantedBy,
  GrantRecord,
  GrantScope,
  NormalizedGrantDraft,
} from './grant-record.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Separation-of-duties consumer id (approval-sod-consumers.contract.test.ts). */
export const GRANT_APPROVAL_CONSUMER = 'grant_standing';
/** Separate consumer for extension approvals: an extension never mints a grant. */
export const GRANT_EXTENSION_CONSUMER = 'grant_extension';
/**
 * An expired grant may still be extended (owner approval) for this many days
 * after its expiry; it grants nothing meanwhile. Past the grace window a new
 * grant must be requested. A revoked grant is never extended.
 */
export const GRANT_EXTENSION_GRACE_DAYS = 7;
const GRANT_ID_PATTERN = /^GRT-\d{8}-[a-f0-9]{12}$/;
const GRANT_MUTATION_LOCK = 'standing-grant-mutation';
/** Tenant grants are operator governance data of that tenant: confidential tier. */
const GRANT_TIER: StorageDataTier = 'confidential';
/**
 * Store grant that owns every tenant-partition write below (record, pending
 * marker, unlink). Always bound to the record's tenant — never to the caller's.
 */
const CREDENTIAL_ALLOCATION_STORE_GRANT = 'credential_allocation_store';

/** Run `fn` inside the grant-store's tenant-bound declared store grant. */
function inGrantScope<T>(tenantSlug: string | undefined, fn: () => T): T {
  return withStoreGrant(CREDENTIAL_ALLOCATION_STORE_GRANT, fn, { tenantSlug });
}
const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function grantPartitionDir(tenantSlug: string | undefined): string {
  return pathResolver.rootResolve(
    path.posix.join(
      PARTITIONED_RUNTIME_STATE_ROOTS.grants,
      ...storagePartitionSegments({ kind: 'tier', tier: GRANT_TIER, tenant: tenantSlug })
    )
  );
}

export function grantRecordPath(tenantSlug: string | undefined, grantId: string): string {
  if (!GRANT_ID_PATTERN.test(grantId)) {
    throw new GrantError('invalid_input', `invalid grant id: ${grantId}`);
  }
  return assertSafeRepositoryPath(path.join(grantPartitionDir(tenantSlug), `${grantId}.json`), {
    allowMissingLeaf: true,
  });
}

function writeGrant(record: GrantRecord, createOnly = false): void {
  const check = validateGrantRecord(record);
  if (!check.valid) {
    throw new GrantError(
      'invalid_input',
      `invalid grant ${record.grant_id}: ${check.errors.join('; ')}`
    );
  }
  const filePath = grantRecordPath(record.scope.tenant_slug, record.grant_id);
  inGrantScope(record.scope.tenant_slug, () => {
    safeMkdir(path.dirname(filePath), { recursive: true });
    writeJson(filePath, record, { createOnly });
  });
}

/** Load one grant; null when missing, unreadable, invalid or misplaced (fail closed). */
export function loadGrant(tenantSlug: string | undefined, grantId: string): GrantRecord | null {
  let filePath: string;
  try {
    filePath = grantRecordPath(tenantSlug, grantId);
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = readJsonIfPresent<unknown>(filePath);
  } catch {
    return null;
  }
  if (!raw || !validateGrantRecord(raw).valid) return null;
  const record = raw as GrantRecord;
  if (record.grant_id !== grantId || record.scope.tenant_slug !== tenantSlug) return null;
  return record;
}

function grantIdsIn(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/u, ''))
    .filter((id) => GRANT_ID_PATTERN.test(id))
    .sort(codepointCompare);
}

function tenantPartitions(): string[] {
  const tierDir = pathResolver.rootResolve(
    path.posix.join(PARTITIONED_RUNTIME_STATE_ROOTS.grants, GRANT_TIER)
  );
  if (!safeExistsSync(tierDir)) return [];
  return safeReaddir(tierDir)
    .filter((name) => isValidTenantSlug(name))
    .sort(codepointCompare);
}

export interface ListGrantsOptions {
  tenant_slug?: string;
  capability?: string;
}

/**
 * Valid grant records (active, expired and revoked), oldest first. Without a
 * tenant, every tenant partition the caller may read is listed; partitions the
 * caller's identity may not read are skipped.
 */
export function listGrants(options: ListGrantsOptions = {}): GrantRecord[] {
  const tenants = options.tenant_slug ? [options.tenant_slug] : tenantPartitions();
  const records: GrantRecord[] = [];
  for (const tenant of tenants) {
    if (!isValidTenantSlug(tenant)) {
      throw new GrantError('invalid_input', `invalid tenant slug: ${tenant}`);
    }
    let ids: string[];
    try {
      ids = grantIdsIn(grantPartitionDir(tenant));
    } catch (err: unknown) {
      if (options.tenant_slug) throw err;
      continue;
    }
    for (const id of ids) {
      const record = loadGrant(tenant, id);
      if (!record) continue;
      if (options.capability && record.capability !== options.capability) continue;
      records.push(record);
    }
  }
  return records.sort(
    (a, b) =>
      codepointCompare(a.granted_at, b.granted_at) || codepointCompare(a.grant_id, b.grant_id)
  );
}

export type GrantStatus = 'active' | 'expired' | 'revoked' | 'not_yet_valid';

export function grantStatusAt(record: GrantRecord, at: Date): GrantStatus {
  const t = at.getTime();
  if (record.revoked && Date.parse(record.revoked.at) <= t) return 'revoked';
  if (t < Date.parse(record.granted_at)) return 'not_yet_valid';
  if (t >= Date.parse(record.expires_at)) return 'expired';
  return 'active';
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Who acted on a grant, as resolved by the entry point (never a free-text default). */
export interface GrantActor {
  kind: 'human' | 'agent';
  id: string;
}

function recordGrantAudit(
  action: string,
  record: GrantRecord,
  by: GrantActor,
  extra: Record<string, unknown> = {}
): string {
  // Purpose (free text) and meeting URLs stay out of the audit metadata —
  // entries may be forwarded to tenant SIEMs, so only identifiers and counts go in.
  // The structured actor is set only when the id parses as that kind; the
  // kind itself is always recorded, so an agent is never logged as a human.
  const actor = parseActorRef({ kind: by.kind, id: by.id }) ?? undefined;
  const entry = auditChain.record({
    agentId: by.id,
    ...(actor ? { actor } : {}),
    action,
    operation: record.grant_id,
    result: 'completed',
    ...(record.scope.tenant_slug ? { tenantSlug: record.scope.tenant_slug } : {}),
    metadata: {
      grant_id: record.grant_id,
      actor_kind: by.kind,
      capability: record.capability,
      granted_at: record.granted_at,
      expires_at: record.expires_at,
      meeting_series_count: record.scope.meeting_series_ids?.length ?? 0,
      meeting_url_count: record.scope.meeting_urls?.length ?? 0,
      ...(record.basis ? { approval_request_id: record.basis.approval_request_id } : {}),
      ...(record.scope.tenant_slug ? { tenant_slug: record.scope.tenant_slug } : {}),
      ...extra,
    },
  });
  return entry.id;
}

function generateGrantId(now: Date): string {
  const datePart = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `GRT-${datePart}-${randomBytes(6).toString('hex')}`;
}

function writeNewGrant(
  draft: NormalizedGrantDraft,
  grantedBy: GrantedBy,
  basis: GrantRecord['basis'],
  now: Date,
  identity: { grantId?: string; grantedAt?: string } = {}
): GrantRecord {
  const grantedAt = identity.grantedAt ?? nowIso(now);
  const grantedMs = Date.parse(grantedAt);
  const pending: Omit<GrantRecord, 'audit_event_id'> = {
    schema_version: 'grant-record.v1',
    grant_id: identity.grantId ?? generateGrantId(now),
    capability: draft.capability,
    scope: {
      tenant_slug: draft.tenant_slug,
      ...(draft.service_allocation ? { service_allocation: draft.service_allocation } : {}),
      ...(draft.credential_provider ? { credential_provider: draft.credential_provider } : {}),
      ...(draft.credential_ref ? { credential_ref: draft.credential_ref } : {}),
      ...(draft.credential_lending ? { credential_lending: draft.credential_lending } : {}),
      ...(draft.meeting_series_ids.length ? { meeting_series_ids: draft.meeting_series_ids } : {}),
      ...(draft.meeting_urls.length ? { meeting_urls: draft.meeting_urls } : {}),
    },
    purpose: draft.purpose,
    granted_by: grantedBy,
    ...(basis ? { basis } : {}),
    granted_at: grantedAt,
    expires_at: new Date(grantedMs + draft.ttl_days * DAY_MS).toISOString(),
  };
  // Validate before the audit so an invalid grant leaves no "granted" event.
  const precheck = validateGrantRecord({ ...pending, audit_event_id: 'pending' });
  if (!precheck.valid) throw new GrantError('invalid_input', precheck.errors.join('; '));
  const auditEventId = recordGrantAudit('grant.granted', pending as GrantRecord, {
    kind: 'human',
    id: grantedBy.actor_id,
  });
  const record: GrantRecord = { ...pending, audit_event_id: auditEventId };
  writeGrant(record, true);
  return record;
}

// ---------------------------------------------------------------------------
// Approval-mediated grant (external_io)
// ---------------------------------------------------------------------------

export function grantApprovalEffectBinding(draft: NormalizedGrantDraft): string {
  return `grant-standing:${draft.capability}:${draft.tenant_slug}${draft.credential_provider ? `:${draft.credential_provider}` : ''}`;
}

/** Canonical payload hashed into the approval: every field the human approved. */
export function grantApprovalPayload(draft: NormalizedGrantDraft): Record<string, unknown> {
  return {
    ...(draft.service_allocation ? { service_allocation: draft.service_allocation } : {}),
    ...(draft.credential_provider ? { credential_provider: draft.credential_provider } : {}),
    ...(draft.credential_ref ? { credential_ref: draft.credential_ref } : {}),
    ...(draft.credential_lending ? { credential_lending: draft.credential_lending } : {}),
    action: 'grant_standing',
    capability: draft.capability,
    tenant_slug: draft.tenant_slug,
    meeting_series_ids: draft.meeting_series_ids,
    meeting_urls: draft.meeting_urls,
    purpose: draft.purpose,
    ttl_days: draft.ttl_days,
    effect: grantApprovalEffectBinding(draft),
  };
}

/** What the human reads before approving. */
export function buildGrantApprovalDetails(
  draft: NormalizedGrantDraft,
  requestedBy: string
): string {
  const lines = [`Capability: ${draft.capability}`, `Tenant: ${draft.tenant_slug}`];
  if (draft.service_allocation)
    lines.push(`Service allocation: ${JSON.stringify(draft.service_allocation)}`);
  if (draft.credential_provider) lines.push(`Credential provider: ${draft.credential_provider}`);
  if (draft.credential_ref) lines.push(`Credential reference: ${draft.credential_ref}`);
  if (draft.credential_lending) {
    const lending = draft.credential_lending;
    lines.push(
      `Credential lent: ${lending.credential_ref} (${lending.kind}, ${lending.terms} terms, plan ${lending.plan}) to tenant ${draft.tenant_slug}`,
      `Backends: ${lending.allowed_backends.join(', ')}`,
      ...(lending.budget_monthly_usd !== undefined
        ? [`Monthly budget: $${lending.budget_monthly_usd} (80% notifies, 100% stops new runs)`]
        : []),
      ...(lending.token_expires_at ? [`Token expires: ${lending.token_expires_at}`] : []),
      `Approver must be the credential owner (${lending.custody === 'person' ? `user:${lending.owner}` : `an owner of tenant ${lending.owner}`})`
    );
  }
  if (draft.meeting_series_ids.length) {
    lines.push(`Meeting series: ${draft.meeting_series_ids.join(', ')}`);
  }
  if (draft.meeting_urls.length) lines.push(`Meeting URLs: ${draft.meeting_urls.join(', ')}`);
  lines.push(
    `Purpose: ${draft.purpose}`,
    `Expires: ${draft.ttl_days} day(s) after the grant is applied`,
    `Requested by: ${requestedBy}`,
    draft.credential_provider || draft.service_allocation
      ? 'Effect if approved: matching tenant tasks may resolve the named provider credential until expiry or revocation. Tool authority, egress and budgets remain separate.'
      : 'Effect if approved: a standing grant is created; matching meetings may be recorded without a per-mission consent until it expires or is revoked (`pnpm kyberion grants revoke <grant_id>`).'
  );
  return lines.join('\n');
}

/** The open request for exactly this draft: pending, or approved and still usable. */
export function findGrantApprovalRequest(
  draft: NormalizedGrantDraft
): ApprovalRequestRecord | undefined {
  const payloadHash = computeApprovalPayloadHash(grantApprovalPayload(draft));
  const effectBinding = grantApprovalEffectBinding(draft);
  return listApprovalRequests({
    storageChannels: [GRANT_APPROVAL_CHANNEL],
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      record.accountability?.payloadHash === payloadHash &&
      record.accountability?.effectBinding === effectBinding &&
      !record.consumption &&
      !record.applyClaim &&
      !isApprovalRequestExpired(record) &&
      (record.status !== 'approved' ||
        !evaluateApprovalUsability(record, { consumer: GRANT_APPROVAL_CONSUMER }))
  );
}

/** Open (or reuse) the hash-bound human approval request for an external_io grant. */
export function requestGrantApproval(
  draft: GrantDraft,
  options: { requester: ApprovalRequesterInput; now?: Date }
): ApprovalRequestRecord {
  const normalized = normalizeGrantDraft(draft);
  const policy = requireStandingGrantPolicy(normalized.capability);
  if (!policy.external_io) {
    throw new GrantError(
      'invalid_input',
      `${normalized.capability} is not external_io; grant it directly without an approval`
    );
  }
  // Design §2.3: an ineligible lending never reaches the owner's approval queue.
  assertCredentialLendingEligible(normalized, options.now ?? new Date());
  const existing = findGrantApprovalRequest(normalized);
  if (existing) return existing;
  const requester = resolveApprovalRequesterInput(options.requester);
  const now = options.now ?? new Date();
  const effectBinding = grantApprovalEffectBinding(normalized);
  const details = buildGrantApprovalDetails(normalized, requester.requestedBy);
  const sameTenantCredential =
    normalized.credential_lending?.custody === 'tenant' &&
    normalized.credential_lending.owner === normalized.tenant_slug;
  const approvalRole = sameTenantCredential ? 'owner' : 'sovereign';
  return createApprovalRequest('mission_controller', {
    channel: GRANT_APPROVAL_CHANNEL,
    storageChannel: GRANT_APPROVAL_CHANNEL,
    threadTs: `${normalized.capability}:${normalized.tenant_slug}`,
    correlationId: effectBinding,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    ...(sameTenantCredential
      ? { scope: { tier: 'confidential', tenant_slug: normalized.tenant_slug } }
      : {}),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    kind: 'channel-approval',
    draft: {
      title: `Standing grant: ${normalized.capability} for ${normalized.tenant_slug}`,
      summary: `Approve a ${normalized.ttl_days}-day standing grant of ${normalized.capability} for tenant ${normalized.tenant_slug}.`,
      details,
      severity: 'high',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: 'grant-standing',
    },
    justification: {
      reason: `Standing grant of ${normalized.capability}: ${normalized.purpose}`,
      requestedEffects: [effectBinding],
      impactSummary: details,
    },
    risk: { level: 'high', restartScope: 'manual', requiresStrongAuth: true, policyId: 'PG-03' },
    workflow: {
      workflowId: `pg-03-grant-${normalized.capability}-${normalized.tenant_slug}`,
      mode: 'all_required',
      requiredRoles: [approvalRole],
      stages: [],
      approvals: [{ role: approvalRole, status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: computeApprovalPayloadHash(grantApprovalPayload(normalized)),
      effectBinding,
    },
  });
}

/**
 * Registry-backed rules of credential lending (design §2.3–2.4), installed by
 * secret/credential-allocations.ts (the broker) so this store does not import
 * the member / tenant registries. Unregistered = every lending approval fails closed.
 */
export interface CredentialLendingPolicy {
  /** Is the member an owner member of the tenant (approver of that tenant's credentials)? */
  ownsTenant(memberId: string, tenant: string): boolean;
  /** Member id of the installation person who owns knowledge/personal/ (person custody). */
  installationPerson(): string | undefined;
  /** Throws the classified eligibility refusal for this borrower now. */
  assertEligible(lending: CredentialLendingScope, borrowerTenant: string, now: Date): void;
}
let lendingPolicy: CredentialLendingPolicy | undefined;
export function registerCredentialLendingPolicy(policy: CredentialLendingPolicy | undefined): void {
  lendingPolicy = policy;
}

/**
 * The lending was approved by the credential's owner: the person holding it,
 * or an owner member of the tenant holding it — same authenticated human-only
 * decision rule as a service allocation.
 */
export function credentialLendingApprovedByOwner(
  lending: CredentialLendingScope,
  approval: ApprovalRequestRecord
): boolean {
  if (lending.custody === 'person') {
    // Review S1: person custody is the installation person's personal store only.
    let person: string | undefined;
    try {
      person = lendingPolicy?.installationPerson();
    } catch {
      person = undefined;
    }
    return (
      Boolean(person) &&
      person === lending.owner &&
      serviceAllocationApprovedByOwner(approval, personPrincipal(lending.owner))
    );
  }
  const approver = approval.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  )?.approvedBy;
  const memberId = approver ? memberIdOfPrincipal(approver) : undefined;
  if (!approver || !memberId || !lendingPolicy) return false;
  try {
    return (
      serviceAllocationApprovedByOwner(approval, approver) &&
      lendingPolicy.ownsTenant(memberId, lending.owner)
    );
  } catch {
    return false;
  }
}

function assertCredentialLendingApproval(
  draft: NormalizedGrantDraft,
  approval: ApprovalRequestRecord
): void {
  const lending = draft.credential_lending!;
  if (!credentialLendingApprovedByOwner(lending, approval))
    throw new GrantError(
      'approval_invalid',
      `credential lending requires the authenticated decision of the credential owner (${lending.custody === 'person' ? personPrincipal(lending.owner) : `an owner of tenant ${lending.owner}`})`
    );
  assertCredentialLendingEligible(draft);
}

/** Eligibility at request / approval time (the broker re-checks at every use). */
export function assertCredentialLendingEligible(
  draft: Pick<NormalizedGrantDraft, 'credential_lending' | 'tenant_slug'>,
  now: Date = new Date()
): void {
  if (!draft.credential_lending) return;
  if (!lendingPolicy)
    throw new GrantError('invalid_state', 'credential lending policy is not installed');
  lendingPolicy.assertEligible(draft.credential_lending, draft.tenant_slug, now);
}

/**
 * Apply-side validation (mirrors assertScopeChangeApproval): approved by an
 * authenticated human, unexpired, usable (not revoked / consumed, separation
 * of duties) and bound by payloadHash to exactly this draft.
 */
export function assertGrantApproval(
  draft: NormalizedGrantDraft,
  approvalRequestId: string
): ReturnType<typeof checkGrantApproval> {
  return checkGrantApproval(draft, approvalRequestId);
}

function checkGrantApproval(
  draft: NormalizedGrantDraft,
  approvalRequestId: string,
  allowConsumed = false
): {
  approval: ApprovalRequestRecord;
  humanDecider: string;
  assurance: ApprovalAssuranceLevel;
  role: GrantedBy['role'];
} {
  const checked = assertHumanGrantDecision(approvalRequestId, {
    consumer: GRANT_APPROVAL_CONSUMER,
    allowConsumed,
    effectBinding: grantApprovalEffectBinding(draft),
    payloadHash: computeApprovalPayloadHash(grantApprovalPayload(draft)),
    payloadMismatch:
      'grant approval is bound to a different capability/tenant/meetings/purpose/lifetime',
  });
  if (
    draft.service_allocation &&
    !serviceAllocationApprovedByOwner(checked.approval, draft.service_allocation.owner_ref)
  )
    throw new GrantError(
      'approval_invalid',
      'service allocation requires its authenticated personal owner decision'
    );
  if (draft.credential_lending) assertCredentialLendingApproval(draft, checked.approval);
  return checked;
}

/** Validate the human decision and binding, allowing a consumed receipt only for recovery. */
function assertHumanGrantDecision(
  approvalRequestId: string,
  binding: {
    consumer: typeof GRANT_APPROVAL_CONSUMER | typeof GRANT_EXTENSION_CONSUMER;
    effectBinding: string;
    payloadHash: string;
    payloadMismatch: string;
    allowConsumed?: boolean;
  }
): {
  approval: ApprovalRequestRecord;
  humanDecider: string;
  assurance: ApprovalAssuranceLevel;
  role: GrantedBy['role'];
} {
  const approval = loadApprovalRequest(GRANT_APPROVAL_CHANNEL, approvalRequestId);
  if (!approval || approval.status !== 'approved') {
    throw new GrantError(
      'approval_invalid',
      `grant approval ${approvalRequestId} is ${approval?.status ?? 'missing'}, not approved`
    );
  }
  const now = Date.now();
  const consumedAt = approval.consumption ? Date.parse(approval.consumption.consumedAt) : now;
  if (isApprovalRequestExpired(approval, binding.allowConsumed ? consumedAt : now)) {
    throw new GrantError('approval_invalid', `grant approval has expired: ${approval.id}`);
  }
  if (
    (approval.consumption && !binding.allowConsumed) ||
    approval.applyClaim ||
    approval.applyResult
  ) {
    throw new GrantError('approval_invalid', `grant approval ${approval.id} was already used`);
  }
  if (binding.consumer === GRANT_EXTENSION_CONSUMER)
    assertApprovalUsable(approval, { consumer: 'grant_extension' });
  else assertApprovalUsable(approval, { consumer: 'grant_standing' });
  if (approval.accountability?.effectBinding !== binding.effectBinding) {
    throw new GrantError('approval_invalid', 'grant approval is bound to a different effect');
  }
  if (approval.accountability?.payloadHash !== binding.payloadHash) {
    throw new GrantError('approval_invalid', binding.payloadMismatch);
  }
  const humanApproval = approval.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (!humanApproval) {
    throw new GrantError(
      'approval_invalid',
      'grant approval requires an authenticated human decision'
    );
  }
  try {
    validateHumanFinalDecision({
      accountability: approval.accountability,
      decidedByType: humanApproval.decidedByType,
      authenticated: humanApproval.authenticated,
      authMethod: humanApproval.authMethod,
      payloadHash: humanApproval.payloadHash,
      effectBinding: humanApproval.effectBinding,
      phase: 'recheck',
    });
  } catch (err: unknown) {
    throw new GrantError('approval_invalid', err instanceof Error ? err.message : String(err));
  }
  const humanDecider = humanApproval.approvedBy || approval.decidedBy;
  if (!humanDecider) {
    throw new GrantError('approval_invalid', 'grant approval does not name its human decider');
  }
  if (
    approval.consumption &&
    (approval.consumption.consumer !== binding.consumer ||
      approval.consumption.consumedBy !== humanDecider ||
      !Number.isFinite(consumedAt) ||
      consumedAt > now)
  ) {
    throw new GrantError('approval_invalid', 'grant approval has an invalid consumption receipt');
  }
  return {
    approval,
    humanDecider,
    assurance: assuranceOfAuthMethod(humanApproval.authMethod) ?? 'A0',
    role: humanApproval.role === 'sovereign' ? 'sovereign' : 'operator',
  };
}

/** Local recovery intent, kept with the grant partition and quarantined on restore. */
function pendingGrantEffectPath(tenant: string, approvalId: string): string {
  const key = createHash('sha256').update(approvalId).digest('hex');
  return assertSafeRepositoryPath(path.join(grantPartitionDir(tenant), `.pending-${key}.json`), {
    allowMissingLeaf: true,
  });
}

function consumeGrantEffect(
  checked: ReturnType<typeof assertHumanGrantDecision>,
  tenant: string,
  consumer: typeof GRANT_APPROVAL_CONSUMER | typeof GRANT_EXTENSION_CONSUMER,
  effectRef: string
): { consumedAt: string; pendingPath: string } {
  const pendingPath = pendingGrantEffectPath(tenant, checked.approval.id);
  const pending = inGrantScope(tenant, () =>
    readJsonIfPresent<{ effect_ref: string }>(pendingPath)
  );
  const receipt = checked.approval.consumption;
  if (
    (pending && pending.effect_ref !== effectRef) ||
    (receipt && (!pending || receipt.effectRef !== effectRef))
  ) {
    throw new GrantError(
      'approval_invalid',
      'grant approval was already used for a different or unavailable effect'
    );
  }
  if (!pending) {
    inGrantScope(tenant, () => {
      safeMkdir(path.dirname(pendingPath), { recursive: true });
      writeJson(pendingPath, { effect_ref: effectRef }, { createOnly: true });
    });
  }
  const consumed =
    receipt ??
    markApprovalConsumed('mission_controller', {
      channel: GRANT_APPROVAL_CHANNEL,
      requestId: checked.approval.id,
      consumer,
      consumedBy: checked.humanDecider,
      effectRef,
    }).consumption;
  if (!consumed || isApprovalRequestExpired(checked.approval, Date.parse(consumed.consumedAt))) {
    throw new GrantError('approval_invalid', 'grant approval was not consumed before expiry');
  }
  return { consumedAt: consumed.consumedAt, pendingPath };
}

/**
 * Re-check, at use time, that an external_io grant still rests on the human
 * approval it names: the approval exists on the grant channel, was consumed by
 * this consumer, is not revoked, and its payloadHash covers exactly this
 * record's capability/tenant/meetings/purpose/lifetime. A record written or
 * edited outside grantStanding (or whose approval was later revoked) grants
 * nothing.
 */
export function verifyGrantBasis(record: GrantRecord): boolean {
  if ('custody' in record || record.capability === PERSONAL_CREDENTIAL_CAPABILITY) return false;
  let policy: StandingGrantCapabilityPolicy;
  try {
    policy = requireStandingGrantPolicy(record.capability);
  } catch {
    return false;
  }
  if (!policy.external_io) return true;
  const basis = record.basis;
  if (!basis || basis.approval_channel !== GRANT_APPROVAL_CHANNEL) return false;
  try {
    const approval = loadApprovalRequest(GRANT_APPROVAL_CHANNEL, basis.approval_request_id);
    if (!approval || approval.status !== 'approved' || approval.revocation) return false;
    if (
      record.scope.service_allocation &&
      (!validateGrantRecord(record).valid ||
        !serviceAllocationApprovedByOwner(approval, record.scope.service_allocation.owner_ref) ||
        record.granted_by.actor_id !== record.scope.service_allocation.owner_ref)
    )
      return false;
    if (
      record.scope.credential_lending &&
      (!validateGrantRecord(record).valid ||
        !credentialLendingApprovedByOwner(record.scope.credential_lending, approval))
    )
      return false;
    const consumption = approval.consumption;
    if (consumption?.consumer !== GRANT_APPROVAL_CONSUMER) return false;
    // Bound to the record this approval created: same grant id, and the grant
    // started exactly when the approval was consumed (no copy, no time shift).
    if (consumption.effectRef !== record.grant_id) return false;
    if (consumption.consumedAt !== record.granted_at) return false;
    if (record.extensions && !verifyGrantExtensions(record)) return false;
    const lifetimeMs = Date.parse(grantBaseExpiry(record)) - Date.parse(record.granted_at);
    const ttlDays = lifetimeMs / DAY_MS;
    // Exactly the approved number of whole days — no rounding slack.
    if (!Number.isInteger(ttlDays) || ttlDays < 1) return false;
    const draft: NormalizedGrantDraft = {
      capability: record.capability,
      ...(record.scope.service_allocation
        ? { service_allocation: record.scope.service_allocation }
        : {}),
      ...(record.scope.credential_provider
        ? { credential_provider: record.scope.credential_provider }
        : {}),
      ...(record.scope.credential_ref ? { credential_ref: record.scope.credential_ref } : {}),
      ...(record.scope.credential_lending
        ? { credential_lending: record.scope.credential_lending }
        : {}),
      tenant_slug: record.scope.tenant_slug,
      meeting_series_ids: record.scope.meeting_series_ids ?? [],
      meeting_urls: record.scope.meeting_urls ?? [],
      purpose: record.purpose,
      ttl_days: ttlDays,
    };
    return (
      approval.accountability?.effectBinding === grantApprovalEffectBinding(draft) &&
      approval.accountability?.payloadHash ===
        computeApprovalPayloadHash(grantApprovalPayload(draft))
    );
  } catch {
    return false;
  }
}

/**
 * Create a standing grant of an external_io capability under an approved,
 * hash-bound human approval. The approval is consumed (once) before the
 * record is written, so one approval never yields two grants.
 */
export function grantStanding(
  draft: GrantDraft,
  options: { approvalRequestId: string; now?: Date }
): GrantRecord {
  return withLockSync(GRANT_MUTATION_LOCK, () => issueStandingGrant(draft, options), 0);
}

function issueStandingGrant(
  draft: GrantDraft,
  options: { approvalRequestId: string; now?: Date }
): GrantRecord {
  const normalized = normalizeGrantDraft(draft);
  const policy = requireStandingGrantPolicy(normalized.capability);
  const approvalRequestId = String(options.approvalRequestId ?? '').trim();
  if (!approvalRequestId) {
    throw new GrantError(
      'approval_required',
      `${normalized.capability} needs an approval request id`
    );
  }
  if (!policy.external_io) {
    throw new GrantError(
      'invalid_input',
      `${normalized.capability} is not external_io; grant it directly without an approval`
    );
  }
  const checked = checkGrantApproval(normalized, approvalRequestId, true);
  // The consumption names the grant it creates and its time becomes the
  // grant's granted_at, so the stored record is bound to this approval:
  // a copy under another id or a shifted validity window no longer matches
  // (verifyGrantBasis).
  const pending = inGrantScope(normalized.tenant_slug, () =>
    readJsonIfPresent<{ effect_ref: string }>(
      pendingGrantEffectPath(normalized.tenant_slug, checked.approval.id)
    )
  );
  const receipt = checked.approval.consumption;
  const grantId =
    receipt?.effectRef ?? pending?.effect_ref ?? generateGrantId(options.now ?? new Date());
  const recordExists = inGrantScope(normalized.tenant_slug, () =>
    safeExistsSync(grantRecordPath(normalized.tenant_slug, grantId))
  );
  if (recordExists) {
    throw new GrantError(
      'approval_invalid',
      `grant approval ${checked.approval.id} was already used`
    );
  }
  const { consumedAt, pendingPath } = consumeGrantEffect(
    checked,
    normalized.tenant_slug,
    GRANT_APPROVAL_CONSUMER,
    grantId
  );
  if (Date.parse(consumedAt) + normalized.ttl_days * DAY_MS <= Date.now()) {
    throw new GrantError('approval_invalid', 'the approved grant validity window has elapsed');
  }
  const record = writeNewGrant(
    normalized,
    { actor_id: checked.humanDecider, role: checked.role, assurance: checked.assurance },
    { approval_request_id: checked.approval.id, approval_channel: GRANT_APPROVAL_CHANNEL },
    options.now ?? new Date(),
    { grantId, grantedAt: consumedAt }
  );
  inGrantScope(normalized.tenant_slug, () => safeUnlinkSync(pendingPath));
  return record;
}

/**
 * Create a standing grant of a capability that does not need an approval.
 * The grantor is the terminal's operator principal (the local owner member,
 * `cli-operator-principal.ts`) — never a caller-supplied name. Refused inside
 * an agent session (an agent cannot grant on a human's behalf) and when no
 * owner member exists.
 */
export function grantStandingDirect(
  draft: GrantDraft,
  options: { now?: Date; env?: Record<string, string | undefined> } = {}
): GrantRecord {
  const normalized = normalizeGrantDraft(draft);
  const policy = requireStandingGrantPolicy(normalized.capability);
  if (policy.external_io) {
    throw new GrantError(
      'approval_required',
      `${normalized.capability} exchanges data with an external service; request a human approval first (grants grant --request-approval)`
    );
  }
  const agent = detectCliAgentPrincipal(options.env);
  if (agent) {
    throw new GrantError(
      'no_operator_identity',
      `granting runs inside an agent session (${agent}); run it from your own terminal`
    );
  }
  const identity = resolveCliOperatorIdentity(options.env ? { env: options.env } : {});
  if (!identity.principalId) {
    throw new GrantError(
      'no_operator_identity',
      `no operator identity for this terminal; run \`${CLI_OPERATOR_PROVISION_COMMAND}\` first`
    );
  }
  return writeNewGrant(
    normalized,
    { actor_id: identity.principalId, role: 'operator', assurance: 'A0' },
    undefined,
    options.now ?? new Date()
  );
}

// ---------------------------------------------------------------------------
// Extension (owner-approved, same grant: only expires_at moves)
// ---------------------------------------------------------------------------

/** What an operator asks to extend. The step is pinned to the grant's current expiry. */
export interface GrantExtensionDraft {
  grant_id: string;
  tenant_slug: string;
  /** Days from approval consumption; defaults to and never exceeds max_ttl_days. */
  extend_days?: number;
}

/** Effect binding of one extension step: a later step can never reuse an earlier approval. */
export function grantExtensionEffectBinding(grantId: string, previousExpiresAt: string): string {
  return `grant-extend:${grantId}:${previousExpiresAt}`;
}

function grantExtensionEffectRef(grantId: string, previousExpiresAt: string): string {
  return `${grantId}@${previousExpiresAt}`;
}

/** Canonical payload hashed into an extension approval. */
export function grantExtensionPayload(
  record: GrantRecord,
  previousExpiresAt: string,
  extendDays: number
): Record<string, unknown> {
  return {
    action: 'grant_extend',
    grant_id: record.grant_id,
    capability: record.capability,
    tenant_slug: record.scope.tenant_slug,
    ...(record.scope.credential_provider
      ? { credential_provider: record.scope.credential_provider }
      : {}),
    ...(record.scope.credential_ref ? { credential_ref: record.scope.credential_ref } : {}),
    ...(record.scope.service_allocation
      ? { service_allocation: record.scope.service_allocation }
      : {}),
    granted_by: record.granted_by.actor_id,
    previous_expires_at: previousExpiresAt,
    extend_days: extendDays,
    effect: grantExtensionEffectBinding(record.grant_id, previousExpiresAt),
  };
}

/** Whole days until expiry (negative once expired); for status and reminders. */
export function grantDaysLeft(record: Pick<GrantRecord, 'expires_at'>, now: Date): number {
  return Math.floor((Date.parse(record.expires_at) - now.getTime()) / DAY_MS);
}

/**
 * Refuse what may not be extended: revoked, unverifiable basis, not
 * external_io, personal or service allocations (their owner consent is a
 * separate flow), or expired beyond {@link GRANT_EXTENSION_GRACE_DAYS}.
 */
export function assertGrantExtendable(
  record: GrantRecord,
  now: Date,
  extendDays?: number
): { extendDays: number } {
  if (record.revoked || grantStatusAt(record, now) === 'revoked')
    throw new GrantError(
      'invalid_state',
      `grant ${record.grant_id} is revoked; request a new grant`
    );
  const policy = requireStandingGrantPolicy(record.capability);
  if (!policy.external_io || record.scope.service_allocation)
    throw new GrantError('invalid_state', `grant ${record.grant_id} cannot be extended`);
  if (!verifyGrantBasis(record))
    throw new GrantError(
      'invalid_state',
      `grant ${record.grant_id} no longer rests on a valid approval; request a new grant`
    );
  const expiredFor = now.getTime() - Date.parse(record.expires_at);
  if (expiredFor > GRANT_EXTENSION_GRACE_DAYS * DAY_MS)
    throw new GrantError(
      'invalid_state',
      `grant ${record.grant_id} expired more than ${GRANT_EXTENSION_GRACE_DAYS} days ago; request a new grant`
    );
  const days = extendDays ?? policy.max_ttl_days;
  if (!Number.isInteger(days) || days < 1 || days > policy.max_ttl_days)
    throw new GrantError(
      'invalid_input',
      `an extension must be an integer between 1 and ${policy.max_ttl_days} days`
    );
  if (now.getTime() + days * DAY_MS <= Date.parse(record.expires_at))
    throw new GrantError(
      'invalid_input',
      `an extension of ${days} day(s) from now would not move the expiry past ${record.expires_at}`
    );
  return { extendDays: days };
}

function requireExtendableGrant(draft: GrantExtensionDraft): GrantRecord {
  const tenant = String(draft.tenant_slug ?? '').trim();
  if (!isValidTenantSlug(tenant)) throw new GrantError('invalid_input', 'invalid tenant slug');
  const record = findGrantById(String(draft.grant_id ?? '').trim(), tenant);
  if (!record) throw new GrantError('not_found', `grant ${draft.grant_id} not found`);
  return record;
}

/** Open (or reuse) the hash-bound owner approval for one extension step. */
export function requestGrantExtension(
  draft: GrantExtensionDraft,
  options: { requester: ApprovalRequesterInput; now?: Date }
): ApprovalRequestRecord {
  const now = options.now ?? new Date();
  const record = requireExtendableGrant(draft);
  const { extendDays } = assertGrantExtendable(record, now, draft.extend_days);
  const payloadHash = computeApprovalPayloadHash(
    grantExtensionPayload(record, record.expires_at, extendDays)
  );
  const effectBinding = grantExtensionEffectBinding(record.grant_id, record.expires_at);
  const existing = listApprovalRequests({
    storageChannels: [GRANT_APPROVAL_CHANNEL],
    status: ['pending', 'approved'],
  }).find(
    (entry) =>
      entry.accountability?.payloadHash === payloadHash &&
      entry.accountability?.effectBinding === effectBinding &&
      !entry.consumption &&
      !entry.applyClaim &&
      !isApprovalRequestExpired(entry) &&
      (entry.status !== 'approved' ||
        !evaluateApprovalUsability(entry, { consumer: 'grant_extension' }))
  );
  if (existing) return existing;
  const requester = resolveApprovalRequesterInput(options.requester);
  const details = [
    `Grant: ${record.grant_id}`,
    `Capability: ${record.capability}`,
    `Tenant: ${record.scope.tenant_slug}`,
    ...(record.scope.credential_provider
      ? [`Credential provider: ${record.scope.credential_provider}`]
      : []),
    `Current expiry: ${record.expires_at}`,
    `New expiry: ${extendDays} day(s) after this extension is applied`,
    `Requested by: ${requester.requestedBy}`,
    'Effect if approved: the same grant (id, principal, scope, purpose unchanged) stays usable until the new expiry or revocation.',
  ].join('\n');
  return createApprovalRequest('mission_controller', {
    channel: GRANT_APPROVAL_CHANNEL,
    storageChannel: GRANT_APPROVAL_CHANNEL,
    threadTs: `${record.capability}:${record.scope.tenant_slug}:extend`,
    correlationId: effectBinding,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
    kind: 'channel-approval',
    draft: {
      title: `Extend standing grant ${record.grant_id} (${record.capability}) for ${record.scope.tenant_slug}`,
      summary: `Approve extending ${record.grant_id} by ${extendDays} day(s) from approval.`,
      details,
      severity: 'high',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: 'grant-standing',
    },
    justification: {
      reason: `Extend standing grant ${record.grant_id} of ${record.capability}`,
      requestedEffects: [effectBinding],
      impactSummary: details,
    },
    risk: { level: 'high', restartScope: 'manual', requiresStrongAuth: true, policyId: 'PG-03' },
    workflow: {
      workflowId: `pg-03-grant-extend-${record.grant_id}`,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      stages: [],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: { finalDecision: 'human_only', payloadHash, effectBinding },
  });
}

/**
 * Apply an approved extension step to the same grant. The approval is consumed
 * once; the new expiry is consumption time + extend_days. Audited before the
 * record is written; verified again at every use (verifyGrantBasis).
 */
export function extendStandingGrant(
  draft: GrantExtensionDraft,
  options: { approvalRequestId: string; now?: Date }
): GrantRecord {
  return withLockSync(GRANT_MUTATION_LOCK, () => applyStandingGrantExtension(draft, options), 0);
}

function applyStandingGrantExtension(
  draft: GrantExtensionDraft,
  options: { approvalRequestId: string; now?: Date }
): GrantRecord {
  const record = requireExtendableGrant(draft);
  const previous = record.expires_at;
  const approvalRequestId = String(options.approvalRequestId ?? '').trim();
  if (!approvalRequestId)
    throw new GrantError('approval_required', 'an extension needs an approval request id');
  if (record.extensions?.some((step) => step.approval_request_id === approvalRequestId)) {
    throw new GrantError(
      'approval_invalid',
      `extension approval ${approvalRequestId} was already used`
    );
  }
  const receipt = loadApprovalRequest(GRANT_APPROVAL_CHANNEL, approvalRequestId)?.consumption;
  const now = receipt ? new Date(receipt.consumedAt) : (options.now ?? new Date());
  const { extendDays } = assertGrantExtendable(record, now, draft.extend_days);
  const checked = assertHumanGrantDecision(approvalRequestId, {
    consumer: GRANT_EXTENSION_CONSUMER,
    allowConsumed: true,
    effectBinding: grantExtensionEffectBinding(record.grant_id, previous),
    payloadHash: computeApprovalPayloadHash(grantExtensionPayload(record, previous, extendDays)),
    payloadMismatch: 'extension approval is bound to a different grant, expiry or length',
  });
  const { consumedAt: extendedAt, pendingPath } = consumeGrantEffect(
    checked,
    draft.tenant_slug.trim(),
    GRANT_EXTENSION_CONSUMER,
    grantExtensionEffectRef(record.grant_id, previous)
  );
  assertGrantExtendable(record, new Date(extendedAt), extendDays);
  if (Date.parse(extendedAt) + extendDays * DAY_MS <= Date.now()) {
    throw new GrantError('approval_invalid', 'the approved extension validity window has elapsed');
  }
  const step: Omit<GrantExtension, 'audit_event_id'> = {
    approval_request_id: checked.approval.id,
    approval_channel: GRANT_APPROVAL_CHANNEL,
    previous_expires_at: previous,
    expires_at: new Date(Date.parse(extendedAt) + extendDays * DAY_MS).toISOString(),
    extended_at: extendedAt,
    extend_days: extendDays,
    extended_by: {
      actor_id: checked.humanDecider,
      role: checked.role,
      assurance: checked.assurance,
    },
  };
  const pending: GrantRecord = {
    ...record,
    expires_at: step.expires_at,
    extensions: [...(record.extensions ?? []), { ...step, audit_event_id: 'pending' }],
  };
  const precheck = validateGrantRecord(pending);
  if (!precheck.valid) throw new GrantError('invalid_input', precheck.errors.join('; '));
  const auditEventId = recordGrantAudit(
    'grant.extended',
    pending,
    { kind: 'human', id: checked.humanDecider },
    {
      previous_expires_at: previous,
      extend_days: extendDays,
      extension_approval_request_id: checked.approval.id,
    }
  );
  const extended: GrantRecord = {
    ...pending,
    extensions: [...(record.extensions ?? []), { ...step, audit_event_id: auditEventId }],
  };
  writeGrant(extended);
  inGrantScope(draft.tenant_slug.trim(), () => safeUnlinkSync(pendingPath));
  return extended;
}

/** Use-time re-verification of every extension step (approval, binding, chain). */
function verifyGrantExtensions(record: GrantRecord): boolean {
  let previous = grantBaseExpiry(record);
  for (const step of record.extensions ?? []) {
    if (step.previous_expires_at !== previous || step.approval_channel !== GRANT_APPROVAL_CHANNEL)
      return false;
    if (
      Date.parse(step.extended_at) - Date.parse(step.previous_expires_at) >
      GRANT_EXTENSION_GRACE_DAYS * DAY_MS
    )
      return false;
    if (Date.parse(step.expires_at) - Date.parse(step.extended_at) !== step.extend_days * DAY_MS)
      return false;
    const approval = loadApprovalRequest(GRANT_APPROVAL_CHANNEL, step.approval_request_id);
    if (!approval || approval.status !== 'approved' || approval.revocation) return false;
    const consumption = approval.consumption;
    if (
      consumption?.consumer !== GRANT_EXTENSION_CONSUMER ||
      consumption.effectRef !== grantExtensionEffectRef(record.grant_id, previous) ||
      consumption.consumedAt !== step.extended_at
    )
      return false;
    if (
      approval.accountability?.effectBinding !==
        grantExtensionEffectBinding(record.grant_id, previous) ||
      approval.accountability?.payloadHash !==
        computeApprovalPayloadHash(grantExtensionPayload(record, previous, step.extend_days))
    )
      return false;
    previous = step.expires_at;
  }
  return previous === record.expires_at;
}

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

/** Find a grant by id across the tenant partitions the caller may read. */
export function findGrantById(grantId: string, tenantSlug?: string): GrantRecord | null {
  if (!GRANT_ID_PATTERN.test(grantId)) {
    throw new GrantError('invalid_input', `invalid grant id: ${grantId}`);
  }
  const tenants = tenantSlug ? [tenantSlug] : tenantPartitions();
  for (const tenant of tenants) {
    let record: GrantRecord | null = null;
    try {
      record = loadGrant(tenant, grantId);
    } catch {
      record = null;
    }
    if (record) return record;
  }
  return null;
}

/** Revoke a grant: the record stays (with `revoked`), and grants nothing from now on. */
export function revokeGrant(
  grantId: string,
  options: { by: GrantActor; reason: string; tenant_slug?: string; now?: Date }
): GrantRecord {
  return withLockSync(GRANT_MUTATION_LOCK, () => revokeStandingGrant(grantId, options), 0);
}

function revokeStandingGrant(
  grantId: string,
  options: { by: GrantActor; reason: string; tenant_slug?: string; now?: Date }
): GrantRecord {
  const byId = String(options.by?.id ?? '').trim();
  if (!byId || (options.by.kind !== 'human' && options.by.kind !== 'agent')) {
    throw new GrantError('invalid_input', 'revoke requires a human or agent actor');
  }
  const by: GrantActor = { kind: options.by.kind, id: byId };
  const reason = String(options.reason ?? '').trim();
  if (!reason || reason.length > 500) {
    throw new GrantError('invalid_input', 'revoke reason must be 1..500 characters');
  }
  const existing = findGrantById(grantId, options.tenant_slug);
  if (!existing) throw new GrantError('not_found', `grant ${grantId} not found`);
  if (existing.revoked) {
    throw new GrantError('invalid_state', `grant ${grantId} is already revoked`);
  }
  const at = nowIso(options.now ?? new Date());
  // Withdraw the approval first: it lives outside the tenant partition, so
  // editing `revoked` out of the record does not bring the grant back
  // (verifyGrantBasis refuses a revoked approval). The audit then states
  // whether the withdrawal happened; the record is revoked either way.
  let approvalWithdrawn = false;
  let withdrawalError: string | undefined;
  if (existing.basis) {
    try {
      const approval = loadApprovalRequest(
        existing.basis.approval_channel,
        existing.basis.approval_request_id
      );
      if (approval?.revocation) {
        approvalWithdrawn = true;
      } else if (approval) {
        revokeStandingEffectApproval('mission_controller', {
          channel: existing.basis.approval_channel,
          requestId: existing.basis.approval_request_id,
          revokedBy: by.id,
          reason: `standing grant ${grantId} revoked: ${reason}`,
          consumer: GRANT_APPROVAL_CONSUMER,
          effectRef: grantId,
        });
        approvalWithdrawn = true;
      }
    } catch (err: unknown) {
      withdrawalError = err instanceof Error ? err.message : String(err);
    }
  }
  const auditEventId = recordGrantAudit('grant.revoked', existing, by, {
    revoked_at: at,
    ...(existing.basis ? { approval_withdrawn: approvalWithdrawn } : {}),
    ...(withdrawalError ? { approval_withdrawal_error: withdrawalError } : {}),
  });
  const revoked: GrantRecord = {
    ...existing,
    revoked: { at, by: by.id, by_kind: by.kind, reason, audit_event_id: auditEventId },
  };
  writeGrant(revoked);
  return revoked;
}
