/**
 * SCIM 2.0 Users provisioning for one tenant (RFC 7644 §3), as an
 * authentication anchor only: the external IdP proves who someone is, the
 * Kyberion member registry stays the source of truth for status,
 * memberships, roles and delegation.
 *
 *   - A SCIM User is a member with a membership in the token's tenant
 *     (`id` = member id). Other tenants' members are invisible (404).
 *   - POST creates a member with the token's default role (never owner).
 *     SCIM never reads, writes or changes a role.
 *   - SCIM changes only members whose role in the tenant is not owner and
 *     ranks at most the token's default role (viewer < operator < approver).
 *     Owners and higher-ranked members are changed in Kyberion only.
 *   - `externalId` binds the member's external identity under the token's
 *     issuer; login then resolves through it. SCIM sets, moves or removes it
 *     only on members whose every identity this tenant's SCIM bound
 *     (`provisioned_by`), or that have no identity and no access token. A PUT
 *     without `externalId` leaves the binding alone. Issuers compare through
 *     `sameScimIssuer`; bindings store the issuer exactly as configured.
 *   - `active:false` and DELETE suspend the member (never a hard delete) and
 *     record `suspended_by`; SCIM reactivates only members it suspended.
 *     Suspended members resolve like unregistered identities everywhere,
 *     so their browser sessions and member tokens stop working at once.
 *   - The member record is global, so `active`, `displayName` and
 *     `externalId` change only for members this tenant governs alone; a
 *     member shared with another organization is changed by an owner.
 *   - Each change is one member-profile write (identities, status and display
 *     name together); the tenant-side record follows and a failure there
 *     restores the previous profile.
 *
 * SCIM-only attributes (`userName`, `name`, `emails`) are tenant data and
 * live under `knowledge/confidential/<tenant>/scim/users/`.
 */

import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { assertSafeRepositoryPath, safeMkdir } from '../secure-io.js';
import { externalMemberId } from './member-invite.js';
import {
  isValidMemberId,
  listMemberIdsStrict,
  readMemberProfile,
  writeMemberProfile,
  type MemberExternalIdentity,
  type MemberProfile,
} from './member-registry.js';
import {
  applyScimPatch,
  parseScimFilter,
  parseScimPaging,
  parseScimUserInput,
  scimDisplayName,
  scimFilterMatches,
  scimListResponse,
  scimPrimaryEmail,
  ScimError,
  SCIM_USER_SCHEMA,
  type ScimEmail,
  type ScimName,
  type ScimUserAttributes,
} from './scim-protocol.js';
import {
  listScimTokens,
  recordScimAudit,
  sameScimIssuer,
  scimTenantDir,
  type ScimPrincipal,
  type ScimProvisionedRole,
  type ScimRegistryOptions,
} from './scim-token-registry.js';

const ROLE_RANK: Record<ScimProvisionedRole, number> = { viewer: 0, operator: 1, approver: 2 };
const SCIM_PROVENANCE = /^scim:scim-[a-f0-9]{16}$/;

/** Tenant-side SCIM attributes of one member. */
export interface ScimUserRecord {
  member_id: string;
  tenant_slug: string;
  user_name: string;
  name?: ScimName;
  emails?: ScimEmail[];
  created_at: string;
  updated_at: string;
}

export interface ScimUserResource {
  schemas: [typeof SCIM_USER_SCHEMA];
  id: string;
  externalId?: string;
  userName: string;
  displayName: string;
  name?: ScimName;
  emails?: ScimEmail[];
  active: boolean;
  meta: { resourceType: 'User'; created: string; lastModified: string; location: string };
}

export interface ScimUsersOptions extends ScimRegistryOptions {
  now?: Date;
}

export interface ScimTenantMember {
  member: MemberProfile;
  record: ScimUserRecord | null;
}

function recordPath(tenantSlug: string, memberId: string, options: ScimUsersOptions): string {
  const file = path.join(scimTenantDir(tenantSlug, options), 'users', `${memberId}.json`);
  return assertSafeRepositoryPath(file, { allowMissingLeaf: true, rootDir: options.rootDir });
}

function readRecord(
  tenantSlug: string,
  memberId: string,
  options: ScimUsersOptions
): ScimUserRecord | null {
  const record = readJsonIfPresent<ScimUserRecord>(recordPath(tenantSlug, memberId, options));
  if (!record) return null;
  return record.member_id === memberId && record.tenant_slug === tenantSlug ? record : null;
}

