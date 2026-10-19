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
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import { auditChain } from './audit-chain.js';
import { parseActorRef } from '../actor.js';
import { compileSchema } from '../foundation/ajv.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeReaddir } from '../secure-io.js';
import {
  PARTITIONED_RUNTIME_STATE_ROOTS,
  storagePartitionSegments,
  type StorageDataTier,
} from '../storage-layout.js';
import {
  getGrantCapabilityPolicy,
  type StandingGrantCapabilityPolicy,
} from './grant-capability-policy.js';
import {
  assertApprovalUsable,
  assuranceOfAuthMethod,
  computeApprovalPayloadHash,
  createApprovalRequest,
  evaluateApprovalUsability,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  validateHumanFinalDecision,
  type ApprovalAssuranceLevel,
  type ApprovalRequestRecord,
} from './approval-store.js';
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GrantScope {
  tenant_slug?: string;
  /** Calendar series ids of the meetings this grant covers. */
  meeting_series_ids?: string[];
  /** Normalized meeting URLs (see {@link normalizeMeetingUrl}). */
  meeting_urls?: string[];
}

export interface GrantedBy {
  actor_id: string;
  role: 'operator' | 'member_self' | 'sovereign';
  assurance: ApprovalAssuranceLevel;
}

export interface GrantRecord {
  schema_version: 'grant-record.v1';
  grant_id: string;
  capability: string;
  scope: GrantScope;
  purpose: string;
  granted_by: GrantedBy;
  /** Present for external_io capabilities: the human approval the grant was made under. */
  basis?: { approval_request_id: string; approval_channel: string };
  granted_at: string;
  expires_at: string;
  revoked?: {
    at: string;
    by: string;
    by_kind?: 'human' | 'agent';
    reason?: string;
    audit_event_id: string;
  };
  /** The audit-chain event recorded before the grant was written. */
  audit_event_id: string;
}

/** What an operator asks to grant (before normalization). */
export interface GrantDraft {
  capability: string;
  tenant_slug: string;
  meeting_series_ids?: string[];
  meeting_urls?: string[];
  purpose: string;
  /** Lifetime in days; defaults to the capability's max_ttl_days and never exceeds it. */
  ttl_days?: number;
}

/** A draft after validation: deduplicated, normalized, codepoint-sorted. */
export interface NormalizedGrantDraft {
  capability: string;
  tenant_slug: string;
  meeting_series_ids: string[];
  meeting_urls: string[];
  purpose: string;
  ttl_days: number;
}

export type GrantErrorCode =
  | 'invalid_input'
  | 'unknown_capability'
  | 'not_standing'
  | 'approval_required'
  | 'approval_invalid'
  | 'no_operator_identity'
  | 'not_found'
  | 'invalid_state';

export class GrantError extends Error {
  readonly code: GrantErrorCode;

