import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeChmodSync, safeExistsSync, safeMkdir, safeRmSync } from '../secure-io.js';
import { externalMemberId } from './member-invite.js';
import {
  findMemberByExternalIdentity,
  readMemberProfile,
  writeMemberProfile,
  type MemberProfile,
} from './member-registry.js';
import { ScimError, SCIM_PATCH_OP_SCHEMA, SCIM_USER_SCHEMA } from './scim-protocol.js';
import {
  issueScimToken,
  type ScimAuditEvent,
  type ScimPrincipal,
  type ScimProvisionedRole,
} from './scim-token-registry.js';
import {
  createScimUser,
  deactivateScimUser,
  getScimUser,
  listScimUsers,
  patchScimUser,
  replaceScimUser,
} from './scim-users.js';

const NOW = new Date('2026-10-10T09:00:00.000Z');
const ISSUER = 'https://idp.example.com';
const BASE = 'https://concierge.example.com/scim/v2';

const profile = (memberId: string, memberships: MemberProfile['memberships']): MemberProfile => ({
  member_id: memberId,
  display_name: memberId,
  status: 'active',
  memberships,
  access_registrations: [],
  created_at: NOW.toISOString(),
  updated_at: NOW.toISOString(),
});
const userBody = (userName: string, over: Record<string, unknown> = {}) => ({
  schemas: [SCIM_USER_SCHEMA],
  userName,
  name: { givenName: 'Given', familyName: userName.split('@')[0] },
  emails: [{ value: userName, type: 'work', primary: true }],
  active: true,
  ...over,
});
const patch = (...Operations: unknown[]) => ({ schemas: [SCIM_PATCH_OP_SCHEMA], Operations });

