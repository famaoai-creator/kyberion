/** Shared human member operations for the CLI and Concierge. */
import { withExecutionContextAsync } from '../authority.js';
import { nowIso } from '../foundation/time.js';
import { safeExistsSync, safeReaddir } from '../secure-io.js';
import { digest, fail } from '../surface/surface-management-contract.js';
import { assertProjectLifecycleOwner } from '../project/project-lifecycle-guards.js';
import { isValidTenantSlug } from '../entity-scope.js';
import { sameScimIssuer } from './scim-token-registry.js';
import { trimTrailingSlashes } from '../surface/surface-session-cookie.js';
import { issueChronosAccessToken } from '../chronos-access-registry.js';
import { frontDeskRoleAuthority } from '../front-desk-roles.js';
import {
  isValidMemberId,
  memberProfileDir,
  memberProfilePath,
  readMemberProfile,
  writeMemberProfile,
  type MemberExternalIdentity,
  type MemberProfile,
  type MemberRole,
} from './member-registry.js';
import {
  withOrganizationPeopleMutation,
  withPeopleResources,
  recordPeopleManagementAudit,
} from './organization-people-access.js';
import type { OrganizationPeopleAuthorization } from './organization-people-access.js';

export interface MemberManagementPrincipal {
  memberId: string;
  allowedTenantSlugs: readonly string[] | 'all';
  expiresAt?: string;
}
export interface CreateManagedMemberInput {
  memberId: string;
  displayName: string;
  tenantSlug: string;
  role: MemberRole;
  issueToken?: boolean;
}
export interface UpdateManagedMemberInput {
  memberId: string;
  displayName?: string;
  tenantSlug?: string;
  role?: MemberRole;
  removeTenantSlug?: string;
  status?: 'active' | 'suspended';
  externalIdentity?: MemberExternalIdentity;
  removeExternalIdentity?: MemberExternalIdentity;
  expectedVersion?: string;
}
const ROLES: readonly string[] = ['owner', 'approver', 'operator', 'viewer'];