  constructor(code: GrantErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'GrantError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GRANT_APPROVAL_CHANNEL = 'grant-standing';
/** Separation-of-duties consumer id (approval-sod-consumers.contract.test.ts). */
export const GRANT_APPROVAL_CONSUMER = 'grant_standing';
const GRANT_ID_PATTERN = /^GRT-\d{8}-[a-f0-9]{12}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Tenant grants are operator governance data of that tenant: confidential tier. */
const GRANT_TIER: StorageDataTier = 'confidential';
const APPROVAL_TTL_MS = 72 * 60 * 60 * 1000;

function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Meeting URL normalization (§5-1)
// ---------------------------------------------------------------------------

/**
 * Canonical form of a meeting URL: lowercase scheme and host, no query, no
 * fragment, no trailing slash. Path case is kept (meeting codes can be case
 * sensitive). Returns null for anything that is not an http(s) URL.
 */
export function normalizeMeetingUrl(value: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!url.host || url.username || url.password) return null;
  const pathname = url.pathname.replace(/\/+$/u, '');
  return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}${pathname}`;
}

// ---------------------------------------------------------------------------
// Policy helpers
// ---------------------------------------------------------------------------

/** The standing-grant policy of a capability; throws for unknown / non-standing ones. */
export function requireStandingGrantPolicy(capability: string): StandingGrantCapabilityPolicy {
  const policy = getGrantCapabilityPolicy(capability);
  if (!policy) {
    throw new GrantError('unknown_capability', `capability ${capability} is not declared`);
  }
  if (policy.kind !== 'standing_grant') {
    throw new GrantError(
      'not_standing',
      `capability ${capability} is ${policy.kind}; it cannot be granted as a standing grant`
    );
  }
  return policy;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(codepointCompare);
}

/** Validate and canonicalize a draft against its capability policy. */
export function normalizeGrantDraft(draft: GrantDraft): NormalizedGrantDraft {
  const capability = String(draft?.capability ?? '').trim();
  const policy = requireStandingGrantPolicy(capability);
  const tenant = String(draft.tenant_slug ?? '').trim();
  if (!isValidTenantSlug(tenant)) {
    throw new GrantError('invalid_input', `invalid tenant slug: ${draft.tenant_slug}`);
  }
  const seriesIds = uniqueSorted(
    (draft.meeting_series_ids ?? []).map((id) => String(id).trim()).filter(Boolean)
  );
  if (seriesIds.some((id) => id.length > 512)) {
    throw new GrantError('invalid_input', 'meeting series ids must be at most 512 characters');
  }
  const urls: string[] = [];
  for (const candidate of draft.meeting_urls ?? []) {
    const normalized = normalizeMeetingUrl(candidate);
    if (!normalized) {
      throw new GrantError('invalid_input', `meeting URL is not an http(s) URL: ${candidate}`);
    }
    urls.push(normalized);
  }
  const meetingUrls = uniqueSorted(urls);
  if (policy.scope_keys.includes('meeting') && seriesIds.length === 0 && meetingUrls.length === 0) {
    throw new GrantError(
      'invalid_input',
      `${capability} needs at least one meeting series id or meeting URL`
    );
  }
  const purpose = typeof draft.purpose === 'string' ? draft.purpose.trim() : '';
  if (!purpose || purpose.length > 500) {
    throw new GrantError('invalid_input', 'purpose must be 1..500 characters');
  }
  const ttlDays = draft.ttl_days ?? policy.max_ttl_days;
  if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > policy.max_ttl_days) {
    throw new GrantError(
      'invalid_input',
      `lifetime must be an integer between 1 and ${policy.max_ttl_days} days for ${capability}`
    );
  }
  return {
    capability,
    tenant_slug: tenant,
    meeting_series_ids: seriesIds,
    meeting_urls: meetingUrls,
    purpose,
    ttl_days: ttlDays,
  };
}

// ---------------------------------------------------------------------------
// Record validation
// ---------------------------------------------------------------------------

const GRANT_SCHEMA_PATH = pathResolver.knowledge('product/schemas/grant-record.schema.json');
let grantValidator: ValidateFunction<GrantRecord> | undefined;

function getGrantValidator(): ValidateFunction<GrantRecord> {
  grantValidator ||= compileSchema<GrantRecord>(GRANT_SCHEMA_PATH);
  return grantValidator;
}

/** Schema + semantic validation; a stored record failing either grants nothing. */
export function validateGrantRecord(input: unknown): { valid: boolean; errors: string[] } {
  const validate = getGrantValidator();
  if (!validate(input)) {
    return {
      valid: false,
      errors: (validate.errors || []).map((error) =>
        `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
      ),
    };
  }
  const record = input as GrantRecord;
  const errors: string[] = [];
  let policy: StandingGrantCapabilityPolicy | null = null;
  try {
    policy = requireStandingGrantPolicy(record.capability);
  } catch (err: unknown) {
    errors.push(err instanceof Error ? err.message : String(err));
  }
  const tenant = record.scope.tenant_slug;
  if (tenant !== undefined && !isValidTenantSlug(tenant)) {
    errors.push('scope.tenant_slug is not a valid tenant slug');
  }
  for (const url of record.scope.meeting_urls ?? []) {
    if (normalizeMeetingUrl(url) !== url) errors.push(`meeting URL is not normalized: ${url}`);
  }
  if (policy) {
    if (policy.scope_keys.includes('tenant_slug') && !tenant) {
      errors.push('scope.tenant_slug is required');
    }
    if (
      policy.scope_keys.includes('meeting') &&
      !(record.scope.meeting_series_ids?.length || record.scope.meeting_urls?.length)
    ) {
      errors.push('scope needs at least one meeting series id or meeting URL');
    }
    if (policy.external_io && !record.basis?.approval_request_id) {
      errors.push('external_io capability requires basis.approval_request_id');
    }
  }
  const granted = Date.parse(record.granted_at);
  const expires = Date.parse(record.expires_at);
  if (!(expires > granted)) errors.push('expires_at must be after granted_at');
  if (policy && expires - granted > policy.max_ttl_days * DAY_MS) {
    errors.push(`grant lifetime exceeds ${policy.max_ttl_days} days`);
  }
  if (record.revoked && Date.parse(record.revoked.at) < granted) {
    errors.push('revoked.at must not precede granted_at');
  }
  return { valid: errors.length === 0, errors };
}

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

function writeGrant(record: GrantRecord): void {
  const check = validateGrantRecord(record);
  if (!check.valid) {
    throw new GrantError(
      'invalid_input',
      `invalid grant ${record.grant_id}: ${check.errors.join('; ')}`
    );
  }
  const filePath = grantRecordPath(record.scope.tenant_slug, record.grant_id);
  safeMkdir(path.dirname(filePath), { recursive: true });
  writeJson(filePath, record);
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
  writeGrant(record);
  return record;
}

// ---------------------------------------------------------------------------
// Approval-mediated grant (external_io)
// ---------------------------------------------------------------------------

export function grantApprovalEffectBinding(draft: NormalizedGrantDraft): string {
  return `grant-standing:${draft.capability}:${draft.tenant_slug}`;
}