function writeRecord(record: ScimUserRecord, options: ScimUsersOptions): void {
  const file = recordPath(record.tenant_slug, record.member_id, options);
  safeMkdir(path.dirname(file), { recursive: true });
  writeJson(file, record);
}

function inTenant(member: MemberProfile, tenantSlug: string): boolean {
  return member.memberships.some((m) => m.tenant_slug === tenantSlug);
}

/** True when no other organization shares this member record. */
function governedAlone(member: MemberProfile, tenantSlug: string): boolean {
  return member.memberships.every((m) => m.tenant_slug === tenantSlug);
}

function tenantMembers(principal: ScimPrincipal, options: ScimUsersOptions): ScimTenantMember[] {
  const out: ScimTenantMember[] = [];
  for (const memberId of listMemberIdsStrict(options)) {
    let member: MemberProfile | null = null;
    try {
      member = readMemberProfile(memberId, options);
    } catch {
      continue;
    }
    if (!member || !inTenant(member, principal.tenant_slug)) continue;
    out.push({ member, record: readRecord(principal.tenant_slug, memberId, options) });
  }
  return out;
}

function findScimTenantMember(
  principal: ScimPrincipal,
  id: string,
  options: ScimUsersOptions
): ScimTenantMember {
  // One answer for "no such member" and "member of another organization".
  const member = isValidMemberId(id) ? readMemberProfile(id, options) : null;
  if (!member || !inTenant(member, principal.tenant_slug)) {
    throw new ScimError(404, undefined, `User ${id.slice(0, 64)} not found`);
  }
  return { member, record: readRecord(principal.tenant_slug, id, options) };
}

export function scimAttributesOf(
  entry: ScimTenantMember,
  principal: ScimPrincipal
): ScimUserAttributes {
  const { member, record } = entry;
  const identity = member.external_identities?.find((i) =>
    sameScimIssuer(i.issuer, principal.issuer)
  );
  const externalId = identity?.subject;
  return {
    userName: record?.user_name ?? identity?.email ?? member.member_id,
    ...(externalId ? { externalId } : {}),
    displayName: member.display_name,
    ...(record?.name ? { name: record.name } : {}),
    ...(record?.emails ? { emails: record.emails } : {}),
    active: member.status === 'active',
  };
}

function toResource(
  entry: ScimTenantMember,
  principal: ScimPrincipal,
  baseUrl: string
): ScimUserResource {
  const attributes = scimAttributesOf(entry, principal);
  const { member, record } = entry;
  const lastModified =
    record && record.updated_at > member.updated_at ? record.updated_at : member.updated_at;
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: member.member_id,
    ...(attributes.externalId ? { externalId: attributes.externalId } : {}),
    userName: attributes.userName,
    displayName: member.display_name,
    ...(attributes.name ? { name: attributes.name } : {}),
    ...(attributes.emails ? { emails: attributes.emails } : {}),
    active: attributes.active,
    meta: {
      resourceType: 'User',
      created: record?.created_at ?? member.created_at,
      lastModified,
      location: [baseUrl, 'Users', member.member_id].join('/'),
    },
  };
}

export function listScimUsers(
  principal: ScimPrincipal,
  query: { filter?: string | null; startIndex?: string | null; count?: string | null },
  baseUrl: string,
  options: ScimUsersOptions = {}
): ReturnType<typeof scimListResponse<ScimUserResource>> {
  const filter = parseScimFilter(query.filter);
  const paging = parseScimPaging(query.startIndex, query.count);
  const matched = tenantMembers(principal, options).filter(
    (entry) => !filter || scimFilterMatches(filter, scimAttributesOf(entry, principal))
  );
  const page = matched.slice(paging.startIndex - 1, paging.startIndex - 1 + paging.count);
  return scimListResponse(
    page.map((entry) => toResource(entry, principal, baseUrl)),
    matched.length,
    paging.startIndex
  );
}

export function getScimUser(
  principal: ScimPrincipal,
  id: string,
  baseUrl: string,
  options: ScimUsersOptions = {}
): ScimUserResource {
  return toResource(findScimTenantMember(principal, id, options), principal, baseUrl);
}