function validatePrincipal(principal: MemberManagementPrincipal): void {
  if (
    !principal ||
    !isValidMemberId(principal.memberId) ||
    (principal.allowedTenantSlugs !== 'all' &&
      (!Array.isArray(principal.allowedTenantSlugs) ||
        principal.allowedTenantSlugs.some((tenant) => !isValidTenantSlug(tenant))))
  )
    fail('forbidden', 403, 'A registered member and verified tenant scope are required.');
  if (
    principal.expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(principal.expiresAt)) ||
      Date.parse(principal.expiresAt) <= Date.now())
  )
    fail('expired', 403, 'The authenticated principal has expired.');
}
function ioAuth(
  principal: MemberManagementPrincipal,
  tenantSlug: string
): OrganizationPeopleAuthorization {
  return {
    memberId: principal.memberId,
    actorId: 'user:' + principal.memberId,
    tenantSlug,
    allowedOrganizationIds: 'all',
    allowedProjectIds: 'all',
    ...(principal.expiresAt ? { expiresAt: principal.expiresAt } : {}),
  };
}
async function profileIds(auth: OrganizationPeopleAuthorization): Promise<string[]> {
  const dir = memberProfileDir();
  return withPeopleResources(auth, { reads: [dir], role: 'sovereign_concierge' }, () =>
    safeExistsSync(dir)
      ? safeReaddir(dir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -5))
          .filter((id) => isValidMemberId(id) && !id.startsWith('ext-'))
      : []
  );
}
async function registry(auth: OrganizationPeopleAuthorization): Promise<MemberProfile[]> {
  const ids = await profileIds(auth);
  return withPeopleResources(
    auth,
    { reads: ids.map((id) => memberProfilePath(id)), role: 'sovereign_concierge' },
    () =>
      ids.map((id) => {
        const member = readMemberProfile(id);
        if (!member)
          fail(
            'invalid_state',
            409,
            'Member registry changed while checking ownership. Refresh before retrying.'
          );
        return member;
      })
  );
}
function requireOwner(
  principal: MemberManagementPrincipal,
  profiles: MemberProfile[],
  tenants: string[]
): MemberProfile {
  validatePrincipal(principal);
  const owner = profiles.find((profile) => profile.member_id === principal.memberId);
  if (!owner || owner.status !== 'active')
    fail('forbidden', 403, 'An active registered owner is required.');
  if (!tenants.length) fail('forbidden', 403, 'A tenant scope is required for member management.');
  for (const tenant of tenants) {
    if (
      !isValidTenantSlug(tenant) ||
      (principal.allowedTenantSlugs !== 'all' && !principal.allowedTenantSlugs.includes(tenant)) ||
      !owner.memberships.some((m) => m.tenant_slug === tenant && m.role === 'owner')
    )
      fail(
        'forbidden',
        403,
        'An owner membership is required on every tenant affected by this change.'
      );
  }
  return owner;
}
function name(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail('invalid_name', 400, 'A display name of 1–200 characters is required.');
  return value.trim();
}
function identity(value: MemberExternalIdentity): MemberExternalIdentity {
  if (!value || typeof value.issuer !== 'string' || typeof value.subject !== 'string')
    fail('invalid_identity', 400, 'Issuer and subject are required.');
  const issuer = trimTrailingSlashes(value.issuer.trim());
  const subject = value.subject.trim();
  if (value.email !== undefined && typeof value.email !== 'string')
    fail('invalid_identity', 400, 'External identity email must be text.');
  if (
    !issuer ||
    !subject ||
    issuer.length > 512 ||
    subject.length > 512 ||
    /[\u0000-\u001f\u007f\s]/.test(issuer) ||
    /[\u0000-\u001f\u007f]/.test(subject)
  )
    fail('invalid_identity', 400, 'External identity is invalid.');
  return {
    issuer,
    subject,
    ...(value.email?.trim() ? { email: value.email.trim().slice(0, 320) } : {}),
  };
}
function guardOwners(
  principal: MemberManagementPrincipal,
  profiles: MemberProfile[],
  before: MemberProfile,
  after: MemberProfile
): void {
  const lost = before.memberships.filter(
    (m) =>
      m.role === 'owner' &&
      (after.status !== 'active' ||
        !after.memberships.some(
          (next) => next.tenant_slug === m.tenant_slug && next.role === 'owner'
        ))
  );
  if (before.member_id === principal.memberId && (after.status !== 'active' || lost.length))
    fail('self_lockout', 409, 'You cannot suspend yourself or remove your own owner access.');
  for (const membership of lost)
    if (
      !profiles.some(
        (other) =>
          other.member_id !== before.member_id &&
          other.status === 'active' &&
          other.memberships.some(
            (m) => m.tenant_slug === membership.tenant_slug && m.role === 'owner'
          )
      )
    )
      fail(
        'last_owner',
        409,
        'Each tenant must retain an active owner. Assign another owner first.'
      );
}

export function managedMemberVersion(member: MemberProfile): string {
  return digest(member);
}

export async function listManagedMembers(
  principal: MemberManagementPrincipal,
  tenantSlug: string
): Promise<Array<MemberProfile & { version: string; is_local_owner: boolean }>> {
  validatePrincipal(principal);
  if (!isValidTenantSlug(tenantSlug)) fail('invalid_tenant', 400, 'A valid tenant is required.');
  const auth = ioAuth(principal, tenantSlug);
  const profiles = await registry(auth);
  requireOwner(principal, profiles, [tenantSlug]);
  return profiles
    .filter((member) => member.memberships.some((m) => m.tenant_slug === tenantSlug))
    .map((member) => ({
      ...member,
      version: managedMemberVersion(member),
      is_local_owner: member.member_id === 'owner',
      memberships: member.memberships.filter((m) => m.tenant_slug === tenantSlug),
      external_identities: undefined,
      access_registrations: [],
    }));
}

