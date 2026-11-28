/**
 * The standing-grant record model: record/draft types, the error vocabulary,
 * schema + semantic validation and draft normalization. Everything a grant
 * record means independent of where it is stored — grant-store.ts owns the
 * storage/lifecycle and re-exports this module's surface so importers keep a
 * single entry point.
 */
import {
  normalizeServiceCredentialAllocation,
  type ServiceCredentialAllocationScope,
} from './service-credential-grant-scope.js';
import {
  PERSONAL_CREDENTIAL_CAPABILITY,
  normalizePersonalCredentialGrantScope,
  type PersonalCredentialGrantRecord,
} from './personal-credential-grant-scope.js';
import type { ValidateFunction } from 'ajv';
import { compileSchema } from '../foundation/ajv.js';
import { isValidTenantSlug } from '../foundation/scope.js';
import { pathResolver } from '../path-resolver.js';
import {
  getGrantCapabilityPolicy,
  type StandingGrantCapabilityPolicy,
} from './grant-capability-policy.js';
import type { ApprovalAssuranceLevel } from './approval-store.js';
import {
  credentialLendingErrors,
  requireCredentialService,
  type CredentialLendingScope,
} from '../secret/credential-custody.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GrantScope {
  tenant_slug?: string;
  credential_provider?: string;
  credential_ref?: string;
  /** Custody/kind lending terms (secret/credential-custody.ts); absent = legacy person API key. */
  credential_lending?: CredentialLendingScope;
  service_allocation?: ServiceCredentialAllocationScope;
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
  /**
   * Owner-approved expiry extensions, oldest first. Only `expires_at` moves:
   * id, principal, scope and purpose stay. Each step is bound to its own
   * approval and re-verified at every use (verifyGrantBasis).
   */
  extensions?: GrantExtension[];
}

/** One approved expiry extension step of a standing grant. */
export interface GrantExtension {
  approval_request_id: string;
  approval_channel: string;
  /** The grant's expires_at the approval was requested against. */
  previous_expires_at: string;
  /** extended_at + extend_days (never more than the capability's max_ttl_days). */
  expires_at: string;
  /** When the approval was consumed; the new lifetime counts from here. */
  extended_at: string;
  extend_days: number;
  extended_by: GrantedBy;
  audit_event_id: string;
}

