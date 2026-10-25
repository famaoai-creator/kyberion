import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { withExecutionContext as initialContext } from './authority.js';
import { rootDir } from './path-resolver.js';
import * as initialIO from './secure-io.js';

/**
 * The invite store on a fresh root: the ordinary Vitest live-store remap
 * places invite bytes outside the protected root, so only a fixture root
 * exercises the real tier/tenant guard. No confidential persona is set; the
 * only binding is the tenant the store role is assumed for.
 */
const SOURCE_ROOT = rootDir();
const ROOT = path.join(SOURCE_ROOT, 'active/shared/tmp/cd-invite-boundary-' + process.pid);
const TENANT = 'cd-invite-boundary';
const OTHER = 'cd-invite-boundary-other';
const UNREGISTERED = 'cd-invite-boundary-unreg';
const NOW = '2026-10-24T00:00:00.000Z';
const STORE = 'active/shared/runtime/customer-decision-invites';
const savedRoot = process.env.KYBERION_ROOT;
const keys = [
  'KYBERION_PERSONA',
  'MISSION_ROLE',
  'SYSTEM_ROLE',
  'MISSION_ID',
  'KYBERION_TENANT',
  'KYBERION_SUDO',
  'KYBERION_SUDO_SCOPE',
  'KYBERION_AGENT_TIER',
] as const;
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

let invite: typeof import('./customer-decision/invite.js');
let io: typeof import('./secure-io.js');
let authority: typeof import('./authority.js');
let capabilityModule: typeof import('./foundation/customer-decision-invite-capability.js');
let resourceScope: typeof import('./foundation/resource-access-scope.js');

const base = (tenantSlug = TENANT) => ({
  tenantSlug,
  caseId: 'deal-001',
  agendaId: 'agd-abcdefgh',
  participant: { name: 'Taro', role: 'decider' as const, actor_id: 'customer:taro' },
  createdBy: 'user:tester',
  now: NOW,
});
const tenantDir = (tenant: string) => path.join(ROOT, STORE, 'confidential', tenant);

beforeAll(async () => {
  initialContext('ecosystem_architect', () => {
    initialIO.safeWriteFile(path.join(ROOT, 'package.json'), '{"name":"cd-invite-fixture"}');
    const copy = (relative: string): void => {
      for (const name of initialIO.safeReaddir(path.join(SOURCE_ROOT, relative))) {
        const file = path.join(relative, name);
        const source = path.join(SOURCE_ROOT, file);
        const stat = initialIO.safeLstat(source);
        if (stat.isSymbolicLink()) throw new Error('Linked governance fixture');
        if (stat.isDirectory()) copy(file);
        else if (/\.(?:json|yaml)$/u.test(name))
          initialIO.safeWriteFile(path.join(ROOT, file), initialIO.safeReadFile(source));
      }
    };
    copy('knowledge/product/governance');
    copy('knowledge/product/schemas');
    // The production runtime root always exists; structural mkdir starts below it.
    initialIO.safeMkdir(path.join(ROOT, 'active/shared/runtime'), { recursive: true });
  });
  process.env.KYBERION_ROOT = ROOT;
  vi.resetModules();
  io = await import('./secure-io.js');
  authority = await import('./authority.js');
  invite = await import('./customer-decision/invite.js');
  capabilityModule = await import('./foundation/customer-decision-invite-capability.js');
  resourceScope = await import('./foundation/resource-access-scope.js');
  expect((await import('./path-resolver.js')).rootDir()).toBe(ROOT);
}, 120_000);

/** Write (or, with `null`, remove) one tenant registry profile on the fixture root. */
function setProfile(tenant: string, status: string | null): void {
  const file = path.join(ROOT, 'knowledge/personal/tenants', `${tenant}.json`);
  process.env.KYBERION_PERSONA = 'sovereign';
  try {
    if (status === null) io.safeRmSync(file, { force: true });
    else
      io.safeWriteFile(
        file,
        JSON.stringify({
          tenant_slug: tenant,
          display_name: tenant,
          status,
          assigned_role: 'owner',
        })
      );
  } finally {
    delete process.env.KYBERION_PERSONA;
  }
}

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  authority.withExecutionContext('ecosystem_architect', () => {
    for (const tenant of [TENANT, OTHER, UNREGISTERED])
      io.safeRmSync(tenantDir(tenant), { recursive: true, force: true });
  });
  // The invite store writes only for a registered active tenant.
  for (const tenant of [TENANT, OTHER]) setProfile(tenant, 'active');
  setProfile(UNREGISTERED, null);
});

/** A raw write of one invite record as the store role, inside its exact capability. */
function writeAsStore(tenant: string, inviteId: string, content: string): void {
  const relative = `${STORE}/confidential/${tenant}/${inviteId}.json`;
  resourceScope.runInResourceAccessScope(
    capabilityModule.customerDecisionInviteCapability(tenant, relative, true),
    () =>
      authority.withExecutionContext(
        capabilityModule.CUSTOMER_DECISION_INVITE_STORE_ROLE,
        () => io.safeWriteFile(path.join(ROOT, relative), content),
        undefined,
        tenant
      )
  );
}

