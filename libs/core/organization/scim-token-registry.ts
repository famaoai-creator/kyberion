/**
 * SCIM provisioning tokens — the credential an organization's IdP (Entra ID,
 * Okta, …) presents to `/scim/v2`. It is NOT a member token:
 *
 *   - it reaches only the SCIM endpoint of the tenant that issued it (the
 *     tenant is part of the token and is proven by the hash match in that
 *     tenant's own registry — there is no cross-tenant lookup to confuse);
 *   - other surfaces reject its shape outright (`isScimProvisioningTokenFormat`);
 *   - only an owner of the tenant issues or revokes one.
 *
 * The token is `kscim~<tenant>~<token_id>~<secret>`; only sha256(secret) is
 * stored, compared in constant time. Each token also fixes, at issue time,
 * the OIDC issuer that SCIM `externalId`s bind under and the role new
 * members receive (never `owner`). Records live under
 * `knowledge/confidential/<tenant>/scim/tokens/`; issue / revoke are appended
 * to a per-tenant ledger and, with every use and rejection, to the audit chain.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { isVitestProcess } from '../foundation/env.js';
import { appendJsonLine, readJsonIfPresent, readJsonLines, writeJson } from '../foundation/json.js';
import { auditChain } from '../governance/audit-chain.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeReaddir } from '../secure-io.js';
import { CHANNEL_IDENTITY_ISSUERS } from '../surface/channel-speaker-principal.js';
import { trimTrailingSlashes } from '../surface/surface-session-cookie.js';
import {
  readMemberProfile,
  type MemberRegistryPathOptions,
  type MemberRole,
} from './member-registry.js';
import { SCIM_TOKEN_PREFIX } from './scim-protocol.js';
import { readTenantProfile } from './tenant-registry.js';

/** Roles a SCIM-created member may receive. Ownership is never provisioned. */
export type ScimProvisionedRole = Exclude<MemberRole, 'owner'>;
export const SCIM_PROVISIONED_ROLES: readonly ScimProvisionedRole[] = [
  'approver',
  'operator',
  'viewer',
];
export const SCIM_DEFAULT_ROLE: ScimProvisionedRole = 'viewer';

export interface ScimTokenRecord {
  token_id: string;
  tenant_slug: string;
  label: string;
  /** OIDC issuer the SCIM `externalId` binds under (member `external_identities`). */
  issuer: string;
  default_role: ScimProvisionedRole;
  token_sha256: string;
  status: 'active' | 'revoked';
  issued_by: string;
  issued_at: string;
  revoked_by?: string;
  revoked_at?: string;
}

/** A token as shown to people: never carries the hash. */
export type PublicScimToken = Omit<ScimTokenRecord, 'token_sha256'>;

/** The authenticated SCIM caller: one tenant, one issuer, one default role. */
export interface ScimPrincipal {
  token_id: string;
  tenant_slug: string;
  issuer: string;
  default_role: ScimProvisionedRole;
}

export interface ScimAuditEvent {
  action: string;
  result: 'completed' | 'denied' | 'error';
  /** Absent only for a rejected token naming a tenant that does not provision over SCIM. */
  tenantSlug?: string;
  tokenId?: string;
  memberId?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type ScimAuditSink = (event: ScimAuditEvent) => void;

export interface ScimRegistryOptions extends MemberRegistryPathOptions {
  /** Audit sink; defaults to the hash-chained audit trail (skipped in vitest unless injected). */
  audit?: ScimAuditSink;
}

export class ScimTokenError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'invalid' | 'not_found' | 'revoked',
    message: string
  ) {
    super(message);
    this.name = 'ScimTokenError';
  }
}

const TOKEN_ID = /^scim-[a-f0-9]{16}$/;
const LABEL_MAX = 80;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function defaultAudit(event: ScimAuditEvent): void {
  if (isVitestProcess()) return;
  auditChain.record({
    agentId: event.tokenId ? `scim:${event.tokenId}` : 'scim',
    action: event.action,
    operation: event.memberId
      ? `user:${event.memberId}`
      : event.tenantSlug
        ? `tenant:${event.tenantSlug}`
        : 'scim',
    result: event.result,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.tenantSlug ? { tenantSlug: event.tenantSlug } : {}),
    metadata: {
      ...(event.tokenId ? { token_id: event.tokenId } : {}),
      ...(event.memberId ? { member_id: event.memberId } : {}),
      ...(event.metadata ?? {}),
    },
  });
}

export function recordScimAudit(event: ScimAuditEvent, options: ScimRegistryOptions = {}): void {
  (options.audit ?? defaultAudit)(event);
}

