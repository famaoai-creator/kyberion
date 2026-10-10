/**
 * Inviting someone into an organization, and joining it.
 *
 * An invite is NOT a credential for an anonymous caller. It is a one-time
 * grant of a membership (tenant + role) to an identity the server has already
 * verified: an existing member, or a verified external IdP subject that is not
 * yet a member. Whoever holds the code but cannot authenticate gets nothing.
 *
 *   owner     may invite approver / operator / viewer
 *   approver  may invite operator / viewer
 *   others    may not invite
 *   nobody    invites an owner (ownership is never delegated by link)
 *
 * The code is `<tenant>~<invite_id>~<secret>`; only sha256(secret) is stored,
 * compared in constant time. An invite is single-use, expires (default 72h,
 * at most 30 days) and can be revoked. Every state change is appended to a
 * per-tenant ledger. Records live under `knowledge/confidential/<tenant>/invites/`.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as path from 'node:path';
import * as pathResolver from '../path-resolver.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import { readTextFile } from '../foundation/text.js';
import { isValidTenantSlug } from '../entity-scope.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from '../secure-io.js';
import {
  isValidMemberId,
  readMemberProfile,
  writeMemberProfile,
  type MemberProfile,
  type MemberRole,
  type MemberRegistryPathOptions,
} from './member-registry.js';

export type InvitableRole = Exclude<MemberRole, 'owner'>;
export type InviteStatus = 'pending' | 'accepted' | 'revoked';

export interface MemberInvite {
  invite_id: string;
  tenant_slug: string;
  role: InvitableRole;
  invited_by: string; // user:<member_id>
  created_at: string;
  expires_at: string;
  secret_sha256: string;
  status: InviteStatus;
  accepted_by?: string;
  accepted_at?: string;
  revoked_by?: string;
}

/** An invite as shown to people: never carries the secret hash. */
export type PublicInvite = Omit<MemberInvite, 'secret_sha256'> & { expired: boolean };

export interface InvitePathOptions extends MemberRegistryPathOptions {
  rootDir?: string;
}

export type InviteIdentity =
  | { kind: 'member'; memberId: string }
  | {
      kind: 'external';
      issuer: string;
      subject: string;
      email?: string;
      displayName: string;
    };

const INVITE_ID = /^inv-[a-f0-9]{16}$/;
const DEFAULT_TTL_HOURS = 72;
const MAX_TTL_HOURS = 720;

export class InviteError extends Error {
  constructor(
    public readonly code:
      | 'forbidden'
      | 'invalid'
      | 'not_found'
      | 'expired'
      | 'used'
      | 'revoked'
      | 'already_member'
      | 'member_unavailable',
    message: string
  ) {
    super(message);
    this.name = 'InviteError';
  }
}

function inviteDir(tenantSlug: string, options: InvitePathOptions): string {
  if (!isValidTenantSlug(tenantSlug)) throw new InviteError('invalid', 'invalid tenant');
  const root = options.rootDir ?? pathResolver.rootDir();
  return path.join(root, 'knowledge', 'confidential', tenantSlug, 'invites');
}

function invitePath(tenantSlug: string, inviteId: string, options: InvitePathOptions): string {
  if (!INVITE_ID.test(inviteId)) throw new InviteError('invalid', 'invalid invite id');
  return path.join(inviteDir(tenantSlug, options), `${inviteId}.json`);
}

function ledgerPath(tenantSlug: string, options: InvitePathOptions): string {
  return path.join(inviteDir(tenantSlug, options), 'invites.ledger.jsonl');
}

function safe(file: string, options: InvitePathOptions): string {
  return assertSafeRepositoryPath(file, { allowMissingLeaf: true, rootDir: options.rootDir });
}

function readInvite(
  tenantSlug: string,
  inviteId: string,
  options: InvitePathOptions
): MemberInvite | null {
  const file = safe(invitePath(tenantSlug, inviteId, options), options);
  if (!safeExistsSync(file)) return null;
  const parsed = parseSafeJsonInput(readTextFile(file), `invite '${inviteId}'`) as MemberInvite;
  if (parsed?.invite_id !== inviteId || parsed?.tenant_slug !== tenantSlug) {
    throw new Error(`[invite] file '${file}' does not match its id`);
  }
  return parsed;
}

function writeInvite(invite: MemberInvite, options: InvitePathOptions): void {
  const file = safe(invitePath(invite.tenant_slug, invite.invite_id, options), options);
  safeMkdir(path.dirname(file), { recursive: true });
  safeWriteFile(file, JSON.stringify(invite, null, 2) + '\n', { encoding: 'utf8' });
}

