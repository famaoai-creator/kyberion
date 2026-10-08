/**
 * first-run-setup — let the operator finish setup from a surface before any
 * owner can sign in from a browser (no OIDC yet, no owner token).
 *
 * Proof of server access is a one-time setup code issued on the host
 * (`pnpm organization first-run code`); only its SHA-256 hash, expiry and
 * failed-attempt count are stored, in the secret-guard document
 * `kyberion-first-run`. Claiming creates (or reuses) the tenant and the owner
 * member, issues an owner-bound registry token returned exactly once, and
 * closes the bootstrap for good.
 *
 * Callers must already run inside an authorized (personal-tier) execution
 * context — member / tenant profiles and secret-guard documents live there.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { issueChronosAccessToken } from '../chronos-access-registry.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { isVitestProcess } from '../foundation/env.js';
import { nowIso } from '../foundation/time.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  isValidMemberId,
  listMemberIds,
  readMemberProfile,
  writeMemberProfile,
  type MemberProfile,
} from '../organization/member-registry.js';
import {
  listTenantProfileSlugs,
  readTenantProfile,
  writeTenantProfile,
} from '../organization/tenant-registry.js';
import { secretGuard } from '../secret/secret-guard.js';

export const FIRST_RUN_DOCUMENT = 'kyberion-first-run';
export const FIRST_RUN_DEFAULT_MEMBER_ID = 'owner';
export const FIRST_RUN_CODE_DEFAULT_TTL_MINUTES = 30;
export const FIRST_RUN_CODE_MAX_TTL_MINUTES = 24 * 60;
export const FIRST_RUN_MAX_FAILED_ATTEMPTS = 5;

/** No 0/O/1/I/L: the code is read off a terminal and may be retyped. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 20;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface FirstRunOptions {
  /** Member / tenant registry root (hermetic tests). */
  rootDir?: string;
  now?: number;
  audit?: (event: FirstRunAuditEvent) => void;
}

