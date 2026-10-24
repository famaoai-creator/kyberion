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
  // A structural mkdir of the tier directory needs a registered active tenant.
  process.env.KYBERION_PERSONA = 'sovereign';
  for (const tenant of [TENANT, OTHER])
    io.safeWriteFile(
      path.join(ROOT, 'knowledge/personal/tenants', `${tenant}.json`),
      JSON.stringify({ tenant_slug: tenant, status: 'active' })
    );
  delete process.env.KYBERION_PERSONA;
}, 120_000);

beforeEach(() => {
  for (const key of keys) delete process.env[key];
  authority.withExecutionContext('ecosystem_architect', () => {
    for (const tenant of [TENANT, OTHER])
      io.safeRmSync(tenantDir(tenant), { recursive: true, force: true });
  });
});

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