function record(
  tenantSlug: string,
  entry: Record<string, unknown>,
  options: InvitePathOptions,
  now: Date
): void {
  const file = safe(ledgerPath(tenantSlug, options), options);
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, { ts: now.toISOString(), ...entry });
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function toPublic(invite: MemberInvite, now: Date): PublicInvite {
  const { secret_sha256: _hash, ...rest } = invite;
  void _hash;
  return { ...rest, expired: Date.parse(invite.expires_at) <= now.getTime() };
}

/** What a role may invite, by the inviter's own role in that tenant. */
export function invitableRolesFor(inviterRole: MemberRole | null | undefined): InvitableRole[] {
  if (inviterRole === 'owner') return ['approver', 'operator', 'viewer'];
  if (inviterRole === 'approver') return ['operator', 'viewer'];
  return [];
}

export function createInvite(
  input: {
    tenantSlug: string;
    role: string;
    inviterMemberId: string;
    inviterRole: MemberRole | null | undefined;
    ttlHours?: number;
    now?: Date;
  },
  options: InvitePathOptions = {}
): { invite: PublicInvite; code: string } {
  const now = input.now ?? new Date();
  if (!isValidTenantSlug(input.tenantSlug) || !isValidMemberId(input.inviterMemberId)) {
    throw new InviteError('invalid', 'invalid tenant or inviter');
  }
  const allowed = invitableRolesFor(input.inviterRole);
  if (!(allowed as string[]).includes(input.role)) {
    throw new InviteError('forbidden', `this member may not invite the role '${input.role}'`);
  }
  const ttl = input.ttlHours ?? DEFAULT_TTL_HOURS;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > MAX_TTL_HOURS) {
    throw new InviteError('invalid', `ttl must be within 1..${MAX_TTL_HOURS} hours`);
  }
  const inviteId = `inv-${randomBytes(8).toString('hex')}`;
  const secret = randomBytes(32).toString('base64url');
  const invite: MemberInvite = {
    invite_id: inviteId,
    tenant_slug: input.tenantSlug,
    role: input.role as InvitableRole,
    invited_by: `user:${input.inviterMemberId}`,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ttl * 3_600_000).toISOString(),
    secret_sha256: hashSecret(secret),
    status: 'pending',
  };
  writeInvite(invite, options);
  record(
    input.tenantSlug,
    { event: 'created', invite_id: inviteId, role: invite.role, by: invite.invited_by },
    options,
    now
  );
  return { invite: toPublic(invite, now), code: `${input.tenantSlug}~${inviteId}~${secret}` };
}

function parseCode(code: unknown): { tenant: string; id: string; secret: string } | null {
  if (typeof code !== 'string') return null;
  const [tenant, id, secret, extra] = code.trim().split('~');
  if (extra !== undefined || !tenant || !id || !secret) return null;
  if (!isValidTenantSlug(tenant) || !INVITE_ID.test(id) || secret.length < 20) return null;
  return { tenant, id, secret };
}

function constantTimeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

/** Resolve a code to its pending invite WITHOUT consuming it (for the "confirm your role" screen). */
export function previewInvite(
  code: unknown,
  options: InvitePathOptions = {},
  now: Date = new Date()
): PublicInvite {
  const parsed = parseCode(code);
  if (!parsed) throw new InviteError('not_found', 'invite not found');
  const invite = readInvite(parsed.tenant, parsed.id, options);
  // One answer for "no such invite" and "wrong secret": a guess learns nothing.
  if (!invite || !constantTimeEqualHex(invite.secret_sha256, hashSecret(parsed.secret))) {
    throw new InviteError('not_found', 'invite not found');
  }
  if (invite.status === 'accepted') throw new InviteError('used', 'invite was already used');
  if (invite.status === 'revoked') throw new InviteError('revoked', 'invite was revoked');
  if (Date.parse(invite.expires_at) <= now.getTime()) {
    throw new InviteError('expired', 'invite expired');
  }
  return toPublic(invite, now);
}

/** Member id for a not-yet-registered external identity (invites and SCIM agree on it). */
export function externalMemberId(issuer: string, subject: string): string {
  return `u-${createHash('sha256').update(`${issuer}\n${subject}`).digest('hex').slice(0, 10)}`;
}

/** Single use: mark the invite accepted before any grant is written. */
function claim(
  invite: MemberInvite,
  memberId: string,
  now: Date,
  options: InvitePathOptions
): void {
  writeInvite(
    {
      ...invite,
      status: 'accepted',
      accepted_by: `user:${memberId}`,
      accepted_at: now.toISOString(),
    },
    options
  );
}

/** If the grant fails after the claim, put the invite back so the invitee can retry. */
function grantOrRelease(invite: MemberInvite, options: InvitePathOptions, grant: () => void): void {
  try {
    grant();
  } catch (error) {
    writeInvite(invite, options);
    throw error;
  }
}

