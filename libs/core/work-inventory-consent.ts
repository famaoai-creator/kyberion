/**
 * WI-05: consent records for consented PC-operation observation.
 *
 * Plan §2.3 ③ (docs/developer/improvement-plans-2026-08/WORK_INVENTORY_PLAN_2026-09-22.ja.md):
 *   - consent is kept as a record (grant / revoke / expiry);
 *   - only the member themself can grant or revoke it;
 *   - the record lives in the member's personal tier:
 *       knowledge/personal/members/<member_id>/work-inventory/consents/<consent_id>.json
 *   - every grant / revoke is written to the audit chain.
 *
 * Fail-closed rules:
 *   - `clipboard` and `screen_frame` are never consentable observation kinds
 *     (rejected at grant, absent from the schema enum, re-checked on load);
 *   - the consent window is at most 90 days; a stored record that violates any
 *     semantic rule (window too long, grantor ≠ member, file under another
 *     member's directory) is treated as absent, i.e. it grants nothing;
 *   - the audit event is recorded before the record is written, so a consent
 *     never exists without an audit trail.
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import type { ValidateFunction } from 'ajv';
import { auditChain } from './audit-chain.js';
import { humanActor } from './actor.js';
import { compileSchema } from './foundation/ajv.js';
import { nowIso } from './foundation/time.js';
import { parseSafeJsonInput } from './foundation/safe-json.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { isValidTenantSlug } from './entity-scope.js';
import { isValidMemberId } from './member-id-grammar.js';
import type { DesktopObservationSource } from './desktop-recording.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkInventoryConsentSource = 'desktop_recording' | 'browser_recording';

export type WorkInventoryObservationKind = DesktopObservationSource['id'];

export interface WorkInventoryHumanActor {
  kind: 'human';
  id: string;
}

export interface WorkInventoryConsent {
  schema_version: 'work-inventory-consent.v1';
  consent_id: string;
  member_id: string;
  tenant_slug?: string;
  sources: WorkInventoryConsentSource[];
  observation_kinds: WorkInventoryObservationKind[];
  purpose: string;
  granted_at: string;
  expires_at: string;
  granted_by: WorkInventoryHumanActor;
  revoked_at?: string;
  revoked_by?: WorkInventoryHumanActor;
}

export type WorkInventoryConsentErrorCode =
  | 'no_consent'
  | 'consent_expired'
  | 'consent_revoked'
  | 'source_not_covered'
  | 'recording_not_reviewed'
  | 'tenant_mismatch'
  /** The recording failed its own contract validation (hash, schema, review shape). */
  | 'invalid_recording'
  /** A grant / summary input violated the consent contract (window, kinds, purpose...). */
  | 'invalid_input'
  /** Observation kinds that may never be consented to (clipboard, screen_frame). */
  | 'forbidden_observation_kind'
  /** The acting human is not the member the record belongs to. */
  | 'not_subject'
  | 'not_found'
  /** The record is not in a state that allows the transition (already revoked, not confirmed...). */
  | 'invalid_state';

export class WorkInventoryConsentError extends Error {
  readonly code: WorkInventoryConsentErrorCode;

