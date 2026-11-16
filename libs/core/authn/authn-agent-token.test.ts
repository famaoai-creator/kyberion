/** Signed workload credentials against real synthetic identity journals. */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOnboardingAuthorityFixture } from '../../../tests/helpers/onboarding-authority-fixture.js';

const f = useOnboardingAuthorityFixture();
const KEY = 'synthetic-agent-token-contract-key-not-a-real-credential';
const NOW = Date.parse('2026-11-16T12:00:00Z');
const deps = { env: { KYBERION_AGENT_TOKEN_SECRET: KEY }, now: NOW, registrations: [] };

/** Independent signer exercises verifier validation even when the public issuer refuses a claim. */
function signClaims(claims: unknown): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = createHmac('sha256', KEY).update(`kya1.${body}`).digest('base64url');
  return `kya1.${body}.${signature}`;
}
async function setup() {
  const api = await import('./authn-providers.js');
  const resolver = await import('./authn-principal-resolver.js');
  const issue = (input: Partial<Parameters<typeof api.issueAgentToken>[0]> = {}) =>
    f.run(() => api.issueAgentToken({ nhiId: f.installedId, ...input }, deps));
  const resolve = (token: string, serverTenant?: string) =>
    f.run(
      () =>
        resolver.resolveAuthnPrincipal(
          {
            credential: { type: 'agent-token', token },
            ...(serverTenant === undefined ? {} : { serverTenant }),
          },
          { providerIds: ['agent-token'], pin: false, record: false, deps }
        ).principal
    );
  const rejected = (claims: unknown, serverTenant?: string) =>
    expect(() => resolve(signClaims(claims), serverTenant)).toThrow(resolver.AuthnError);
  return { api, resolver, issue, resolve, rejected };
}
afterEach(() => vi.restoreAllMocks());