/**
 * Consume an invite for a verified identity. The identity MUST come from the
 * server's own authentication (never from the request body).
 */
export function acceptInvite(
  input: { code: unknown; identity: InviteIdentity; now?: Date },
  options: InvitePathOptions = {}
): { member_id: string; tenant_slug: string; role: InvitableRole; created_member: boolean } {
  const now = input.now ?? new Date();
  const preview = previewInvite(input.code, options, now);
  const { identity } = input;
  const invite = readInvite(preview.tenant_slug, preview.invite_id, options)!;
  let memberId: string;
  let created = false;

  if (identity.kind === 'member') {
    const profile = readMemberProfile(identity.memberId, options);
    if (!profile || profile.status !== 'active') {
      throw new InviteError('member_unavailable', 'member is unknown or suspended');
    }
    if (profile.memberships.some((m) => m.tenant_slug === invite.tenant_slug)) {
      throw new InviteError('already_member', 'already a member of this organization');
    }
    memberId = profile.member_id;
    claim(invite, memberId, now, options);
    grantOrRelease(invite, options, () =>
      writeMemberProfile(
        {
          ...profile,
          memberships: [
            ...profile.memberships,
            { tenant_slug: invite.tenant_slug, role: invite.role },
          ],
          updated_at: now.toISOString(),
        },
        options
      )
    );
  } else {
    const issuer = identity.issuer.trim();
    const subject = identity.subject.trim();
    const displayName = identity.displayName.trim().slice(0, 80);
    if (!issuer || !subject || !displayName) {
      throw new InviteError(
        'invalid',
        'a verified external identity and a display name are required'
      );
    }
    memberId = externalMemberId(issuer, subject);
    if (readMemberProfile(memberId, options)) {
      throw new InviteError(
        'already_member',
        'this identity already has an account; sign in as that member to join'
      );
    }
    claim(invite, memberId, now, options);
    const profile: MemberProfile = {
      member_id: memberId,
      display_name: displayName,
      status: 'active',
      memberships: [{ tenant_slug: invite.tenant_slug, role: invite.role }],
      access_registrations: [],
      external_identities: [
        { issuer, subject, ...(identity.email ? { email: identity.email } : {}) },
      ],
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    grantOrRelease(invite, options, () => writeMemberProfile(profile, options));
    created = true;
  }
  record(
    invite.tenant_slug,
    {
      event: 'accepted',
      invite_id: invite.invite_id,
      role: invite.role,
      by: `user:${memberId}`,
      created_member: created,
    },
    options,
    now
  );
  return {
    member_id: memberId,
    tenant_slug: invite.tenant_slug,
    role: invite.role,
    created_member: created,
  };
}

export function revokeInvite(
  input: {
    tenantSlug: string;
    inviteId: string;
    byMemberId: string;
    byRole: MemberRole | null | undefined;
    now?: Date;
  },
  options: InvitePathOptions = {}
): PublicInvite {
  const now = input.now ?? new Date();
  const invite = readInvite(input.tenantSlug, input.inviteId, options);
  if (!invite) throw new InviteError('not_found', 'invite not found');
  const byRole = input.byRole;
  const own = invite.invited_by === `user:${input.byMemberId}`;
  const mayRevoke = byRole === 'owner' || (own && invitableRolesFor(byRole).length > 0);
  if (!mayRevoke) throw new InviteError('forbidden', 'only an owner or the inviter may revoke');
  if (invite.status !== 'pending')
    throw new InviteError('used', `invite is already ${invite.status}`);
  const next: MemberInvite = {
    ...invite,
    status: 'revoked',
    revoked_by: `user:${input.byMemberId}`,
  };
  writeInvite(next, options);
  record(
    input.tenantSlug,
    { event: 'revoked', invite_id: invite.invite_id, by: next.revoked_by },
    options,
    now
  );
  return toPublic(next, now);
}

export function listInvites(
  tenantSlug: string,
  options: InvitePathOptions = {},
  now: Date = new Date()
): PublicInvite[] {
  const dir = safe(inviteDir(tenantSlug, options), options);
  if (!safeExistsSync(dir)) return [];
  return safeReaddir(dir)
    .filter((f) => /^inv-[a-f0-9]{16}\.json$/.test(f))
    .map((f) => readInvite(tenantSlug, f.slice(0, -'.json'.length), options))
    .filter((i): i is MemberInvite => i !== null)
    .map((i) => toPublic(i, now))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export function readInviteLedger(
  tenantSlug: string,
  options: InvitePathOptions = {}
): Array<Record<string, unknown>> {
  const file = safe(ledgerPath(tenantSlug, options), options);
  return safeExistsSync(file) ? readJsonLines<Record<string, unknown>>(file) : [];
}