export function scimTenantDir(tenantSlug: string, options: MemberRegistryPathOptions = {}): string {
  if (!isValidTenantSlug(tenantSlug)) throw new ScimTokenError('invalid', 'invalid tenant');
  const root = options.rootDir ?? pathResolver.rootDir();
  return path.join(root, 'knowledge', 'confidential', tenantSlug, 'scim');
}

function tokenDir(tenantSlug: string, options: MemberRegistryPathOptions): string {
  return path.join(scimTenantDir(tenantSlug, options), 'tokens');
}

function safe(file: string, options: MemberRegistryPathOptions): string {
  return assertSafeRepositoryPath(file, { allowMissingLeaf: true, rootDir: options.rootDir });
}

function tokenPath(
  tenantSlug: string,
  tokenId: string,
  options: MemberRegistryPathOptions
): string {
  if (!TOKEN_ID.test(tokenId)) throw new ScimTokenError('invalid', 'invalid token id');
  return safe(path.join(tokenDir(tenantSlug, options), `${tokenId}.json`), options);
}

function ledgerPath(tenantSlug: string, options: MemberRegistryPathOptions): string {
  return safe(path.join(scimTenantDir(tenantSlug, options), 'scim.ledger.jsonl'), options);
}

function readToken(
  tenantSlug: string,
  tokenId: string,
  options: MemberRegistryPathOptions
): ScimTokenRecord | null {
  const record = readJsonIfPresent<ScimTokenRecord>(tokenPath(tenantSlug, tokenId, options));
  if (!record) return null;
  if (record.token_id !== tokenId || record.tenant_slug !== tenantSlug) {
    throw new Error(
      `[scim-token] record '${tokenId}' does not match its location — tampered or misplaced | inspect knowledge/confidential/${tenantSlug}/scim/tokens/ | tenant=${tenantSlug}`
    );
  }
  return record;
}

function writeToken(record: ScimTokenRecord, options: MemberRegistryPathOptions): void {
  const file = tokenPath(record.tenant_slug, record.token_id, options);
  safeMkdir(path.dirname(file), { recursive: true });
  writeJson(file, record);
}

function ledger(
  tenantSlug: string,
  entry: Record<string, unknown>,
  options: MemberRegistryPathOptions,
  now: Date
): void {
  const file = ledgerPath(tenantSlug, options);
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, { ts: now.toISOString(), ...entry });
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** Compared against when no record exists; matches no presented secret. */
const MISSING_TOKEN_SHA256 = hashSecret(randomBytes(32).toString('base64url'));

/**
 * Rejections are audited once per tenant, reason and window; later ones in
 * the window are counted into the next admitted entry, so rotating random
 * tokens cannot flood the audit chain.
 */
const REJECT_AUDIT_WINDOW_MS = 60_000;
const REJECT_AUDIT_MAX_KEYS = 1024;
const rejectAuditWindows = new Map<string, { start: number; suppressed: number }>();

function admitRejectAudit(key: string, now: number): { suppressed: number } | null {
  let slot = key;
  if (!rejectAuditWindows.has(slot) && rejectAuditWindows.size >= REJECT_AUDIT_MAX_KEYS) {
    for (const [existing, window] of rejectAuditWindows) {
      if (now - window.start >= REJECT_AUDIT_WINDOW_MS) rejectAuditWindows.delete(existing);
    }
    if (rejectAuditWindows.size >= REJECT_AUDIT_MAX_KEYS) slot = '*';
  }
  const current = rejectAuditWindows.get(slot);
  if (current && now - current.start < REJECT_AUDIT_WINDOW_MS) {
    current.suppressed += 1;
    return null;
  }
  rejectAuditWindows.set(slot, { start: now, suppressed: 0 });
  return { suppressed: current?.suppressed ?? 0 };
}

/** Test seam: forget the reject-audit windows. */
export function resetScimRejectAuditThrottle(): void {
  rejectAuditWindows.clear();
}

function tenantIsActive(tenantSlug: string, options: MemberRegistryPathOptions): boolean {
  try {
    return readTenantProfile(tenantSlug, options)?.status === 'active';
  } catch {
    return false;
  }
}

function tenantHasScimTokens(tenantSlug: string, options: MemberRegistryPathOptions): boolean {
  try {
    return safeExistsSync(safe(tokenDir(tenantSlug, options), options));
  } catch {
    return false;
  }
}

function toPublic(record: ScimTokenRecord): PublicScimToken {
  const { token_sha256: _hash, ...rest } = record;
  void _hash;
  return rest;
}

function isLoopbackHost(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
}

/** An OIDC issuer: https (http only for a loopback IdP), no credentials/query/fragment, no trailing slash. */
export function normalizeScimIssuer(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    return null;
  }
  return trimTrailingSlashes(`${url.origin}${url.pathname}`);
}

/** The one issuer comparison SCIM uses: equal after `normalizeScimIssuer`, never on raw text. */
export function sameScimIssuer(a: unknown, b: unknown): boolean {
  const left = normalizeScimIssuer(a);
  return left !== null && left === normalizeScimIssuer(b);
}