  constructor(code: WorkInventoryConsentErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'WorkInventoryConsentError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const WORK_INVENTORY_CONSENT_SOURCES: readonly WorkInventoryConsentSource[] = [
  'desktop_recording',
  'browser_recording',
];

/** Raw content channels: never summarizable, never consentable. */
export const FORBIDDEN_OBSERVATION_KINDS: readonly WorkInventoryObservationKind[] = [
  'clipboard',
  'screen_frame',
];

export const CONSENTABLE_OBSERVATION_KINDS: readonly WorkInventoryObservationKind[] = [
  'active_window',
  'browser_tabs',
  'focused_input',
];

export const MAX_CONSENT_WINDOW_DAYS = 90;
const MAX_CONSENT_WINDOW_MS = MAX_CONSENT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const CONSENT_ID_PATTERN = /^WIC-\d{8}-[a-f0-9]{12}$/;

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

const CONSENT_SCHEMA_PATH = pathResolver.rootResolve(
  'knowledge/product/schemas/work-inventory-consent.schema.json'
);
let consentValidator: ValidateFunction<WorkInventoryConsent> | undefined;

function getConsentValidator(): ValidateFunction<WorkInventoryConsent> {
  consentValidator ||= compileSchema<WorkInventoryConsent>(CONSENT_SCHEMA_PATH);
  return consentValidator;
}

/** Schema + semantic validation; semantic failures make a stored consent grant nothing. */
export function validateWorkInventoryConsent(input: unknown): { valid: boolean; errors: string[] } {
  const validate = getConsentValidator();
  if (!validate(input)) {
    return {
      valid: false,
      errors: (validate.errors || []).map((error) =>
        `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
      ),
    };
  }
  const consent = input as WorkInventoryConsent;
  const errors: string[] = [];
  if (!isValidMemberId(consent.member_id)) errors.push('member_id is not a valid member id');
  if (consent.tenant_slug !== undefined && !isValidTenantSlug(consent.tenant_slug)) {
    errors.push('tenant_slug is not a valid tenant slug');
  }
  if (consent.granted_by.id !== consent.member_id) {
    errors.push('granted_by must be the member themself');
  }
  if (consent.revoked_by && consent.revoked_by.id !== consent.member_id) {
    errors.push('revoked_by must be the member themself');
  }
  for (const kind of consent.observation_kinds) {
    if (FORBIDDEN_OBSERVATION_KINDS.includes(kind)) {
      errors.push(`observation kind ${kind} can never be consented to`);
    }
  }
  const granted = Date.parse(consent.granted_at);
  const expires = Date.parse(consent.expires_at);
  if (!(expires > granted)) errors.push('expires_at must be after granted_at');
  if (expires - granted > MAX_CONSENT_WINDOW_MS) {
    errors.push(`consent window exceeds ${MAX_CONSENT_WINDOW_DAYS} days`);
  }
  if (consent.revoked_at !== undefined && Date.parse(consent.revoked_at) < granted) {
    errors.push('revoked_at must not precede granted_at');
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Storage paths (personal tier, per member)
// ---------------------------------------------------------------------------

function assertMemberId(memberId: string): void {
  if (typeof memberId !== 'string' || !isValidMemberId(memberId)) {
    throw new WorkInventoryConsentError('invalid_input', `invalid member id: ${String(memberId)}`);
  }
}

/** `knowledge/personal/members/<member_id>/work-inventory` — the member's personal-tier root. */
export function memberWorkInventoryRoot(
  memberId: string,
  rootDir: string = pathResolver.rootDir()
): string {
  assertMemberId(memberId);
  return path.join(rootDir, 'knowledge/personal/members', memberId, 'work-inventory');
}

function consentsDir(memberId: string, rootDir: string): string {
  return path.join(memberWorkInventoryRoot(memberId, rootDir), 'consents');
}

export function workInventoryConsentPath(
  memberId: string,
  consentId: string,
  rootDir: string = pathResolver.rootDir()
): string {
  if (!CONSENT_ID_PATTERN.test(consentId)) {
    throw new WorkInventoryConsentError('invalid_input', `invalid consent id: ${consentId}`);
  }
  return assertSafeRepositoryPath(path.join(consentsDir(memberId, rootDir), `${consentId}.json`), {
    allowMissingLeaf: true,
    rootDir,
  });
}

function writeConsent(consent: WorkInventoryConsent, rootDir: string): void {
  const check = validateWorkInventoryConsent(consent);
  if (!check.valid) {
    throw new WorkInventoryConsentError(
      'invalid_input',
      `invalid consent ${consent.consent_id}: ${check.errors.join('; ')}`
    );
  }
  const filePath = workInventoryConsentPath(consent.member_id, consent.consent_id, rootDir);
  safeMkdir(path.dirname(filePath), { recursive: true });
  safeWriteFile(filePath, `${JSON.stringify(consent, null, 2)}\n`, { encoding: 'utf8' });
}

function readConsent(
  memberId: string,
  consentId: string,
  rootDir: string
): WorkInventoryConsent | null {
  const filePath = workInventoryConsentPath(memberId, consentId, rootDir);
  if (!safeExistsSync(filePath)) return null;
  let raw: unknown;
  try {
    raw = parseSafeJsonInput(
      String(safeReadFile(filePath, { encoding: 'utf8' })),
      `work inventory consent ${consentId}`
    );
  } catch {
    return null;
  }
  // Fail closed: an invalid or misplaced record grants nothing.
  if (!validateWorkInventoryConsent(raw).valid) return null;
  const consent = raw as WorkInventoryConsent;
  if (consent.member_id !== memberId || consent.consent_id !== consentId) return null;
  return consent;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

function recordConsentAudit(
  action: string,
  consent: WorkInventoryConsent,
  extra: Record<string, unknown> = {}
): void {
  // Deliberately excludes `purpose` (free text) — audit entries may be
  // forwarded to tenant SIEMs, so only identifiers and scope go in.
  auditChain.record({
    agentId: `user:${consent.member_id}`,
    actor: humanActor(consent.member_id),
    action,
    operation: consent.consent_id,
    result: 'completed',
    ...(consent.tenant_slug ? { tenantSlug: consent.tenant_slug } : {}),
    metadata: {
      member_id: consent.member_id,
      consent_id: consent.consent_id,
      sources: consent.sources,
      observation_kinds: consent.observation_kinds,
      granted_at: consent.granted_at,
      expires_at: consent.expires_at,
      ...(consent.tenant_slug ? { tenant_slug: consent.tenant_slug } : {}),
      ...extra,
    },
  });
}

// ---------------------------------------------------------------------------
// Grant / revoke / list
// ---------------------------------------------------------------------------

export interface GrantWorkInventoryConsentInput {
  member_id: string;
  tenant_slug?: string;
  sources: WorkInventoryConsentSource[];
  observation_kinds: WorkInventoryObservationKind[];
  purpose: string;
  expires_at: string;
  granted_by: WorkInventoryHumanActor;
}

export interface ConsentStorageOptions {
  rootDir?: string;
}

function assertSubject(by: WorkInventoryHumanActor | undefined, memberId: string, what: string) {
  if (!by || by.kind !== 'human' || by.id !== memberId) {
    throw new WorkInventoryConsentError(
      'not_subject',
      `${what} must be performed by the member themself (${memberId})`
    );
  }
}

function generateConsentId(now: Date): string {
  const datePart = now.toISOString().slice(0, 10).replaceAll('-', '');
  return `WIC-${datePart}-${randomBytes(6).toString('hex')}`;
}

export function grantWorkInventoryConsent(
  input: GrantWorkInventoryConsentInput,
  options: ConsentStorageOptions & { now?: Date } = {}
): WorkInventoryConsent {
  const now = options.now ?? new Date();
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  assertMemberId(input.member_id);
  assertSubject(input.granted_by, input.member_id, 'granting consent');

  if (input.tenant_slug !== undefined && !isValidTenantSlug(input.tenant_slug)) {
    throw new WorkInventoryConsentError(
      'invalid_input',
      `invalid tenant slug: ${input.tenant_slug}`
    );
  }
  const sources = [...new Set(input.sources ?? [])];
  if (sources.length === 0 || sources.some((s) => !WORK_INVENTORY_CONSENT_SOURCES.includes(s))) {
    throw new WorkInventoryConsentError(
      'invalid_input',
      `sources must be a non-empty subset of ${WORK_INVENTORY_CONSENT_SOURCES.join(', ')}`
    );
  }
  const kinds = [...new Set(input.observation_kinds ?? [])];
  const forbidden = kinds.filter((kind) => FORBIDDEN_OBSERVATION_KINDS.includes(kind));
  if (forbidden.length > 0) {
    throw new WorkInventoryConsentError(
      'forbidden_observation_kind',
      `observation kinds ${forbidden.join(', ')} can never be consented to`
    );
  }
  if (kinds.length === 0 || kinds.some((kind) => !CONSENTABLE_OBSERVATION_KINDS.includes(kind))) {
    throw new WorkInventoryConsentError(
      'invalid_input',
      `observation_kinds must be a non-empty subset of ${CONSENTABLE_OBSERVATION_KINDS.join(', ')}`
    );
  }
  const purpose = typeof input.purpose === 'string' ? input.purpose.trim() : '';
  if (!purpose || purpose.length > 500) {
    throw new WorkInventoryConsentError('invalid_input', 'purpose must be 1..500 characters');
  }
  const expires = Date.parse(input.expires_at);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    throw new WorkInventoryConsentError('invalid_input', 'expires_at must be in the future');
  }
  if (expires - now.getTime() > MAX_CONSENT_WINDOW_MS) {
    throw new WorkInventoryConsentError(
      'invalid_input',
      `expires_at must be at most ${MAX_CONSENT_WINDOW_DAYS} days after granted_at`
    );
  }

  const consent: WorkInventoryConsent = {
    schema_version: 'work-inventory-consent.v1',
    consent_id: generateConsentId(now),
    member_id: input.member_id,
    ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
    sources,
    observation_kinds: kinds,
    purpose,
    granted_at: nowIso(now),
    expires_at: new Date(expires).toISOString(),
    granted_by: { kind: 'human', id: input.granted_by.id },
  };
  const check = validateWorkInventoryConsent(consent);
  if (!check.valid) {
    throw new WorkInventoryConsentError('invalid_input', check.errors.join('; '));
  }
  recordConsentAudit('work_inventory.consent_granted', consent);
  writeConsent(consent, rootDir);
  return consent;
}

export function revokeWorkInventoryConsent(
  memberId: string,
  consentId: string,
  options: ConsentStorageOptions & { by: WorkInventoryHumanActor; now?: Date }
): WorkInventoryConsent {
  const now = options.now ?? new Date();
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  assertMemberId(memberId);
  assertSubject(options.by, memberId, 'revoking consent');
  const existing = readConsent(memberId, consentId, rootDir);
  if (!existing) {
    throw new WorkInventoryConsentError('not_found', `consent ${consentId} not found`);
  }
  if (existing.revoked_at) {
    throw new WorkInventoryConsentError('invalid_state', `consent ${consentId} already revoked`);
  }
  const revoked: WorkInventoryConsent = {
    ...existing,
    revoked_at: nowIso(now),
    revoked_by: { kind: 'human', id: options.by.id },
  };
  recordConsentAudit('work_inventory.consent_revoked', revoked, { revoked_at: revoked.revoked_at });
  writeConsent(revoked, rootDir);
  return revoked;
}

/** Valid consent records of one member (invalid / misplaced files are skipped: they grant nothing). */
export function listWorkInventoryConsents(
  memberId: string,
  options: ConsentStorageOptions = {}
): WorkInventoryConsent[] {
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  const dir = consentsDir(memberId, rootDir);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''))
    .filter((id) => CONSENT_ID_PATTERN.test(id))
    .map((id) => readConsent(memberId, id, rootDir))
    .filter((consent): consent is WorkInventoryConsent => Boolean(consent))
    .sort(
      (a, b) => a.granted_at.localeCompare(b.granted_at) || a.consent_id.localeCompare(b.consent_id)
    );
}

// ---------------------------------------------------------------------------
// Coverage evaluation
// ---------------------------------------------------------------------------

export type ConsentCoverage =
  | { ok: true; consent: WorkInventoryConsent }
  | { ok: false; code: WorkInventoryConsentErrorCode; reason: string };

/** Consent is active at `at` iff granted_at ≤ at < expires_at and not revoked at or before `at`. */
export function isConsentActiveAt(consent: WorkInventoryConsent, at: Date): boolean {
  const t = at.getTime();
  if (!Number.isFinite(t)) return false;
  if (t < Date.parse(consent.granted_at)) return false;
  if (t >= Date.parse(consent.expires_at)) return false;
  if (consent.revoked_at !== undefined && Date.parse(consent.revoked_at) <= t) return false;
  return true;
}

function tenantCompatible(consent: WorkInventoryConsent, tenantSlug: string | undefined): boolean {
  // A tenant-bound consent only covers that tenant; an unbound consent covers any context.
  if (!consent.tenant_slug) return true;
  return consent.tenant_slug === tenantSlug;
}

/**
 * Pure coverage evaluation over a member's consents: the first consent that
 * covers `source` for the tenant and is active at EVERY instant in `at`.
 * Requiring a single consent across all instants means a later re-grant never
 * retroactively blesses a recording made under a consent that was since
 * revoked or expired. On failure the most specific reason is reported.
 */
export function evaluateConsentCoverage(
  consents: readonly WorkInventoryConsent[],
  source: WorkInventoryConsentSource,
  at: readonly Date[],
  tenantSlug?: string
): ConsentCoverage {
  if (consents.length === 0) {
    return { ok: false, code: 'no_consent', reason: 'member has no consent on record' };
  }
  const bySource = consents.filter((consent) => consent.sources.includes(source));
  if (bySource.length === 0) {
    return { ok: false, code: 'source_not_covered', reason: `no consent covers ${source}` };
  }
  const byTenant = bySource.filter((consent) => tenantCompatible(consent, tenantSlug));
  if (byTenant.length === 0) {
    return {
      ok: false,
      code: 'tenant_mismatch',
      reason: `no consent for ${source} is bound to tenant ${tenantSlug ?? '(none)'}`,
    };
  }
  const active = byTenant.find((consent) =>
    at.every((instant) => isConsentActiveAt(consent, instant))
  );
  if (active) return { ok: true, consent: active };

  const times = at.map((instant) => instant.getTime());
  const revoked = byTenant.some(
    (consent) =>
      consent.revoked_at !== undefined &&
      times.some((t) => t >= Date.parse(consent.revoked_at as string)) &&
      times.every((t) => t >= Date.parse(consent.granted_at))
  );
  if (revoked) {
    return { ok: false, code: 'consent_revoked', reason: 'consent was revoked within the window' };
  }
  const expired = byTenant.some(
    (consent) =>
      times.some((t) => t >= Date.parse(consent.expires_at)) &&
      times.every((t) => t >= Date.parse(consent.granted_at))
  );
  if (expired) {
    return { ok: false, code: 'consent_expired', reason: 'consent expired within the window' };
  }
  return {
    ok: false,
    code: 'no_consent',
    reason: 'no single consent was active across the whole window (e.g. recorded before consent)',
  };
}

/** The member's consent covering `source` at time `at`, or null. */
export function findActiveConsent(
  memberId: string,
  source: WorkInventoryConsentSource,
  at: Date,
  options: ConsentStorageOptions & { tenant_slug?: string } = {}
): WorkInventoryConsent | null {
  const coverage = evaluateConsentCoverage(
    listWorkInventoryConsents(memberId, options),
    source,
    [at],
    options.tenant_slug
  );
  return coverage.ok ? coverage.consent : null;
}