export async function createManagedMember(
  principal: MemberManagementPrincipal,
  input: CreateManagedMemberInput
): Promise<{ member: MemberProfile; token?: string }> {
  assertProjectLifecycleOwner();
  validatePrincipal(principal);
  if (
    !isValidMemberId(input.memberId) ||
    input.memberId.startsWith('ext-') ||
    !isValidTenantSlug(input.tenantSlug) ||
    !ROLES.includes(input.role)
  )
    fail('invalid_member', 400, 'A valid member, tenant and access role are required.');
  const displayName = name(input.displayName);
  const auth = ioAuth(principal, input.tenantSlug);
  return withOrganizationPeopleMutation(async () => {
    const profiles = await registry(auth);
    requireOwner(principal, profiles, [input.tenantSlug]);
    if (profiles.some((member) => member.member_id === input.memberId))
      fail('conflict', 409, 'Member already exists.');
    const now = nowIso();
    let member: MemberProfile = {
      member_id: input.memberId,
      display_name: displayName,
      status: 'active',
      memberships: [{ tenant_slug: input.tenantSlug, role: input.role }],
      access_registrations: [],
      created_at: now,
      updated_at: now,
    };
    await recordPeopleManagementAudit(auth, 'member.create.requested', 'user:' + input.memberId, {
      tenant_slug: input.tenantSlug,
      role: input.role,
    });
    // Token creation stays on the existing secret-guard facade; raw bytes are returned once.
    let token: string | undefined;
    if (input.issueToken) {
      const issued = await withExecutionContextAsync('sovereign_concierge', () =>
        issueChronosAccessToken({
          role: frontDeskRoleAuthority(input.role).serverRole,
          tenantSlugs: [input.tenantSlug],
          label: `${input.memberId}-token`,
          memberId: input.memberId,
        })
      );
      token = issued.token;
      member = { ...member, access_registrations: [{ label: issued.registration.label! }] };
    }
    const file = memberProfilePath(member.member_id);
    const written = await withPeopleResources(
      auth,
      {
        reads: [
          memberProfileDir(),
          ...profiles.map((profile) => memberProfilePath(profile.member_id)),
        ],
        writes: [file],
        role: 'sovereign_concierge',
      },
      () => writeMemberProfile(member)
    );
    await recordPeopleManagementAudit(auth, 'member.create', 'user:' + input.memberId, {
      tenant_slug: input.tenantSlug,
      role: input.role,
    });
    return { member: written, ...(token ? { token } : {}) };
  });
}