describe('strict signed agent workload credential contract', () => {
  it('round-trips personal identity, owner, exact empty tenancy and live journal revision', async () => {
    const x = await setup();
    const issued = x.issue();
    expect(issued.payload).toMatchObject({
      sub: f.installedId,
      obo: 'user:owner',
      tenants: [],
      identity_revision: f.identities.getAgentIdentityRevision(f.installedId),
      iat: NOW / 1000,
      exp: NOW / 1000 + 900,
    });
    expect(issued.payload.jti).toMatch(/^[a-f0-9]{32}$/);
    expect(x.resolve(issued.token)).toMatchObject({
      provider: 'agent-token',
      assurance: 'high',
      source: 'agent',
      tenantSlugs: [],
      actor: { kind: 'agent', id: f.installedId, on_behalf_of: 'user:owner' },
    });
    expect(() => x.resolve(issued.token, 'fixture-a')).toThrow(x.resolver.AuthnError);
  });

  it('uses distinct cryptographic token IDs even with deterministic Math.random and issuance time', async () => {
    const x = await setup();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const a = x.issue();
    const b = x.issue();
    expect(a.payload.jti).not.toBe(b.payload.jti);
    expect(a.token).not.toBe(b.token);
  });

  it('derives organization tenancy, permits empty narrowing and refuses server-side scope addition', async () => {
    const x = await setup();
    const nhiId = f.governIdentity(() => {
      const org = f.identities.issueAgentIdentity({
        kind: 'agent',
        slug: 'org-workload',
        tenantSlug: 'fixture-a',
        organizationId: 'org-a',
        accountableHumanId: 'user:owner',
      });
      return f.identities.activateAgentIdentity(org.nhi_id).nhi_id;
    });
    const full = x.issue({ nhiId });
    expect(full.payload.tenants).toEqual(['fixture-a']);
    expect(x.resolve(full.token, 'fixture-a').tenantSlugs).toEqual(['fixture-a']);
    expect(() => x.resolve(full.token, 'fixture-b')).toThrow(x.resolver.AuthnError);
    const narrow = x.issue({ nhiId, tenants: [] });
    expect(x.resolve(narrow.token).tenantSlugs).toEqual([]);
    expect(() => x.resolve(narrow.token, 'fixture-a')).toThrow(x.resolver.AuthnError);
    for (const tenants of [
      ['fixture-b'],
      ['fixture-a', 'fixture-b'],
      ['fixture-a', 'fixture-a'],
      ['invalid/tenant'],
      new Array<string>(1),
    ])
      expect(() => x.issue({ nhiId, tenants })).toThrow(x.resolver.AuthnError);
    x.rejected({ ...full.payload, tenants: ['fixture-b'] });
    x.rejected({ ...full.payload, tenants: ['fixture-a', 'fixture-a'] });
  });

  it('refuses owner substitution and personal tenant claims at issuance and verification', async () => {
    const x = await setup();
    expect(() => x.issue({ onBehalfOf: 'user:other' })).toThrow(x.resolver.AuthnError);
    expect(() => x.issue({ tenants: ['fixture-a'] })).toThrow(x.resolver.AuthnError);
    expect(() => x.issue({ tenants: ['', 'fixture-a'] })).toThrow(x.resolver.AuthnError);
    const issued = x.issue({ onBehalfOf: 'user:owner', tenants: [] });
    x.rejected({ ...issued.payload, obo: 'user:other' });
    x.rejected({ ...issued.payload, tenants: ['fixture-a'] });
  });

  it('bounds TTL to integer seconds from 1 through 900 without clamping invalid input', async () => {
    const x = await setup();
    for (const ttlSeconds of [0, -1, 0.5, 900.1, 901, Infinity, NaN, Number.MAX_SAFE_INTEGER])
      expect(() => x.issue({ ttlSeconds })).toThrow(x.resolver.AuthnError);
    for (const ttlSeconds of [1, 900]) {
      const issued = x.issue({ ttlSeconds });
      expect(issued.payload.exp - issued.payload.iat).toBe(ttlSeconds);
      expect(x.resolve(issued.token).actor.id).toBe(f.installedId);
    }
  });

  it('rejects a correctly signed malformed, unknown or legacy claim set', async () => {
    const x = await setup();
    const claims = x.issue().payload;
    for (const field of [
      'obo',
      'tenants',
      'identity_revision',
      'iss',
      'sub',
      'iat',
      'exp',
      'jti',
    ]) {
      const without: Record<string, unknown> = { ...claims };
      delete without[field];
      x.rejected(without);
    }
    for (const patch of [
      { extra: true },
      { iss: 'other-issuer' },
      { sub: 'kyberion://agent/fixture-a/legacy' },
      { obo: '' },
      { obo: null },
      { tenants: null },
      { tenants: 'fixture-a' },
      { tenants: [42] },
      { identity_revision: 0 },
      { identity_revision: 1.5 },
      { identity_revision: Number.MAX_SAFE_INTEGER + 1 },
      { jti: '' },
      { jti: 42 },
      { iat: 0 },
      { iat: -1 },
      { iat: NOW / 1000 + 1 },
      { iat: NOW / 1000 - 0.5 },
      { iat: '123' },
      { exp: NOW / 1000 },
      { exp: NOW / 1000 + 901 },
      { exp: NOW / 1000 + 0.5 },
      { exp: Number.MAX_SAFE_INTEGER + 1 },
    ])
      x.rejected({ ...claims, ...patch });
    for (const malformed of [null, [], 'claims', 42]) x.rejected(malformed);
    for (const token of ['kya1.', 'kya1.not-json.signature', 'kya1.' + 'A'.repeat(16 * 1024)])
      expect(() => x.resolve(token)).toThrow(x.resolver.AuthnError);
  });

  it('rejects signature tampering and expiry', async () => {
    const x = await setup();
    const issued = x.issue();
    expect(() => x.resolve(issued.token + 'x')).toThrow(x.resolver.AuthnError);
    expect(() =>
      f.run(() =>
        x.resolver.resolveAuthnPrincipal(
          { credential: { type: 'agent-token', token: issued.token } },
          {
            providerIds: ['agent-token'],
            pin: false,
            record: false,
            deps: { ...deps, now: NOW + 900_000 },
          }
        )
      )
    ).toThrow(x.resolver.AuthnError);
  });

  it('refuses a recognized token without a signing key even with default provider selection and loopback', async () => {
    const x = await setup();
    const issued = x.issue();
    expect(() =>
      f.run(() =>
        x.resolver.resolveAuthnPrincipal(
          { credential: { type: 'agent-token', token: issued.token }, loopback: true },
          { pin: false, record: false, deps: { ...deps, env: {} } }
        )
      )
    ).toThrow(x.resolver.AuthnError);
  });

  it.each([
    ['issuance', 'within the initial snapshot'],
    ['verification', 'within the initial snapshot'],
    ['issuance', 'between stable snapshots'],
    ['verification', 'between stable snapshots'],
  ] as const)('rejects %s when the journal revision changes %s', async (operation, transition) => {
    const x = await setup();
    const issued = x.issue();
    const identities = await import('../agent/agent-identity.js');
    const revision = issued.payload.identity_revision;
    const before = identities.getAgentIdentity(f.installedId);
    const revisions = vi.spyOn(identities, 'getAgentIdentityRevision');
    if (transition === 'within the initial snapshot') {
      revisions.mockReturnValueOnce(revision).mockReturnValue(revision + 1);
    } else {
      revisions
        .mockReturnValueOnce(revision)
        .mockReturnValueOnce(revision)
        .mockReturnValue(revision + 1);
    }
    // Only the read revision moves: the actual journal and active identity remain
    // intact, exposing mixed-generation reads rather than lifecycle rejection.
    expect(() => (operation === 'issuance' ? x.issue() : x.resolve(issued.token))).toThrow(
      x.resolver.AuthnError
    );
    expect(revisions).toHaveBeenCalledTimes(transition === 'within the initial snapshot' ? 2 : 4);
    expect(identities.getAgentIdentity(f.installedId)).toEqual(before);
    revisions.mockRestore();
    expect(x.resolve(issued.token).actor.id).toBe(f.installedId);
  });

  it('never revalidates an old token after suspend/reactivate ABA', async () => {
    const x = await setup();
    const old = x.issue();
    f.governIdentity(() =>
      f.identities.suspendAgentIdentity(f.installedId, 'Synthetic withdrawal')
    );
    expect(() => x.resolve(old.token)).toThrow(x.resolver.AuthnError);
    f.governIdentity(() => f.identities.activateAgentIdentity(f.installedId));
    expect(() => x.resolve(old.token)).toThrow(x.resolver.AuthnError);
    const fresh = x.issue();
    expect(fresh.payload.identity_revision).toBeGreaterThan(old.payload.identity_revision);
    expect(x.resolve(fresh.token).actor.id).toBe(f.installedId);
  });

  it('invalidates prior credentials after accountability changes and after owner ABA restoration', async () => {
    const x = await setup();
    const old = x.issue();
    f.governIdentity(() =>
      f.identities.reassignAgentIdentityAccountability({
        nhiId: f.installedId,
        accountableHumanId: 'user:other',
        expectedAccountableHumanId: 'user:owner',
        reason: 'Synthetic transfer',
      })
    );
    expect(() => x.resolve(old.token)).toThrow(x.resolver.AuthnError);
    const next = x.issue();
    expect(next.payload.obo).toBe('user:other');
    expect(x.resolve(next.token).actor.on_behalf_of).toBe('user:other');
    f.governIdentity(() =>
      f.identities.reassignAgentIdentityAccountability({
        nhiId: f.installedId,
        accountableHumanId: 'user:owner',
        expectedAccountableHumanId: 'user:other',
        reason: 'Synthetic return',
      })
    );
    expect(() => x.resolve(old.token)).toThrow(x.resolver.AuthnError);
    expect(() => x.resolve(next.token)).toThrow(x.resolver.AuthnError);
    expect(x.resolve(x.issue().token).actor.on_behalf_of).toBe('user:owner');
  });

  it('admits only active canonical agent identities, never provisioned, service or retired identities', async () => {
    const x = await setup();
    const provisioned = f.governIdentity(() =>
      f.identities.issueAgentIdentity({
        kind: 'agent',
        slug: 'not-active',
        personScope: true,
        accountableHumanId: 'user:owner',
      })
    );
    expect(() => x.issue({ nhiId: provisioned.nhi_id })).toThrow(x.resolver.AuthnError);
    const service = f.governIdentity(() => {
      const issued = f.identities.issueAgentIdentity({
        kind: 'service',
        slug: 'not-an-agent',
        personScope: true,
        accountableHumanId: 'user:owner',
      });
      return f.identities.activateAgentIdentity(issued.nhi_id);
    });
    expect(() => x.issue({ nhiId: service.nhi_id })).toThrow(x.resolver.AuthnError);
    const claims = x.issue().payload;
    x.rejected({
      ...claims,
      sub: service.nhi_id,
      identity_revision: f.identities.getAgentIdentityRevision(service.nhi_id),
    });
    x.rejected({
      ...claims,
      sub: provisioned.nhi_id,
      identity_revision: f.identities.getAgentIdentityRevision(provisioned.nhi_id),
    });
    expect(() => x.issue({ nhiId: 'kyberion://agent/fixture-a/legacy' })).toThrow(
      x.resolver.AuthnError
    );
    f.governIdentity(() => f.identities.retireAgentIdentity(f.installedId, 'Synthetic retirement'));
    expect(() => x.issue()).toThrow(x.resolver.AuthnError);
    x.rejected(claims);
  });
});