/**
 * Chat-surface issuers (`https://slack.com`, …) name chat accounts, not IdP
 * sign-ins; a SCIM token bound to one would let an IdP rebind chat speakers.
 */
export function isChannelIdentityIssuer(issuer: unknown): boolean {
  return Object.values(CHANNEL_IDENTITY_ISSUERS).some((channel) => sameScimIssuer(channel, issuer));
}

/** Only an active owner of the tenant manages its SCIM tokens. */
function assertTenantOwner(
  tenantSlug: string,
  memberId: string,
  options: MemberRegistryPathOptions
): void {
  const member = readMemberProfile(memberId, options);
  const isOwner =
    member?.status === 'active' &&
    member.memberships.some((m) => m.tenant_slug === tenantSlug && m.role === 'owner');
  if (!isOwner) {
    throw new ScimTokenError(
      'forbidden',
      `member '${memberId}' is not an active owner of '${tenantSlug}' — only an owner manages SCIM tokens | run as an owner (--by <member-id>) | tenant=${tenantSlug}`
    );
  }
}

export function issueScimToken(
  input: {
    tenantSlug: string;
    label: string;
    issuer: string;
    defaultRole?: string;
    issuedByMemberId: string;
    now?: Date;
  },
  options: ScimRegistryOptions = {}
): { token: string; record: PublicScimToken } {
  const now = input.now ?? new Date();
  if (!isValidTenantSlug(input.tenantSlug)) throw new ScimTokenError('invalid', 'invalid tenant');
  const label = input.label.trim();
  if (!label || label.length > LABEL_MAX || CONTROL_CHARS.test(label)) {
    throw new ScimTokenError('invalid', `label must be 1..${LABEL_MAX} printable characters`);
  }
  // Kept exactly as configured: sign-in matches the bound issuer against the
  // id_token `iss` verbatim, so a trailing slash the IdP sends must survive.
  const issuer = typeof input.issuer === 'string' ? input.issuer.trim() : '';
  if (!normalizeScimIssuer(issuer)) {
    throw new ScimTokenError(
      'invalid',
      'issuer must be an https OIDC issuer URL — SCIM externalIds bind under it | pass --issuer or configure KYBERION_OIDC_ISSUER'
    );
  }
  if (isChannelIdentityIssuer(issuer)) {
    throw new ScimTokenError(
      'invalid',
      `issuer '${issuer}' is a chat-surface identity issuer — SCIM binds IdP sign-ins, not chat accounts | pass the OIDC issuer members sign in with`
    );
  }
  const role = input.defaultRole ?? SCIM_DEFAULT_ROLE;
  if (!(SCIM_PROVISIONED_ROLES as readonly string[]).includes(role)) {
    throw new ScimTokenError(
      'invalid',
      `default role '${role}' is not provisionable — SCIM never creates owners | use approver, operator or viewer`
    );
  }
  assertTenantOwner(input.tenantSlug, input.issuedByMemberId, options);
  const tokenId = `scim-${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('base64url');
  const record: ScimTokenRecord = {
    token_id: tokenId,
    tenant_slug: input.tenantSlug,
    label,
    issuer,
    default_role: role as ScimProvisionedRole,
    token_sha256: hashSecret(secret),
    status: 'active',
    issued_by: `user:${input.issuedByMemberId}`,
    issued_at: now.toISOString(),
  };
  writeToken(record, options);
  ledger(
    input.tenantSlug,
    { event: 'issued', token_id: tokenId, by: record.issued_by, default_role: record.default_role },
    options,
    now
  );
  recordScimAudit(
    {
      action: 'scim.token.issue',
      result: 'completed',
      tenantSlug: input.tenantSlug,
      tokenId,
      metadata: { by: record.issued_by, issuer, default_role: record.default_role },
    },
    options
  );
  return {
    token: `${SCIM_TOKEN_PREFIX}${input.tenantSlug}~${tokenId}~${secret}`,
    record: toPublic(record),
  };
}

export function revokeScimToken(
  input: { tenantSlug: string; tokenId: string; revokedByMemberId: string; now?: Date },
  options: ScimRegistryOptions = {}
): PublicScimToken {
  const now = input.now ?? new Date();
  assertTenantOwner(input.tenantSlug, input.revokedByMemberId, options);
  const record = readToken(input.tenantSlug, input.tokenId, options);
  if (!record) throw new ScimTokenError('not_found', 'SCIM token not found');
  if (record.status === 'revoked')
    throw new ScimTokenError('revoked', 'SCIM token is already revoked');
  const next: ScimTokenRecord = {
    ...record,
    status: 'revoked',
    revoked_by: `user:${input.revokedByMemberId}`,
    revoked_at: now.toISOString(),
  };
  writeToken(next, options);
  ledger(
    input.tenantSlug,
    { event: 'revoked', token_id: record.token_id, by: next.revoked_by },
    options,
    now
  );
  recordScimAudit(
    {
      action: 'scim.token.revoke',
      result: 'completed',
      tenantSlug: input.tenantSlug,
      tokenId: record.token_id,
      metadata: { by: next.revoked_by },
    },
    options
  );
  return toPublic(next);
}

export function listScimTokens(
  tenantSlug: string,
  options: MemberRegistryPathOptions = {}
): PublicScimToken[] {
  const dir = safe(tokenDir(tenantSlug, options), options);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((file) => /^scim-[a-f0-9]{16}\.json$/.test(file))
    .map((file) => readToken(tenantSlug, file.slice(0, -'.json'.length), options))
    .filter((record): record is ScimTokenRecord => record !== null)
    .map(toPublic)
    .sort((a, b) => b.issued_at.localeCompare(a.issued_at));
}

export function readScimLedger(
  tenantSlug: string,
  options: MemberRegistryPathOptions = {}
): Array<Record<string, unknown>> {
  return readJsonLines<Record<string, unknown>>(ledgerPath(tenantSlug, options));
}

function parseToken(token: string): { tenant: string; id: string; secret: string } | null {
  if (!token.startsWith(SCIM_TOKEN_PREFIX)) return null;
  const [tenant, id, secret, extra] = token.slice(SCIM_TOKEN_PREFIX.length).split('~');
  if (extra !== undefined || !tenant || !id || !secret) return null;
  if (!isValidTenantSlug(tenant) || !TOKEN_ID.test(id) || secret.length < 32) return null;
  return { tenant, id, secret };
}

/**
 * Resolve a bearer credential to its SCIM principal, or null. One answer for
 * "malformed", "unknown", "wrong secret" and "revoked". Every use and every
 * rejection of a well-formed token is audited (never the token itself).
 */
export function authenticateScimToken(
  bearer: string | null | undefined,
  request: { method: string; path: string },
  options: ScimRegistryOptions = {}
): ScimPrincipal | null {
  const parsed = typeof bearer === 'string' ? parseToken(bearer.trim()) : null;
  if (!parsed) return null;
  let record: ScimTokenRecord | null = null;
  try {
    record = readToken(parsed.tenant, parsed.id, options);
  } catch {
    record = null;
  }
  // Hash and compare even without a record, so timing does not reveal
  // whether a token id exists.
  const presented = hashSecret(parsed.secret);
  const matches =
    constantTimeEqualHex(record?.token_sha256 ?? MISSING_TOKEN_SHA256, presented) &&
    record !== null;
  // A record whose default role is not provisionable (tampered to `owner`)
  // or whose issuer is malformed or a chat issuer is unusable, never trusted.
  const usable =
    record !== null &&
    (SCIM_PROVISIONED_ROLES as readonly string[]).includes(record.default_role) &&
    normalizeScimIssuer(record.issuer) !== null &&
    record.issuer === record.issuer.trim() &&
    !isChannelIdentityIssuer(record.issuer);
  // A suspended, archived or unregistered tenant provisions nobody.
  const tenantActive = matches && tenantIsActive(parsed.tenant, options);
  if (!record || !matches || record.status !== 'active' || !usable || !tenantActive) {
    const reason =
      !record || !matches
        ? 'unknown_or_mismatched'
        : record.status !== 'active'
          ? 'revoked'
          : !usable
            ? 'unusable_record'
            : 'tenant_inactive';
    // The tenant in an unverified token is caller-chosen: attribute the entry
    // to it only when that tenant actually provisions over SCIM.
    const tenantSlug = record || tenantHasScimTokens(parsed.tenant, options) ? parsed.tenant : null;
    const admitted = admitRejectAudit(`${tenantSlug ?? '-'}:${reason}`, Date.now());
    if (admitted) {
      recordScimAudit(
        {
          action: 'scim.token.reject',
          result: 'denied',
          ...(tenantSlug ? { tenantSlug } : {}),
          ...(record ? { tokenId: parsed.id } : {}),
          reason,
          metadata: {
            method: request.method,
            path: request.path,
            ...(admitted.suppressed ? { suppressed_since_last: admitted.suppressed } : {}),
          },
        },
        options
      );
    }
    return null;
  }
  recordScimAudit(
    {
      action: 'scim.token.use',
      result: 'completed',
      tenantSlug: record.tenant_slug,
      tokenId: record.token_id,
      metadata: { method: request.method, path: request.path },
    },
    options
  );
  return {
    token_id: record.token_id,
    tenant_slug: record.tenant_slug,
    issuer: record.issuer,
    default_role: record.default_role,
  };
}