export async function updateManagedMember(
  principal: MemberManagementPrincipal,
  input: UpdateManagedMemberInput
): Promise<MemberProfile> {
  assertProjectLifecycleOwner();
  validatePrincipal(principal);
  if (!isValidMemberId(input.memberId)) fail('invalid_member', 400, 'A valid member is required.');
  if (
    (input.tenantSlug === undefined) !== (input.role === undefined) ||
    (input.role !== undefined && !ROLES.includes(input.role)) ||
    (input.tenantSlug !== undefined && !isValidTenantSlug(input.tenantSlug)) ||
    (input.removeTenantSlug !== undefined && !isValidTenantSlug(input.removeTenantSlug)) ||
    (input.status !== undefined && !['active', 'suspended'].includes(input.status))
  )
    fail('invalid_member', 400, 'Invalid tenant, role or status change.');
  if (input.tenantSlug !== undefined && input.removeTenantSlug !== undefined)
    fail('invalid_member', 400, 'Grant and remove membership in separate changes.');
  const add = input.externalIdentity ? identity(input.externalIdentity) : undefined;
  const remove = input.removeExternalIdentity ? identity(input.removeExternalIdentity) : undefined;
  if (
    (add || remove) &&
    (Boolean(add) === Boolean(remove) ||
      input.tenantSlug !== undefined ||
      input.removeTenantSlug !== undefined ||
      input.status !== undefined ||
      input.displayName !== undefined)
  )
    fail(
      'invalid_member',
      400,
      'Change an external identity separately from membership, name and status.'
    );
  if (
    input.tenantSlug === undefined &&
    input.removeTenantSlug === undefined &&
    input.status === undefined &&
    input.displayName === undefined &&
    !add &&
    !remove
  )
    fail('invalid_member', 400, 'Choose a member change.');
  // The source tenant is a verified selector. Global edits verify every membership below.
  const selected =
    input.tenantSlug ??
    input.removeTenantSlug ??
    (principal.allowedTenantSlugs === 'all' ? undefined : principal.allowedTenantSlugs[0]);
  const first =
    selected ??
    (await withExecutionContextAsync(
      'sovereign_concierge',
      () =>
        readMemberProfile(principal.memberId)?.memberships.find((m) => m.role === 'owner')
          ?.tenant_slug
    ));
  if (!first || !isValidTenantSlug(first))
    fail('forbidden', 403, 'Select a tenant where you are an owner.');
  const auth = ioAuth(principal, first);
  return withOrganizationPeopleMutation(async () => {
    const profiles = await registry(auth);
    const before = profiles.find((member) => member.member_id === input.memberId);
    if (!before) fail('not_found', 404, 'Member not found.');
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== managedMemberVersion(before)
    )
      fail('conflict', 409, 'The member changed. Refresh before retrying.');
    const global =
      input.status !== undefined || input.displayName !== undefined || Boolean(add || remove);
    const touched = [
      ...new Set([
        ...(global ? before.memberships.map((m) => m.tenant_slug) : []),
        ...(input.tenantSlug ? [input.tenantSlug] : []),
        ...(input.removeTenantSlug ? [input.removeTenantSlug] : []),
      ]),
    ];
    requireOwner(principal, profiles, touched.length ? touched : [first]);
    let memberships = before.memberships;
    if (input.tenantSlug && input.role)
      memberships = memberships.some((m) => m.tenant_slug === input.tenantSlug)
        ? memberships.map((m) =>
            m.tenant_slug === input.tenantSlug
              ? { tenant_slug: input.tenantSlug!, role: input.role! }
              : m
          )
        : [...memberships, { tenant_slug: input.tenantSlug, role: input.role }];
    if (input.removeTenantSlug)
      memberships = memberships.filter((m) => m.tenant_slug !== input.removeTenantSlug);
    let external = before.external_identities;
    if (add) {
      const matches = (entry: MemberExternalIdentity) =>
        sameScimIssuer(entry.issuer, add.issuer) && entry.subject === add.subject;
      external = (external ?? []).some(matches)
        ? (external ?? []).map((entry) => {
            if (!matches(entry)) return entry;
            const { provisioned_by: _provenance, ...ownerHeld } = entry;
            return ownerHeld;
          })
        : [...(external ?? []), add];
    }
    if (remove)
      external = (external ?? []).filter(
        (entry) =>
          !(sameScimIssuer(entry.issuer, remove.issuer) && entry.subject === remove.subject)
      );
    const { suspended_by: _scimSuspension, ...ownerDecided } = before;
    const after: MemberProfile = {
      ...(input.status !== undefined ? ownerDecided : before),
      memberships,
      ...(input.displayName !== undefined ? { display_name: name(input.displayName) } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(external !== before.external_identities ? { external_identities: external } : {}),
      updated_at: nowIso(),
    };
    guardOwners(principal, profiles, before, after);
    await recordPeopleManagementAudit(auth, 'member.update.requested', 'user:' + input.memberId, {
      tenant_slugs: touched,
    });
    const file = memberProfilePath(input.memberId);
    const written = await withPeopleResources(
      auth,
      {
        reads: [
          memberProfileDir(),
          ...profiles.map((profile) => memberProfilePath(profile.member_id)),
        ],
        writes: [file],
        role: 'sovereign_concierge',
      },
      () => writeMemberProfile(after)
    );
    await recordPeopleManagementAudit(auth, 'member.update', 'user:' + input.memberId, {
      tenant_slugs: touched,
    });
    return written;
  });
}