function readRaw(tenant: string, inviteId: string): Record<string, unknown> {
  return authority.withExecutionContext('ecosystem_architect', () =>
    JSON.parse(
      io.safeReadFile(path.join(tenantDir(tenant), `${inviteId}.json`), {
        encoding: 'utf8',
      }) as string
    )
  );
}

afterAll(() => {
  if (savedRoot === undefined) delete process.env.KYBERION_ROOT;
  else process.env.KYBERION_ROOT = savedRoot;
  initialContext('ecosystem_architect', () =>
    initialIO.safeRmSync(ROOT, { recursive: true, force: true })
  );
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('customer decision invite store on the real tier/tenant guard', () => {
  it('ambient identities without a confidential persona cannot touch the protected store', () => {
    const file = path.join(tenantDir(TENANT), 'inv-0000000000000000.json');
    expect(() => io.safeWriteFile(file, '{}')).toThrow(/Higher tier required|POLICY|SECURITY/u);
    expect(() =>
      authority.withExecutionContext(
        'decision_ledger',
        () => io.safeWriteFile(file, '{}'),
        undefined,
        TENANT
      )
    ).toThrow(/Higher tier required|POLICY|SECURITY/u);
  });

  it('issues, verifies, revokes and lists with no persona in env', () => {
    const { invite: issued, token } = invite.issueInvite(base());
    // The record landed in the real protected partition; the ambient identity cannot read it.
    const file = path.join(tenantDir(TENANT), `${issued.invite_id}.json`);
    expect(io.safeExistsSync(file)).toBe(true);
    expect(() => io.safeReadFile(file, { encoding: 'utf8' })).toThrow(
      /Higher tier required|POLICY|SECURITY/u
    );
    const verified = invite.verifyInviteToken(TENANT, token, { now: NOW, action: 'view' });
    expect(verified.ok).toBe(true);
    if (verified.ok) expect(verified.invite.uses).toEqual([{ at: NOW, action: 'view' }]);
    expect(invite.listInvites(TENANT).map((item) => item.invite_id)).toEqual([issued.invite_id]);
    const revoked = invite.revokeInvite(TENANT, issued.invite_id, { now: NOW, reason: 'done' });
    expect(revoked.revoked_at).toBe(NOW);
    expect(invite.verifyInviteToken(TENANT, token, { now: NOW, action: 'view' })).toEqual({
      ok: false,
      reason: 'revoked',
    });
  });

  it('still refuses a cross-tenant read', () => {
    const { token } = invite.issueInvite(base());
    // The token does not open the invite under another tenant.
    expect(invite.verifyInviteToken(OTHER, token, { now: NOW, action: 'view' })).toEqual({
      ok: false,
      reason: 'unknown',
    });
    expect(invite.listInvites(OTHER)).toEqual([]);
    // A capability can never name another tenant's partition.
    const otherFile = `${STORE}/confidential/${OTHER}/inv-0000000000000000.json`;
    expect(() =>
      capabilityModule.customerDecisionInviteCapability(TENANT, otherFile, false)
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
    // Inside TENANT's capability and role, the other tenant's record stays unreadable.
    const { invite: foreign } = invite.issueInvite(base(OTHER));
    const ownFile = `${STORE}/confidential/${TENANT}/inv-0000000000000000.json`;
    expect(() =>
      resourceScope.runInResourceAccessScope(
        capabilityModule.customerDecisionInviteCapability(TENANT, ownFile, false),
        () =>
          authority.withExecutionContext(
            capabilityModule.CUSTOMER_DECISION_INVITE_STORE_ROLE,
            () =>
              io.safeReadFile(path.join(tenantDir(OTHER), `${foreign.invite_id}.json`), {
                encoding: 'utf8',
              }),
            undefined,
            TENANT
          )
      )
    ).toThrow(/RESOURCE_SCOPE_DENIED|tenant\.scope_violation/u);
  });

  it('a caller bound to another tenant gets unavailable, never unknown', () => {
    const { invite: issued, token } = invite.issueInvite(base());
    process.env.KYBERION_TENANT = OTHER;
    try {
      expect(invite.verifyInviteToken(TENANT, token, { now: NOW, action: 'view' })).toEqual({
        ok: false,
        reason: 'unavailable',
      });
      expect(() => invite.listInvites(TENANT)).toThrow(/ROLE_TENANT_SCOPE_MISMATCH/u);
      expect(() =>
        invite.revokeInvite(TENANT, issued.invite_id, { now: NOW, reason: 'x' })
      ).toThrow(/CD_INVITE_UNAVAILABLE/u);
    } finally {
      delete process.env.KYBERION_TENANT;
    }
  });

  it('refuses an unregistered tenant even when the tier directory already exists', () => {
    // Another tenant's invite created the shared `confidential/` tier directory.
    invite.issueInvite(base(OTHER));
    expect(io.safeExistsSync(path.dirname(tenantDir(UNREGISTERED)))).toBe(true);
    expect(() => invite.issueInvite(base(UNREGISTERED))).toThrow(
      /\[CD_INVITE_TENANT_NOT_REGISTERED\]/u
    );
    expect(io.safeExistsSync(tenantDir(UNREGISTERED))).toBe(false);
    // A profile naming another slug, or any status but active, is not a registration.
    setProfile(UNREGISTERED, 'pending');
    expect(() => invite.issueInvite(base(UNREGISTERED))).toThrow(
      /\[CD_INVITE_TENANT_NOT_REGISTERED\]/u
    );
    expect(io.safeExistsSync(tenantDir(UNREGISTERED))).toBe(false);
  });

  it('a suspended tenant: uses stop, revoke works, nothing else is written', () => {
    const { invite: issued, token } = invite.issueInvite(base());
    const { invite: second } = invite.issueInvite(base());
    setProfile(TENANT, 'suspended');
    // The invite stops working, with or without a use record.
    for (const record of [true, false])
      expect(invite.verifyInviteToken(TENANT, token, { now: NOW, action: 'view', record })).toEqual(
        { ok: false, reason: 'unavailable' }
      );
    expect(readRaw(TENANT, issued.invite_id).uses).toEqual([]);
    // No new invite.
    expect(() => invite.issueInvite(base())).toThrow(/\[CD_INVITE_TENANT_NOT_REGISTERED\]/u);
    // A brand-new record written directly as the store role is refused too.
    const fresh = { ...readRaw(TENANT, issued.invite_id), invite_id: 'inv-00000000000000aa' };
    expect(() => writeAsStore(TENANT, 'inv-00000000000000aa', JSON.stringify(fresh))).toThrow(
      /\[CD_INVITE_TENANT_NOT_REGISTERED\]/u
    );
    // A "revoke" that changes any other field is refused.
    const sneaky = {
      ...readRaw(TENANT, second.invite_id),
      revoked_at: NOW,
      revoked_reason: 'x',
      expires_at: '2099-01-01T00:00:00.000Z',
    };
    expect(() => writeAsStore(TENANT, second.invite_id, JSON.stringify(sneaky))).toThrow(
      /\[CD_INVITE_TENANT_NOT_REGISTERED\]/u
    );
    // A plain field change (no revoke) is refused.
    const plain = { ...readRaw(TENANT, second.invite_id), uses: [{ at: NOW, action: 'view' }] };
    expect(() => writeAsStore(TENANT, second.invite_id, JSON.stringify(plain))).toThrow(
      /\[CD_INVITE_TENANT_NOT_REGISTERED\]/u
    );
    // The revoke itself succeeds, and a second revoke writes nothing.
    const revoked = invite.revokeInvite(TENANT, issued.invite_id, { now: NOW, reason: 'offboard' });
    expect(revoked.revoked_at).toBe(NOW);
    expect(readRaw(TENANT, issued.invite_id).revoked_reason).toBe('offboard');
    expect(
      invite.revokeInvite(TENANT, issued.invite_id, { now: NOW, reason: 'again' }).revoked_reason
    ).toBe('offboard');
    // Once revoked, a further "revoke" write is not a revoke-only change.
    const rerevoke = { ...readRaw(TENANT, issued.invite_id), revoked_reason: 'changed' };
    expect(() => writeAsStore(TENANT, issued.invite_id, JSON.stringify(rerevoke))).toThrow(
      /\[CD_INVITE_TENANT_NOT_REGISTERED\]/u
    );
    // Reads still work for the operator listing.
    expect(
      invite
        .listInvites(TENANT)
        .map((item) => item.invite_id)
        .sort()
    ).toEqual([issued.invite_id, second.invite_id].sort());
  });

  it('an active tenant is unchanged: a direct write as the store role still lands', () => {
    const { invite: issued } = invite.issueInvite(base());
    const changed = { ...readRaw(TENANT, issued.invite_id), uses: [{ at: NOW, action: 'view' }] };
    writeAsStore(TENANT, issued.invite_id, JSON.stringify(changed));
    expect(readRaw(TENANT, issued.invite_id).uses).toEqual([{ at: NOW, action: 'view' }]);
  });

  it('the store role requires its exact capability', () => {
    expect(() =>
      authority.withExecutionContext(
        capabilityModule.CUSTOMER_DECISION_INVITE_STORE_ROLE,
        () => undefined,
        undefined,
        TENANT
      )
    ).toThrow(/RESOURCE_SCOPE_REQUIRED/u);
    expect(() =>
      capabilityModule.customerDecisionInviteCapability(
        TENANT,
        `${STORE}/confidential/${TENANT}`,
        true
      )
    ).toThrow(/RESOURCE_SCOPE_INVALID/u);
  });
});