describe('scim users', () => {
  let root = '';
  let savedPersona: string | undefined;
  let savedRole: string | undefined;
  let audit: ScimAuditEvent[] = [];
  let ACME: ScimPrincipal;
  let BETA: ScimPrincipal;
  let SOLO: ScimPrincipal;
  // A real token of the tenant: SCIM reactivates only members one of them suspended.
  const issue = (
    tenant: string,
    issuedBy: string,
    defaultRole: ScimProvisionedRole = 'viewer'
  ): ScimPrincipal => {
    const { record } = issueScimToken(
      { tenantSlug: tenant, label: 'IdP', issuer: ISSUER, defaultRole, issuedByMemberId: issuedBy },
      { rootDir: root, audit: () => undefined }
    );
    return {
      token_id: record.token_id,
      tenant_slug: tenant,
      issuer: record.issuer,
      default_role: record.default_role,
    };
  };
  const opts = () => ({
    rootDir: root,
    now: NOW,
    audit: (event: ScimAuditEvent) => audit.push(event),
  });
  const reg = () => ({ rootDir: root });
  const scimFailure = (fn: () => unknown, status: number, scimType?: string) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ScimError);
      expect((error as ScimError).status).toBe(status);
      if (scimType) expect((error as ScimError).scimType).toBe(scimType);
      return;
    }
    throw new Error(`expected ScimError(${status})`);
  };

  beforeAll(() => {
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `scim-users-${randomUUID()}`
    );
    savedPersona = process.env.KYBERION_PERSONA;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_PERSONA = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    writeMemberProfile(
      profile('owner', [
        { tenant_slug: 'acme', role: 'owner' },
        { tenant_slug: 'beta', role: 'owner' },
      ]),
      reg()
    );
    writeMemberProfile(profile('bob', [{ tenant_slug: 'beta', role: 'operator' }]), reg());
    writeMemberProfile(
      profile('carol', [
        { tenant_slug: 'acme', role: 'viewer' },
        { tenant_slug: 'beta', role: 'viewer' },
      ]),
      reg()
    );
    writeMemberProfile(profile('sam', [{ tenant_slug: 'solo', role: 'owner' }]), reg());
    ACME = issue('acme', 'owner');
    BETA = issue('beta', 'owner');
    SOLO = issue('solo', 'sam');
  });
  afterAll(() => {
    if (savedPersona === undefined) delete process.env.KYBERION_PERSONA;
    else process.env.KYBERION_PERSONA = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
    if (root) safeRmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    audit = [];
  });

  it('creates a member with the lowest role, binds externalId under the token issuer, audits', () => {
    const user = createScimUser(
      ACME,
      userBody('alice@acme.test', { externalId: 'oid-alice' }),
      BASE,
      opts()
    );
    const memberId = externalMemberId(ISSUER, 'oid-alice');
    expect(user).toMatchObject({
      schemas: [SCIM_USER_SCHEMA],
      id: memberId,
      externalId: 'oid-alice',
      userName: 'alice@acme.test',
      displayName: 'Given alice',
      active: true,
      meta: { resourceType: 'User', location: `${BASE}/Users/${memberId}` },
    });
    const member = readMemberProfile(memberId, reg())!;
    expect(member.memberships).toEqual([{ tenant_slug: 'acme', role: 'viewer' }]);
    expect(member.external_identities).toEqual([
      {
        issuer: ISSUER,
        subject: 'oid-alice',
        email: 'alice@acme.test',
        provisioned_by: `scim:${ACME.token_id}`,
      },
    ]);
    // Login through the IdP now resolves to this member.
    expect(findMemberByExternalIdentity(ISSUER, 'oid-alice', reg())?.member_id).toBe(memberId);
    // SCIM-only attributes are tenant data, under the tenant's confidential floor.
    expect(
      safeExistsSync(
        path.join(root, 'knowledge', 'confidential', 'acme', 'scim', 'users', `${memberId}.json`)
      )
    ).toBe(true);
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'scim.user.create',
        result: 'completed',
        tenantSlug: 'acme',
        tokenId: ACME.token_id,
        memberId,
      }),
    ]);
  });

  it('uses the token default role but ignores any role the IdP sends', () => {
    const operatorToken = issue('acme', 'owner', 'operator');
    const user = createScimUser(
      operatorToken,
      userBody('olga@acme.test', { roles: [{ value: 'owner', primary: true }] }),
      BASE,
      opts()
    );
    expect(readMemberProfile(user.id, reg())!.memberships).toEqual([
      { tenant_slug: 'acme', role: 'operator' },
    ]);
    replaceScimUser(
      operatorToken,
      user.id,
      userBody('olga@acme.test', { roles: [{ value: 'owner' }] }),
      BASE,
      opts()
    );
    expect(readMemberProfile(user.id, reg())!.memberships).toEqual([
      { tenant_slug: 'acme', role: 'operator' },
    ]);
  });

  it('enforces userName and externalId uniqueness without touching other tenants', () => {
    createScimUser(ACME, userBody('dup@acme.test', { externalId: 'oid-dup' }), BASE, opts());
    scimFailure(
      () => createScimUser(ACME, userBody('DUP@acme.test'), BASE, opts()),
      409,
      'uniqueness'
    );
    scimFailure(
      () =>
        createScimUser(ACME, userBody('other@acme.test', { externalId: 'oid-dup' }), BASE, opts()),
      409,
      'uniqueness'
    );
    expect(audit.at(-1)).toMatchObject({ action: 'scim.user.create', result: 'denied' });
    // An identity already bound to another organization's member is not adopted.
    const bobBefore = readMemberProfile('bob', reg());
    writeMemberProfile(
      { ...bobBefore!, external_identities: [{ issuer: ISSUER, subject: 'oid-bob' }] },
      reg()
    );
    scimFailure(
      () =>
        createScimUser(ACME, userBody('bob@acme.test', { externalId: 'oid-bob' }), BASE, opts()),
      409,
      'uniqueness'
    );
    expect(readMemberProfile('bob', reg())!.memberships).toEqual([
      { tenant_slug: 'beta', role: 'operator' },
    ]);
  });

  it('lists only the token tenant, with filters and paging', () => {
    const all = listScimUsers(ACME, {}, BASE, opts());
    const ids = all.Resources.map((user) => user.id);
    expect(ids).toContain('owner');
    expect(ids).toContain('carol');
    expect(ids).not.toContain('bob');
    expect(ids).not.toContain('sam');
    expect(all.totalResults).toBe(all.Resources.length);

    const byName = listScimUsers(ACME, { filter: 'userName eq "ALICE@acme.test"' }, BASE, opts());
    expect(byName.totalResults).toBe(1);
    expect(byName.Resources[0].externalId).toBe('oid-alice');
    const byExternal = listScimUsers(ACME, { filter: 'externalId eq "oid-alice"' }, BASE, opts());
    expect(byExternal.Resources[0].userName).toBe('alice@acme.test');
    // Beta's SCIM client cannot find acme's user even by exact filter.
    expect(
      listScimUsers(BETA, { filter: 'externalId eq "oid-alice"' }, BASE, opts()).totalResults
    ).toBe(0);

    const page = listScimUsers(ACME, { startIndex: '2', count: '1' }, BASE, opts());
    expect(page).toMatchObject({ startIndex: 2, itemsPerPage: 1, totalResults: all.totalResults });
    expect(page.Resources[0].id).toBe(ids[1]);
    expect(listScimUsers(ACME, { count: '0' }, BASE, opts()).Resources).toEqual([]);
  });

  it('isolates tenants: another tenant reads and writes nothing (404, unchanged)', () => {
    const aliceId = externalMemberId(ISSUER, 'oid-alice');
    scimFailure(() => getScimUser(BETA, aliceId, BASE, opts()), 404);
    scimFailure(
      () =>
        patchScimUser(
          BETA,
          aliceId,
          patch({ op: 'replace', path: 'active', value: false }),
          BASE,
          opts()
        ),
      404
    );
    scimFailure(() => deactivateScimUser(BETA, aliceId, BASE, opts()), 404);
    scimFailure(() => replaceScimUser(BETA, aliceId, userBody('x@beta.test'), BASE, opts()), 404);
    scimFailure(() => getScimUser(ACME, 'bob', BASE, opts()), 404);
    scimFailure(() => getScimUser(ACME, '../owner', BASE, opts()), 404);
    expect(readMemberProfile(aliceId, reg())!.status).toBe('active');
  });

  it('PATCH active:false suspends (login stops resolving); active:true restores', () => {
    const aliceId = externalMemberId(ISSUER, 'oid-alice');
    const off = patchScimUser(
      ACME,
      aliceId,
      patch({ op: 'Replace', path: 'active', value: 'False' }),
      BASE,
      opts()
    );
    expect(off.active).toBe(false);
    expect(readMemberProfile(aliceId, reg())!.status).toBe('suspended');
    expect(findMemberByExternalIdentity(ISSUER, 'oid-alice', reg())).toBeNull();
    expect(audit.at(-1)).toMatchObject({
      action: 'scim.user.patch',
      memberId: aliceId,
      metadata: { changes: ['active'] },
    });
    patchScimUser(ACME, aliceId, patch({ op: 'replace', value: { active: true } }), BASE, opts());
    expect(findMemberByExternalIdentity(ISSUER, 'oid-alice', reg())?.member_id).toBe(aliceId);
  });

  it('PUT replaces attributes and rebinds a changed externalId', () => {
    const aliceId = externalMemberId(ISSUER, 'oid-alice');
    const replaced = replaceScimUser(
      ACME,
      aliceId,
      userBody('alice.new@acme.test', { externalId: 'oid-alice-2', displayName: 'Alice New' }),
      BASE,
      opts()
    );
    expect(replaced).toMatchObject({
      id: aliceId,
      userName: 'alice.new@acme.test',
      externalId: 'oid-alice-2',
      displayName: 'Alice New',
    });
    expect(findMemberByExternalIdentity(ISSUER, 'oid-alice', reg())).toBeNull();
    expect(findMemberByExternalIdentity(ISSUER, 'oid-alice-2', reg())?.member_id).toBe(aliceId);
  });

  it('DELETE deactivates and never removes the member', () => {
    const user = createScimUser(
      ACME,
      userBody('leaver@acme.test', { externalId: 'oid-leaver' }),
      BASE,
      opts()
    );
    deactivateScimUser(ACME, user.id, BASE, opts());
    const member = readMemberProfile(user.id, reg());
    expect(member?.status).toBe('suspended');
    expect(member?.memberships).toEqual([{ tenant_slug: 'acme', role: 'viewer' }]);
    expect(getScimUser(ACME, user.id, BASE, opts()).active).toBe(false);
    expect(audit.at(-1)).toMatchObject({ action: 'scim.user.deactivate', result: 'completed' });
  });

  it('never changes or suspends an owner, last or not', () => {
    writeMemberProfile(profile('sue', [{ tenant_slug: 'solo', role: 'owner' }]), reg());
    const approverToken = issue('solo', 'sam', 'approver');
    for (const token of [SOLO, approverToken]) {
      scimFailure(() => deactivateScimUser(token, 'sue', BASE, opts()), 403);
      scimFailure(
        () =>
          patchScimUser(
            token,
            'sue',
            patch({ op: 'replace', path: 'active', value: false }),
            BASE,
            opts()
          ),
        403
      );
      scimFailure(
        () =>
          patchScimUser(
            token,
            'sue',
            patch({ op: 'add', path: 'externalId', value: 'oid-attacker' }),
            BASE,
            opts()
          ),
        403
      );
      scimFailure(
        () =>
          replaceScimUser(
            token,
            'sue',
            userBody('sue@solo.test', { externalId: 'oid-attacker' }),
            BASE,
            opts()
          ),
        403
      );
    }
    const sue = readMemberProfile('sue', reg())!;
    expect(sue.status).toBe('active');
    expect(sue.external_identities ?? []).toEqual([]);
    expect(findMemberByExternalIdentity(ISSUER, 'oid-attacker', reg())).toBeNull();
    expect(audit.at(-1)).toMatchObject({ result: 'denied', memberId: 'sue' });
    // Reading an owner is fine; an unchanged PUT is a no-op, not a write.
    expect(getScimUser(SOLO, 'sue', BASE, opts()).id).toBe('sue');
    replaceScimUser(
      SOLO,
      'sue',
      userBody('sue', { name: undefined, emails: undefined }),
      BASE,
      opts()
    );
    expect(
      safeExistsSync(
        path.join(root, 'knowledge', 'confidential', 'solo', 'scim', 'users', 'sue.json')
      )
    ).toBe(false);
  });

  it('changes only members ranked at most the token default role', () => {
    writeMemberProfile(profile('abe', [{ tenant_slug: 'solo', role: 'approver' }]), reg());
    writeMemberProfile(profile('opa', [{ tenant_slug: 'solo', role: 'operator' }]), reg());
    const operatorToken = issue('solo', 'sam', 'operator');
    const approverToken = issue('solo', 'sam', 'approver');
    const bindAbe = (token: ScimPrincipal) =>
      patchScimUser(
        token,
        'abe',
        patch({ op: 'add', path: 'externalId', value: 'oid-abe' }),
        BASE,
        opts()
      );
    scimFailure(() => bindAbe(SOLO), 403);
    scimFailure(() => bindAbe(operatorToken), 403);
    scimFailure(() => deactivateScimUser(SOLO, 'opa', BASE, opts()), 403);
    expect(readMemberProfile('abe', reg())!.external_identities ?? []).toEqual([]);
    expect(readMemberProfile('opa', reg())!.status).toBe('active');

    expect(bindAbe(approverToken).externalId).toBe('oid-abe');
    deactivateScimUser(operatorToken, 'opa', BASE, opts());
    expect(readMemberProfile('opa', reg())!.status).toBe('suspended');
  });

  it('never replaces or removes an external identity SCIM did not bind', () => {
    writeMemberProfile(
      {
        ...profile('vic', [{ tenant_slug: 'solo', role: 'viewer' }]),
        external_identities: [
          { issuer: ISSUER, subject: 'oid-vic-owner-linked' },
          { issuer: 'https://slack.com', subject: 'U-vic' },
        ],
      },
      reg()
    );
    scimFailure(
      () =>
        patchScimUser(
          SOLO,
          'vic',
          patch({ op: 'replace', path: 'externalId', value: 'oid-other' }),
          BASE,
          opts()
        ),
      403
    );
    scimFailure(
      () => patchScimUser(SOLO, 'vic', patch({ op: 'remove', path: 'externalId' }), BASE, opts()),
      403
    );
    scimFailure(
      () =>
        replaceScimUser(SOLO, 'vic', userBody('vic@solo.test', { externalId: null }), BASE, opts()),
      403
    );
    // A PUT without externalId leaves the binding alone and updates the rest.
    expect(replaceScimUser(SOLO, 'vic', userBody('vic@solo.test'), BASE, opts())).toMatchObject({
      userName: 'vic@solo.test',
      externalId: 'oid-vic-owner-linked',
    });
    expect(readMemberProfile('vic', reg())!.external_identities).toEqual([
      { issuer: ISSUER, subject: 'oid-vic-owner-linked' },
      { issuer: 'https://slack.com', subject: 'U-vic' },
    ]);
  });

  it('binds externalId only on members with no identity and no token, or SCIM-bound ones', () => {
    const bind = (id: string, value: string, token: ScimPrincipal = SOLO) =>
      patchScimUser(token, id, patch({ op: 'add', path: 'externalId', value }), BASE, opts());
    // Owner-linked elsewhere (Slack) or token-linked: refused.
    writeMemberProfile(
      {
        ...profile('wes', [{ tenant_slug: 'solo', role: 'viewer' }]),
        external_identities: [{ issuer: 'https://slack.com', subject: 'U-wes' }],
      },
      reg()
    );
    writeMemberProfile(
      {
        ...profile('tia', [{ tenant_slug: 'solo', role: 'viewer' }]),
        access_registrations: [{ label: 'tia-laptop' }],
      },
      reg()
    );
    scimFailure(() => bind('wes', 'oid-wes'), 403);
    scimFailure(() => bind('tia', 'oid-tia'), 403);
    expect(readMemberProfile('wes', reg())!.external_identities).toEqual([
      { issuer: 'https://slack.com', subject: 'U-wes' },
    ]);
    expect(readMemberProfile('tia', reg())!.external_identities).toBeUndefined();

    // A binding another tenant's SCIM made is not this tenant's to move.
    writeMemberProfile(
      {
        ...profile('ula', [{ tenant_slug: 'solo', role: 'viewer' }]),
        external_identities: [
          { issuer: ISSUER, subject: 'oid-ula', provisioned_by: `scim:${ACME.token_id}` },
        ],
      },
      reg()
    );
    scimFailure(() => bind('ula', 'oid-ula-2'), 403);
    scimFailure(
      () => patchScimUser(SOLO, 'ula', patch({ op: 'remove', path: 'externalId' }), BASE, opts()),
      403
    );

    // No identity, no token: bound, then SCIM may move its own binding (one
    // write, one binding) and remove it with an explicit null.
    writeMemberProfile(profile('val', [{ tenant_slug: 'solo', role: 'viewer' }]), reg());
    bind('val', 'oid-val');
    bind('val', 'oid-val-2');
    expect(readMemberProfile('val', reg())!.external_identities).toEqual([
      { issuer: ISSUER, subject: 'oid-val-2', provisioned_by: `scim:${SOLO.token_id}` },
    ]);
    replaceScimUser(SOLO, 'val', userBody('val@solo.test'), BASE, opts());
    expect(readMemberProfile('val', reg())!.external_identities).toHaveLength(1);
    patchScimUser(
      SOLO,
      'val',
      patch({ op: 'replace', path: 'externalId', value: null }),
      BASE,
      opts()
    );
    expect(readMemberProfile('val', reg())!.external_identities).toEqual([]);
  });

  it('compares issuers through one normaliser but binds the issuer exactly as configured', () => {
    writeMemberProfile(profile('ida', [{ tenant_slug: 'roll', role: 'owner' }]), reg());
    const slashed = { ...issue('roll', 'ida'), issuer: `${ISSUER}/` };
    // The same subject bound under the slash-less spelling is the same identity.
    writeMemberProfile(
      {
        ...profile('ned', [{ tenant_slug: 'beta', role: 'viewer' }]),
        external_identities: [{ issuer: ISSUER, subject: 'oid-ned' }],
      },
      reg()
    );
    scimFailure(
      () =>
        createScimUser(slashed, userBody('ned@roll.test', { externalId: 'oid-ned' }), BASE, opts()),
      409,
      'uniqueness'
    );
    const user = createScimUser(
      slashed,
      userBody('oli@roll.test', { externalId: 'oid-oli' }),
      BASE,
      opts()
    );
    expect(readMemberProfile(user.id, reg())!.external_identities).toEqual([
      expect.objectContaining({ issuer: `${ISSUER}/`, subject: 'oid-oli' }),
    ]);
    // Read back under either spelling of the token issuer.
    expect(getScimUser({ ...slashed, issuer: ISSUER }, user.id, BASE, opts()).externalId).toBe(
      'oid-oli'
    );
    expect(
      listScimUsers(slashed, { filter: 'externalId eq "oid-oli"' }, BASE, opts()).totalResults
    ).toBe(1);
  });

  it('reactivates only members SCIM suspended, never an owner-suspended one', () => {
    writeMemberProfile(
      { ...profile('kim', [{ tenant_slug: 'solo', role: 'viewer' }]), status: 'suspended' },
      reg()
    );
    scimFailure(
      () =>
        patchScimUser(
          SOLO,
          'kim',
          patch({ op: 'replace', path: 'active', value: true }),
          BASE,
          opts()
        ),
      403
    );
    scimFailure(
      () => replaceScimUser(SOLO, 'kim', userBody('kim@solo.test', { active: true }), BASE, opts()),
      403
    );
    expect(readMemberProfile('kim', reg())!.status).toBe('suspended');

    writeMemberProfile(profile('lou', [{ tenant_slug: 'solo', role: 'viewer' }]), reg());
    deactivateScimUser(SOLO, 'lou', BASE, opts());
    expect(readMemberProfile('lou', reg())!.suspended_by).toBe(`scim:${SOLO.token_id}`);
    // Another tenant's SCIM token id is not this tenant's provenance.
    const lou = readMemberProfile('lou', reg())!;
    writeMemberProfile({ ...lou, suspended_by: `scim:${ACME.token_id}` }, reg());
    scimFailure(
      () =>
        patchScimUser(SOLO, 'lou', patch({ op: 'replace', value: { active: true } }), BASE, opts()),
      403
    );
    writeMemberProfile(lou, reg());
    patchScimUser(SOLO, 'lou', patch({ op: 'replace', value: { active: true } }), BASE, opts());
    const reactivated = readMemberProfile('lou', reg())!;
    expect(reactivated.status).toBe('active');
    expect(reactivated.suspended_by).toBeUndefined();

    // An owner who reactivates and suspends again takes over the decision.
    deactivateScimUser(SOLO, 'lou', BASE, opts());
    writeMemberProfile({ ...readMemberProfile('lou', reg())!, status: 'active' }, reg());
    expect(readMemberProfile('lou', reg())!.suspended_by).toBeUndefined();
    writeMemberProfile({ ...readMemberProfile('lou', reg())!, status: 'suspended' }, reg());
    scimFailure(
      () =>
        patchScimUser(SOLO, 'lou', patch({ op: 'replace', value: { active: true } }), BASE, opts()),
      403
    );
  });

  // root ignores directory permissions, so the injected write failure needs a non-root user.
  it.skipIf(process.getuid?.() === 0)(
    'restores the member profile when the tenant-side record cannot be written',
    () => {
      writeMemberProfile(profile('rod', [{ tenant_slug: 'roll', role: 'owner' }]), reg());
      const roll = issue('roll', 'rod');
      writeMemberProfile(
        {
          ...profile('rita', [{ tenant_slug: 'roll', role: 'viewer' }]),
          external_identities: [
            { issuer: ISSUER, subject: 'oid-rita', provisioned_by: `scim:${roll.token_id}` },
          ],
        },
        reg()
      );
      // The tenant's SCIM users directory is read-only, so only the record write fails.
      const usersDir = path.join(root, 'knowledge', 'confidential', 'roll', 'scim', 'users');
      safeMkdir(usersDir, { recursive: true });
      safeChmodSync(usersDir, 0o555);
      const before = readMemberProfile('rita', reg());
      try {
        expect(() =>
          patchScimUser(
            roll,
            'rita',
            patch({ op: 'replace', path: 'externalId', value: 'oid-rita-2' }),
            BASE,
            opts()
          )
        ).toThrow(/EACCES|EPERM/);
      } finally {
        safeChmodSync(usersDir, 0o755);
      }
      expect(readMemberProfile('rita', reg())).toEqual(before);
      expect(findMemberByExternalIdentity(ISSUER, 'oid-rita-2', reg())).toBeNull();
      expect(audit.at(-1)).toMatchObject({ action: 'scim.user.patch', result: 'error' });
    }
  );

  it('a member shared with another organization: tenant attributes yes, global ones no', () => {
    const named = patchScimUser(
      ACME,
      'carol',
      patch(
        { op: 'add', path: 'name', value: { givenName: 'Carol', familyName: 'C' } },
        { op: 'replace', path: 'userName', value: 'carol@acme.test' }
      ),
      BASE,
      opts()
    );
    expect(named.userName).toBe('carol@acme.test');
    // The global display name is untouched; a change to it would be refused.
    expect(readMemberProfile('carol', reg())!.display_name).toBe('carol');
    scimFailure(
      () =>
        patchScimUser(
          ACME,
          'carol',
          patch({ op: 'replace', path: 'displayName', value: 'C' }),
          BASE,
          opts()
        ),
      403
    );

    scimFailure(
      () =>
        patchScimUser(
          ACME,
          'carol',
          patch({ op: 'replace', path: 'active', value: false }),
          BASE,
          opts()
        ),
      403
    );
    scimFailure(() => deactivateScimUser(ACME, 'carol', BASE, opts()), 403);
    scimFailure(
      () =>
        patchScimUser(
          ACME,
          'carol',
          patch({ op: 'add', path: 'externalId', value: 'oid-carol' }),
          BASE,
          opts()
        ),
      403
    );
    const carol = readMemberProfile('carol', reg())!;
    expect(carol.status).toBe('active');
    expect(carol.external_identities ?? []).toEqual([]);
  });
});