/** What an operator asks to grant (before normalization). */
export interface GrantDraft {
  capability: string;
  tenant_slug: string;
  credential_provider?: string;
  credential_ref?: string;
  credential_lending?: CredentialLendingScope;
  service_allocation?: ServiceCredentialAllocationScope;
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
  credential_provider?: string;
  credential_ref?: string;
  credential_lending?: CredentialLendingScope;
  service_allocation?: ServiceCredentialAllocationScope;
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

export const GRANT_APPROVAL_CHANNEL = 'grant-standing';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function codepointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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

/** Expiry the original approval set: before any extension step. */
export function grantBaseExpiry(record: Pick<GrantRecord, 'expires_at' | 'extensions'>): string {
  return record.extensions?.[0]?.previous_expires_at ?? record.expires_at;
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort(codepointCompare);
}

/** Validate and canonicalize a draft against its capability policy. */
export function normalizeGrantDraft(draft: GrantDraft): NormalizedGrantDraft {
  if (
    draft.capability === PERSONAL_CREDENTIAL_CAPABILITY ||
    'custody' in draft ||
    'personal_credential_use' in draft ||
    'scope' in draft
  )
    throw new GrantError(
      'invalid_input',
      'personal grants require the authenticated personal facade'
    );
  const provider = draft.credential_provider?.trim();
  if (provider !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(provider))
    throw new GrantError('invalid_input', 'invalid credential provider');
  const reference = draft.credential_ref?.trim();
  if (
    reference !== undefined &&
    !/^[a-z0-9][a-z0-9._-]{0,63}\/[A-Z][A-Z0-9_]{0,63}$/.test(reference)
  )
    throw new GrantError('invalid_input', 'invalid credential reference');
  const capability = String(draft?.capability ?? '').trim();
  const policy = requireStandingGrantPolicy(capability);
  let serviceAllocation: ServiceCredentialAllocationScope | undefined;
  if (draft.service_allocation !== undefined) {
    if (capability !== 'credential.use' || provider !== undefined || reference !== undefined)
      throw new GrantError(
        'invalid_input',
        'service_allocation is exclusive to service credential.use grants'
      );
    try {
      serviceAllocation = normalizeServiceCredentialAllocation(draft.service_allocation);
    } catch (error) {
      throw new GrantError('invalid_input', String(error));
    }
  }
  let lending: CredentialLendingScope | undefined;
  if (draft.credential_lending !== undefined) {
    const errors =
      capability !== 'credential.use' || serviceAllocation
        ? ['credential_lending is exclusive to reasoning credential.use grants']
        : credentialLendingErrors(draft.credential_lending);
    if (errors.length) throw new GrantError('invalid_input', errors.join('; '));
    lending = draft.credential_lending;
    const spec = requireCredentialService(lending.service);
    if (provider !== spec.primaryBackend || reference !== `${spec.service}/${spec.secretKey}`)
      throw new GrantError(
        'invalid_input',
        'credential_lending must agree with credential_provider / credential_ref'
      );
  }
  if (!serviceAllocation && policy.scope_keys.includes('credential_provider') && !provider)
    throw new GrantError('invalid_input', 'credential_provider is required');
  if (!serviceAllocation && policy.scope_keys.includes('credential_ref') && !reference)
    throw new GrantError('invalid_input', 'credential_ref is required');
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
    ...(serviceAllocation ? { service_allocation: serviceAllocation } : {}),
    ...(provider ? { credential_provider: provider } : {}),
    ...(reference ? { credential_ref: reference } : {}),
    ...(lending ? { credential_lending: lending } : {}),
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
type StoredGrantRecord = GrantRecord | PersonalCredentialGrantRecord;
let grantValidator: ValidateFunction<StoredGrantRecord> | undefined;

function getGrantValidator(): ValidateFunction<StoredGrantRecord> {
  grantValidator ||= compileSchema<StoredGrantRecord>(GRANT_SCHEMA_PATH);
  return grantValidator;
}

/** Schema + semantic validation; a stored record failing either grants nothing. */
export function validateGrantRecord(input: unknown): { valid: boolean; errors: string[] } {
  if (
    input &&
    typeof input === 'object' &&
    ('custody' in input ||
      ('capability' in input && input.capability === PERSONAL_CREDENTIAL_CAPABILITY))
  )
    return { valid: false, errors: ['personal grants are not tenant grant records'] };
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
    const allocation = record.scope.service_allocation;
    if (allocation) {
      try {
        if (
          record.capability !== 'credential.use' ||
          record.scope.credential_provider !== undefined ||
          record.scope.credential_ref !== undefined
        )
          throw new Error('service allocation must be exclusive');
        const normalized = normalizeServiceCredentialAllocation(allocation);
        if (
          Object.entries(normalized).some(
            ([key, value]) =>
              JSON.stringify(value) !==
              JSON.stringify(allocation[key as keyof ServiceCredentialAllocationScope])
          )
        )
          throw new Error('service allocation must be normalized');
      } catch (error) {
        errors.push(String(error));
      }
    }
    if (record.scope.credential_lending !== undefined) {
      if (record.capability !== 'credential.use' || allocation)
        errors.push('credential_lending is exclusive to reasoning credential.use grants');
      else errors.push(...credentialLendingErrors(record.scope.credential_lending));
    }
    if (
      !allocation &&
      policy.scope_keys.includes('credential_provider') &&
      !record.scope.credential_provider
    )
      errors.push('scope.credential_provider is required');
    if (!allocation && policy.scope_keys.includes('credential_ref') && !record.scope.credential_ref)
      errors.push('scope.credential_ref is required');
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
  const expires = Date.parse(grantBaseExpiry(record));
  if (!(expires > granted)) errors.push('expires_at must be after granted_at');
  if (policy && expires - granted > policy.max_ttl_days * DAY_MS) {
    errors.push(`grant lifetime exceeds ${policy.max_ttl_days} days`);
  }
  if (record.extensions) {
    if (!policy?.external_io) errors.push('only external_io grants can be extended');
    let previous = grantBaseExpiry(record);
    for (const step of record.extensions) {
      const from = Date.parse(step.extended_at);
      const to = Date.parse(step.expires_at);
      if (step.previous_expires_at !== previous) errors.push('extension chain is broken');
      if (!(to > Date.parse(step.previous_expires_at)))
        errors.push('an extension must move expires_at later');
      if (
        policy &&
        (step.extend_days > policy.max_ttl_days || to - from !== step.extend_days * DAY_MS)
      )
        errors.push(`an extension step must be 1..${policy.max_ttl_days} whole days from approval`);
      if (from < granted) errors.push('an extension cannot precede granted_at');
      previous = step.expires_at;
    }
    if (previous !== record.expires_at) errors.push('expires_at must equal the last extension');
  }
  if (record.revoked && Date.parse(record.revoked.at) < granted) {
    errors.push('revoked.at must not precede granted_at');
  }
  return { valid: errors.length === 0, errors };
}

/** Personal variant of the same standing-grant schema; never accepted by tenant APIs. */
export function validatePersonalCredentialGrantRecord(input: unknown): {
  valid: boolean;
  errors: string[];
} {
  const validate = getGrantValidator();
  if (!validate(input)) return { valid: false, errors: ['invalid personal standing-grant schema'] };
  const record = input as PersonalCredentialGrantRecord;
  const errors: string[] = [];
  try {
    const normalized = normalizePersonalCredentialGrantScope(record.scope);
    if (
      record.capability !== PERSONAL_CREDENTIAL_CAPABILITY ||
      record.custody?.kind !== 'person' ||
      record.custody.ref !== normalized.owner_ref.slice(5) ||
      record.granted_by.actor_id !== normalized.owner_ref ||
      Object.entries(normalized).some(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(record.scope[key as keyof typeof normalized])
      )
    )
      errors.push('personal custody and normalized owner scope must agree');
    const policy = requireStandingGrantPolicy(PERSONAL_CREDENTIAL_CAPABILITY);
    const ttl = (Date.parse(record.expires_at) - Date.parse(record.granted_at)) / DAY_MS;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > policy.max_ttl_days)
      errors.push('invalid personal grant lifetime');
    if (
      !record.basis?.approval_request_id ||
      record.basis.approval_channel !== GRANT_APPROVAL_CHANNEL
    )
      errors.push('personal grant requires canonical approval basis');
    if (record.revoked && Date.parse(record.revoked.at) < Date.parse(record.granted_at))
      errors.push('revocation precedes grant');
    if ('extensions' in record) errors.push('personal grants are never extended');
  } catch {
    errors.push('invalid personal grant scope');
  }
  return { valid: errors.length === 0, errors };
}