function assertUniqueUserName(
  principal: ScimPrincipal,
  userName: string,
  exceptMemberId: string | null,
  options: ScimUsersOptions
): void {
  const lowered = userName.toLowerCase();
  const taken = tenantMembers(principal, options).some(
    (entry) =>
      entry.member.member_id !== exceptMemberId &&
      scimAttributesOf(entry, principal).userName.toLowerCase() === lowered
  );
  if (taken) throw new ScimError(409, 'uniqueness', 'userName is already in use');
}

/** Any member (any tenant, any status) already bound to this issuer + subject. */
function identityBoundElsewhere(
  issuer: string,
  subject: string,
  exceptMemberId: string | null,
  options: ScimUsersOptions
): boolean {
  for (const memberId of listMemberIdsStrict(options)) {
    if (memberId === exceptMemberId) continue;
    let member: MemberProfile | null = null;
    try {
      member = readMemberProfile(memberId, options);
    } catch {
      // Cannot disprove the binding — fail closed.
      return true;
    }
    if (
      member?.external_identities?.some(
        (i) => sameScimIssuer(i.issuer, issuer) && i.subject === subject
      )
    ) {
      return true;
    }
  }
  return false;
}

/**
 * True when the token may change this member: every role the member holds in
 * the tenant is below owner and ranks at most the token's default role.
 */
function withinScimAuthority(principal: ScimPrincipal, member: MemberProfile): boolean {
  const roles = member.memberships
    .filter((m) => m.tenant_slug === principal.tenant_slug)
    .map((m) => m.role);
  return (
    roles.length > 0 &&
    roles.every((role) => role !== 'owner' && ROLE_RANK[role] <= ROLE_RANK[principal.default_role])
  );
}

/** True when `provenance` is `scim:<token_id>` of one of this tenant's SCIM tokens. */
function isThisTenantScim(
  principal: ScimPrincipal,
  provenance: string | undefined,
  options: ScimUsersOptions
): boolean {
  if (!provenance || !SCIM_PROVENANCE.test(provenance)) return false;
  return listScimTokens(principal.tenant_slug, options).some(
    (token) => `scim:${token.token_id}` === provenance
  );
}

/** One of this tenant's SCIM tokens made the current suspension. */
function suspendedByThisTenantScim(
  principal: ScimPrincipal,
  member: MemberProfile,
  options: ScimUsersOptions
): boolean {
  return member.status === 'suspended' && isThisTenantScim(principal, member.suspended_by, options);
}

/**
 * SCIM may set, move or remove `externalId` only on a member whose every
 * external identity this tenant's SCIM bound, or — when it has none — that
 * holds no access token either. An owner-made binding (OIDC, Slack, …) or a
 * token-linked member is changed in Kyberion only.
 */
function externalIdGovernedByScim(
  principal: ScimPrincipal,
  member: MemberProfile,
  options: ScimUsersOptions
): boolean {
  const identities = member.external_identities ?? [];
  if (!identities.length) return member.access_registrations.length === 0;
  return identities.every((identity) =>
    isThisTenantScim(principal, identity.provisioned_by, options)
  );
}

function withAudit<T>(
  principal: ScimPrincipal,
  action: string,
  memberId: string | undefined,
  options: ScimUsersOptions,
  run: () => { result: T; memberId: string; changes: string[] }
): T {
  try {
    const done = run();
    recordScimAudit(
      {
        action,
        result: 'completed',
        tenantSlug: principal.tenant_slug,
        tokenId: principal.token_id,
        memberId: done.memberId,
        metadata: { changes: done.changes },
      },
      options
    );
    return done.result;
  } catch (error) {
    recordScimAudit(
      {
        action,
        result: error instanceof ScimError ? 'denied' : 'error',
        tenantSlug: principal.tenant_slug,
        tokenId: principal.token_id,
        ...(memberId && isValidMemberId(memberId) ? { memberId } : {}),
        reason:
          error instanceof ScimError
            ? `${error.status}${error.scimType ? ` ${error.scimType}` : ''}`
            : 'internal_error',
      },
      options
    );
    throw error;
  }
}