export interface FirstRunAuditEvent {
  operation: 'code_issued' | 'claim';
  result: 'completed' | 'error';
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type FirstRunErrorCode =
  | 'claimed'
  | 'invalid_input'
  | 'tenant_unavailable'
  | 'member_unavailable'
  | 'code_not_issued'
  | 'code_expired'
  | 'code_invalid'
  | 'code_locked';

export class FirstRunError extends Error {
  constructor(
    public readonly code: FirstRunErrorCode,
    public readonly field?: string
  ) {
    super(field ? `${code}: ${field}` : code);
    this.name = 'FirstRunError';
  }
}

interface FirstRunDocument {
  code_hash?: string | null;
  code_expires_at?: string | null;
  failed_attempts?: number;
  claimed_at?: string | null;
  claimed_member_id?: string | null;
  claimed_tenant_slug?: string | null;
}

function registryOptions(options: FirstRunOptions) {
  return options.rootDir ? { rootDir: options.rootDir } : {};
}

function nowMs(options: FirstRunOptions): number {
  return options.now ?? Date.now();
}

function loadDocument(): FirstRunDocument {
  return secretGuard.loadConnectionDocument(FIRST_RUN_DOCUMENT) as FirstRunDocument;
}

function storeDocument(patch: FirstRunDocument): void {
  secretGuard.storeConnectionDocument(FIRST_RUN_DOCUMENT, patch as Record<string, unknown>, {
    backup: false,
    actor: 'surface_first_run',
  });
}

function record(options: FirstRunOptions, event: FirstRunAuditEvent): void {
  try {
    if (options.audit) {
      options.audit(event);
      return;
    }
    if (isVitestProcess()) return;
    auditChain.record({
      agentId: 'surface-first-run',
      action: 'surface_first_run',
      operation: event.operation,
      result: event.result,
      reason: event.reason,
      metadata: event.metadata,
    });
  } catch {
    // Audit is best-effort: secret-guard writes are also ledgered as CONFIG_CHANGE.
  }
}

function hashCode(code: string): string {
  return createHash('sha256').update(`kyberion-first-run:${code}`).digest('hex');
}

function normalizeCode(value: unknown): string {
  return typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

function generateCode(): string {
  // Rejection sampling keeps every character uniformly likely.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH * 2)) {
      if (byte < limit && out.length < CODE_LENGTH)
        out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

/**
 * True when some active member holding an owner membership can already sign
 * in from a browser (a registry token or a bound IdP identity). An unreadable
 * registry counts as "yes": it must never re-open the bootstrap.
 */
function ownerCanSignIn(options: FirstRunOptions): boolean {
  try {
    for (const memberId of listMemberIds(registryOptions(options))) {
      const member = readMemberProfile(memberId, registryOptions(options));
      if (
        member?.status === 'active' &&
        member.memberships.some((membership) => membership.role === 'owner') &&
        (member.access_registrations.length > 0 || (member.external_identities ?? []).length > 0)
      ) {
        return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

export interface FirstRunStatus {
  state: 'unclaimed' | 'claimed';
  code_active: boolean;
  code_expires_at?: string;
}

export function readFirstRunStatus(options: FirstRunOptions = {}): FirstRunStatus {
  let doc: FirstRunDocument;
  try {
    doc = loadDocument();
  } catch {
    return { state: 'claimed', code_active: false };
  }
  if (doc.claimed_at || ownerCanSignIn(options)) return { state: 'claimed', code_active: false };
  const expiresAt = doc.code_expires_at ? Date.parse(doc.code_expires_at) : NaN;
  const active = Boolean(doc.code_hash) && Number.isFinite(expiresAt) && expiresAt > nowMs(options);
  return {
    state: 'unclaimed',
    code_active: active,
    ...(active && doc.code_expires_at ? { code_expires_at: doc.code_expires_at } : {}),
  };
}

export interface IssuedFirstRunCode {
  code: string;
  expires_at: string;
}

/** Issue (or replace) the one-time setup code. Refused once claimed. */
export function issueFirstRunSetupCode(
  input: { ttlMinutes?: number } = {},
  options: FirstRunOptions = {}
): IssuedFirstRunCode {
  const ttl = input.ttlMinutes ?? FIRST_RUN_CODE_DEFAULT_TTL_MINUTES;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > FIRST_RUN_CODE_MAX_TTL_MINUTES) {
    throw new FirstRunError('invalid_input', 'ttl_minutes');
  }
  if (readFirstRunStatus(options).state === 'claimed') throw new FirstRunError('claimed');
  const code = generateCode();
  const expiresAt = new Date(nowMs(options) + ttl * 60_000).toISOString();
  storeDocument({
    code_hash: hashCode(normalizeCode(code)),
    code_expires_at: expiresAt,
    failed_attempts: 0,
  });
  record(options, {
    operation: 'code_issued',
    result: 'completed',
    metadata: { expires_at: expiresAt },
  });
  return { code, expires_at: expiresAt };
}

/** Check the code; a failure is counted and the code is dropped at the limit. */
function checkCode(value: unknown, options: FirstRunOptions): void {
  const doc = loadDocument();
  if (!doc.code_hash || !doc.code_expires_at) throw new FirstRunError('code_not_issued');
  if (Date.parse(doc.code_expires_at) <= nowMs(options)) throw new FirstRunError('code_expired');
  const presented = Buffer.from(hashCode(normalizeCode(value)), 'hex');
  const expected = Buffer.from(doc.code_hash, 'hex');
  if (presented.length === expected.length && timingSafeEqual(presented, expected)) return;
  const attempts = (Number(doc.failed_attempts) || 0) + 1;
  if (attempts >= FIRST_RUN_MAX_FAILED_ATTEMPTS) {
    storeDocument({ code_hash: null, code_expires_at: null, failed_attempts: attempts });
    throw new FirstRunError('code_locked');
  }
  storeDocument({ failed_attempts: attempts });
  throw new FirstRunError('code_invalid');
}

export interface FirstRunClaimInput {
  code?: unknown;
  tenant_slug?: unknown;
  tenant_display_name?: unknown;
  display_name?: unknown;
  member_id?: unknown;
}

export interface FirstRunClaimResult {
  /** Raw access token — returned exactly once, never stored in plaintext. */
  token: string;
  member_id: string;
  tenant_slug: string;
  tenant_slugs: string[];
  registration_label: string;
}

function text(value: unknown, field: string, max: number, required: boolean): string | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new FirstRunError('invalid_input', field);
    return undefined;
  }
  if (typeof value !== 'string') throw new FirstRunError('invalid_input', field);
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > max || CONTROL_CHARS.test(trimmed)) {
    throw new FirstRunError('invalid_input', field);
  }
  return trimmed || undefined;
}

function labelTimestamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '');
}

export function claimFirstRun(
  input: FirstRunClaimInput,
  options: FirstRunOptions = {}
): FirstRunClaimResult {
  const tenantSlug = text(input.tenant_slug, 'tenant_slug', 31, true)!;
  if (!isValidTenantSlug(tenantSlug)) throw new FirstRunError('invalid_input', 'tenant_slug');
  const tenantDisplayName = text(input.tenant_display_name, 'tenant_display_name', 80, false);
  const displayName = text(input.display_name, 'display_name', 80, true)!;
  const memberId = text(input.member_id, 'member_id', 31, false) ?? FIRST_RUN_DEFAULT_MEMBER_ID;
  if (!isValidMemberId(memberId) || memberId.startsWith('ext-')) {
    throw new FirstRunError('invalid_input', 'member_id');
  }

  if (readFirstRunStatus(options).state === 'claimed') throw new FirstRunError('claimed');
  const registry = registryOptions(options);
  const existingTenant = readTenantProfile(tenantSlug, registry);
  if (existingTenant && existingTenant.status !== 'active') {
    throw new FirstRunError('tenant_unavailable');
  }
  const existingMember = readMemberProfile(memberId, registry);
  if (existingMember && existingMember.status !== 'active') {
    throw new FirstRunError('member_unavailable');
  }

  try {
    checkCode(input.code, options);
  } catch (error) {
    record(options, {
      operation: 'claim',
      result: 'error',
      reason: error instanceof FirstRunError ? error.code : 'code_check_failed',
    });
    throw error;
  }
  // Consume before any write: a code never authorizes two claims.
  storeDocument({ code_hash: null, code_expires_at: null, failed_attempts: 0 });

  const now = nowIso();
  if (!existingTenant) {
    writeTenantProfile(
      {
        tenant_slug: tenantSlug,
        tenant_id: tenantSlug,
        display_name: tenantDisplayName ?? tenantSlug,
        status: 'active',
        assigned_role: 'owner',
      },
      registry
    );
  }
  // Same reach as ensureOwnerMember: the host operator owns every tenant.
  const tenantSlugs = [...new Set([...listTenantProfileSlugs(registry), tenantSlug])].sort();
  const label = `${memberId}-first-run-${labelTimestamp(nowMs(options))}`;
  const issued = issueChronosAccessToken({
    role: 'localadmin',
    tenantSlugs,
    label,
    memberId,
  });
  const memberships = [
    ...(existingMember?.memberships ?? []).filter(
      (membership) => !tenantSlugs.includes(membership.tenant_slug)
    ),
    ...tenantSlugs.map((tenant_slug) => ({ tenant_slug, role: 'owner' as const })),
  ];
  const member: MemberProfile = {
    ...(existingMember ?? {
      member_id: memberId,
      status: 'active' as const,
      access_registrations: [],
      created_at: now,
    }),
    display_name: displayName,
    memberships,
    access_registrations: [...(existingMember?.access_registrations ?? []), { label }],
    updated_at: now,
  };
  writeMemberProfile(member, registry);
  storeDocument({
    claimed_at: now,
    claimed_member_id: memberId,
    claimed_tenant_slug: tenantSlug,
  });
  record(options, {
    operation: 'claim',
    result: 'completed',
    metadata: { member_id: memberId, tenant_slug: tenantSlug, registration_label: label },
  });
  return {
    token: issued.token,
    member_id: memberId,
    tenant_slug: tenantSlug,
    tenant_slugs: tenantSlugs,
    registration_label: label,
  };
}

/**
 * "Instance owner": an active member that owns every registered tenant.
 * Instance-wide settings (the SSO login itself) are limited to this member.
 */
export function isInstanceOwner(
  member: MemberProfile | null,
  options: FirstRunOptions = {}
): boolean {
  if (!member || member.status !== 'active') return false;
  const tenants = listTenantProfileSlugs(registryOptions(options));
  if (tenants.length === 0) {
    return member.memberships.some((membership) => membership.role === 'owner');
  }
  return tenants.every((slug) =>
    member.memberships.some(
      (membership) => membership.tenant_slug === slug && membership.role === 'owner'
    )
  );
}