/** Canonical payload hashed into the approval: every field the human approved. */
export function grantApprovalPayload(draft: NormalizedGrantDraft): Record<string, unknown> {
  return {
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
  if (draft.meeting_series_ids.length) {
    lines.push(`Meeting series: ${draft.meeting_series_ids.join(', ')}`);
  }
  if (draft.meeting_urls.length) lines.push(`Meeting URLs: ${draft.meeting_urls.join(', ')}`);
  lines.push(
    `Purpose: ${draft.purpose}`,
    `Expires: ${draft.ttl_days} day(s) after the grant is applied`,
    `Requested by: ${requestedBy}`,
    'Effect if approved: a standing grant is created; matching meetings may be recorded without a per-mission consent until it expires or is revoked (`pnpm kyberion grants revoke <grant_id>`).'
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
  const existing = findGrantApprovalRequest(normalized);
  if (existing) return existing;
  const requester = resolveApprovalRequesterInput(options.requester);
  const now = options.now ?? new Date();
  const effectBinding = grantApprovalEffectBinding(normalized);
  const details = buildGrantApprovalDetails(normalized, requester.requestedBy);
  return createApprovalRequest('mission_controller', {
    channel: GRANT_APPROVAL_CHANNEL,
    storageChannel: GRANT_APPROVAL_CHANNEL,
    threadTs: `${normalized.capability}:${normalized.tenant_slug}`,
    correlationId: effectBinding,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
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
      requiredRoles: ['sovereign'],
      stages: [],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash: computeApprovalPayloadHash(grantApprovalPayload(normalized)),
      effectBinding,
    },
  });
}

/**
 * Apply-side validation (mirrors assertScopeChangeApproval): approved by an
 * authenticated human, unexpired, usable (not revoked / consumed, separation
 * of duties) and bound by payloadHash to exactly this draft.
 */
export function assertGrantApproval(
  draft: NormalizedGrantDraft,
  approvalRequestId: string
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
  if (isApprovalRequestExpired(approval)) {
    throw new GrantError('approval_invalid', `grant approval has expired: ${approval.id}`);
  }
  if (approval.consumption || approval.applyClaim || approval.applyResult) {
    throw new GrantError('approval_invalid', `grant approval ${approval.id} was already used`);
  }
  assertApprovalUsable(approval, { consumer: 'grant_standing' });
  if (approval.accountability?.effectBinding !== grantApprovalEffectBinding(draft)) {
    throw new GrantError('approval_invalid', 'grant approval is bound to a different effect');
  }
  if (
    approval.accountability?.payloadHash !== computeApprovalPayloadHash(grantApprovalPayload(draft))
  ) {
    throw new GrantError(
      'approval_invalid',
      'grant approval is bound to a different capability/tenant/meetings/purpose/lifetime'
    );
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
  return {
    approval,
    humanDecider,
    assurance: assuranceOfAuthMethod(humanApproval.authMethod) ?? 'A0',
    role: humanApproval.role === 'sovereign' ? 'sovereign' : 'operator',
  };
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
    const consumption = approval.consumption;
    if (consumption?.consumer !== GRANT_APPROVAL_CONSUMER) return false;
    // Bound to the record this approval created: same grant id, and the grant
    // started exactly when the approval was consumed (no copy, no time shift).
    if (consumption.effectRef !== record.grant_id) return false;
    if (consumption.consumedAt !== record.granted_at) return false;
    const lifetimeMs = Date.parse(record.expires_at) - Date.parse(record.granted_at);
    const ttlDays = lifetimeMs / DAY_MS;
    // Exactly the approved number of whole days — no rounding slack.
    if (!Number.isInteger(ttlDays) || ttlDays < 1) return false;
    const draft: NormalizedGrantDraft = {
      capability: record.capability,
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
  const checked = assertGrantApproval(normalized, approvalRequestId);
  // The consumption names the grant it creates and its time becomes the
  // grant's granted_at, so the stored record is bound to this approval:
  // a copy under another id or a shifted validity window no longer matches
  // (verifyGrantBasis).
  const grantId = generateGrantId(options.now ?? new Date());
  const consumed = markApprovalConsumed('mission_controller', {
    channel: GRANT_APPROVAL_CHANNEL,
    requestId: checked.approval.id,
    consumer: GRANT_APPROVAL_CONSUMER,
    consumedBy: checked.humanDecider,
    effectRef: grantId,
  });
  const consumedAt = consumed.consumption?.consumedAt;
  if (!consumedAt) {
    throw new GrantError(
      'approval_invalid',
      `grant approval ${checked.approval.id} was not consumed`
    );
  }
  return writeNewGrant(
    normalized,
    { actor_id: checked.humanDecider, role: checked.role, assurance: checked.assurance },
    { approval_request_id: checked.approval.id, approval_channel: GRANT_APPROVAL_CHANNEL },
    options.now ?? new Date(),
    { grantId, grantedAt: consumedAt }
  );
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