export function createScimUser(
  principal: ScimPrincipal,
  body: unknown,
  baseUrl: string,
  options: ScimUsersOptions = {}
): ScimUserResource {
  return withAudit(principal, 'scim.user.create', undefined, options, () => {
    const now = (options.now ?? new Date()).toISOString();
    const user = parseScimUserInput(body);
    assertUniqueUserName(principal, user.userName, null, options);
    if (
      user.externalId &&
      identityBoundElsewhere(principal.issuer, user.externalId, null, options)
    ) {
      throw new ScimError(409, 'uniqueness', 'externalId is already bound to a member');
    }
    const memberId = user.externalId
      ? externalMemberId(principal.issuer, user.externalId)
      : `u-${randomBytes(5).toString('hex')}`;
    if (readMemberProfile(memberId, options)) {
      throw new ScimError(409, 'uniqueness', 'a member with this identity already exists');
    }
    const email = scimPrimaryEmail(user);
    const member = writeMemberProfile(
      {
        member_id: memberId,
        display_name: scimDisplayName(user),
        status: user.active ? 'active' : 'suspended',
        ...(user.active ? {} : { suspended_by: `scim:${principal.token_id}` }),
        memberships: [{ tenant_slug: principal.tenant_slug, role: principal.default_role }],
        access_registrations: [],
        ...(user.externalId
          ? {
              external_identities: [
                {
                  issuer: principal.issuer,
                  subject: user.externalId,
                  ...(email ? { email } : {}),
                  provisioned_by: `scim:${principal.token_id}`,
                },
              ],
            }
          : {}),
        created_at: now,
        updated_at: now,
      },
      options
    );
    const record: ScimUserRecord = {
      member_id: memberId,
      tenant_slug: principal.tenant_slug,
      user_name: user.userName,
      ...(user.name ? { name: user.name } : {}),
      ...(user.emails ? { emails: user.emails } : {}),
      created_at: now,
      updated_at: now,
    };
    writeRecord(record, options);
    return {
      result: toResource({ member, record }, principal, baseUrl),
      memberId,
      changes: [
        'created',
        `role:${principal.default_role}`,
        ...(user.externalId ? ['externalId'] : []),
      ],
    };
  });
}

/**
 * Apply the next attribute state to a tenant member. Every refusal happens
 * before the first write.
 */
function commitUser(
  principal: ScimPrincipal,
  entry: ScimTenantMember,
  next: ScimUserAttributes,
  baseUrl: string,
  options: ScimUsersOptions
): { result: ScimUserResource; memberId: string; changes: string[] } {
  const now = (options.now ?? new Date()).toISOString();
  const { member } = entry;
  const current = scimAttributesOf(entry, principal);
  // Without a displayName or name, an existing member keeps its display name
  // (it is not replaced by the userName fallback a new member gets).
  const displayName = next.displayName || next.name ? scimDisplayName(next) : member.display_name;
  const changes: string[] = [];
  if (next.active !== current.active) changes.push('active');
  if (displayName !== member.display_name) changes.push('displayName');
  if (next.externalId !== current.externalId) changes.push('externalId');
  const globalChanges = [...changes];
  if (next.userName !== current.userName) changes.push('userName');
  if (JSON.stringify(next.name ?? null) !== JSON.stringify(entry.record?.name ?? null)) {
    changes.push('name');
  }
  if (JSON.stringify(next.emails ?? null) !== JSON.stringify(entry.record?.emails ?? null)) {
    changes.push('emails');
  }

  const allowed = withinScimAuthority(principal, member);
  if (!changes.length && (entry.record || !allowed)) {
    return {
      result: toResource(entry, principal, baseUrl),
      memberId: member.member_id,
      changes,
    };
  }
  if (!allowed) {
    throw new ScimError(
      403,
      undefined,
      `member holds the owner role or a role above this token's ${principal.default_role}; it can only be changed by an owner in Kyberion`
    );
  }
  if (globalChanges.length && !governedAlone(member, principal.tenant_slug)) {
    throw new ScimError(
      403,
      undefined,
      `member also belongs to another organization; ${globalChanges.join(', ')} can only be changed by an owner in Kyberion`
    );
  }
  if (!current.active && next.active && !suspendedByThisTenantScim(principal, member, options)) {
    throw new ScimError(
      403,
      undefined,
      'member was suspended in Kyberion, not by SCIM; only an owner can reactivate it'
    );
  }
  if (changes.includes('externalId') && !externalIdGovernedByScim(principal, member, options)) {
    throw new ScimError(
      403,
      undefined,
      "member has an identity or access token linked in Kyberion, not by this organization's SCIM; only an owner can change its externalId"
    );
  }
  if (next.userName !== current.userName) {
    assertUniqueUserName(principal, next.userName, member.member_id, options);
  }
  if (
    next.externalId &&
    next.externalId !== current.externalId &&
    identityBoundElsewhere(principal.issuer, next.externalId, member.member_id, options)
  ) {
    throw new ScimError(409, 'uniqueness', 'externalId is already bound to a member');
  }

  let saved = member;
  if (globalChanges.length) {
    let identities: MemberExternalIdentity[] | undefined = member.external_identities;
    if (changes.includes('externalId')) {
      const email = scimPrimaryEmail(next);
      identities = [
        ...(member.external_identities ?? []).filter(
          (i) => !sameScimIssuer(i.issuer, principal.issuer)
        ),
        ...(next.externalId
          ? [
              {
                issuer: principal.issuer,
                subject: next.externalId,
                ...(email ? { email } : {}),
                provisioned_by: `scim:${principal.token_id}`,
              },
            ]
          : []),
      ];
    }
    const { suspended_by: _previousSuspension, ...base } = member;
    const suspendedBy = next.active
      ? undefined
      : current.active
        ? `scim:${principal.token_id}`
        : member.suspended_by;
    saved = writeMemberProfile(
      {
        ...base,
        status: next.active ? 'active' : 'suspended',
        ...(suspendedBy ? { suspended_by: suspendedBy } : {}),
        display_name: displayName,
        ...(identities ? { external_identities: identities } : {}),
        updated_at: now,
      },
      options
    );
  }
  const record: ScimUserRecord = {
    member_id: member.member_id,
    tenant_slug: principal.tenant_slug,
    user_name: next.userName,
    ...(next.name ? { name: next.name } : {}),
    ...(next.emails ? { emails: next.emails } : {}),
    created_at: entry.record?.created_at ?? now,
    updated_at: changes.length || !entry.record ? now : entry.record.updated_at,
  };
  try {
    writeRecord(record, options);
  } catch (error) {
    if (saved !== member) writeMemberProfile(member, options);
    throw error;
  }
  return {
    result: toResource({ member: saved, record }, principal, baseUrl),
    memberId: member.member_id,
    changes,
  };
}

export function replaceScimUser(
  principal: ScimPrincipal,
  id: string,
  body: unknown,
  baseUrl: string,
  options: ScimUsersOptions = {}
): ScimUserResource {
  return withAudit(principal, 'scim.user.replace', id, options, () => {
    const entry = findScimTenantMember(principal, id, options);
    const input = parseScimUserInput(body);
    // An IdP that does not map externalId sends PUT without it: that leaves the
    // binding alone. Only an explicit `externalId` (null / "" unbinds) changes it.
    const explicit = Object.prototype.hasOwnProperty.call(body as object, 'externalId');
    const externalId = explicit ? input.externalId : scimAttributesOf(entry, principal).externalId;
    const { externalId: _given, ...rest } = input;
    const next: ScimUserAttributes = { ...rest, ...(externalId ? { externalId } : {}) };
    return commitUser(principal, entry, next, baseUrl, options);
  });
}

export function patchScimUser(
  principal: ScimPrincipal,
  id: string,
  body: unknown,
  baseUrl: string,
  options: ScimUsersOptions = {}
): ScimUserResource {
  return withAudit(principal, 'scim.user.patch', id, options, () => {
    const entry = findScimTenantMember(principal, id, options);
    const next = applyScimPatch(scimAttributesOf(entry, principal), body);
    return commitUser(principal, entry, next, baseUrl, options);
  });
}

/** DELETE: deactivate (suspend) — Kyberion never hard-deletes a member. */
export function deactivateScimUser(
  principal: ScimPrincipal,
  id: string,
  baseUrl: string,
  options: ScimUsersOptions = {}
): void {
  withAudit(principal, 'scim.user.deactivate', id, options, () => {
    const entry = findScimTenantMember(principal, id, options);
    const next = { ...scimAttributesOf(entry, principal), active: false };
    return commitUser(principal, entry, next, baseUrl, options);
  });
}
