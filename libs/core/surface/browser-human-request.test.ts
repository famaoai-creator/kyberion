import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberProfile } from '../organization/member-registry.js';
const registry = vi.hoisted(() => ({ members: [] as MemberProfile[], unreadable: false }));
vi.mock('../secret/secret-guard.js', () => ({
  secretGuard: { loadConnectionDocument: () => undefined },
}));
vi.mock('../organization/member-registry.js', async (original) => ({
  ...(await original<typeof import('../organization/member-registry.js')>()),
  findMemberByExternalIdentity: (issuer: string, subject: string) =>
    registry.members.find(
      (member) =>
        member.status === 'active' &&
        member.external_identities?.some(
          (binding) => binding.issuer === issuer && binding.subject === subject
        )
    ) ?? null,
  externalIdentityBindingDenied: (issuer: string, subject: string) =>
    registry.members.some(
      (member) =>
        member.status !== 'active' &&
        member.external_identities?.some(
          (binding) => binding.issuer === issuer && binding.subject === subject
        )
    ),
  listMemberIdsStrict: () => {
    if (registry.unreadable) throw Error('private registry');
    return registry.members.map((member) => member.member_id);
  },
  readMemberProfile: (id: string) =>
    registry.members.find((member) => member.member_id === id) ?? null,
}));
import { mintBrowserSessionToken, verifiedBrowserSessionIdentity } from '../authn-providers.js';
import { resolveAuthnSurfaceViewerScope } from './surface-authn.js';
import {
  resolveBrowserHumanRequestIdentity,
  authorizeBrowserHumanRequest,
} from './browser-human-request.js';
import type { HumanRequestRuntimeConfig } from './human-request-runtime-config.js';
const NOW = Date.parse('2026-10-11T00:00:00Z');
const ISSUER = 'https://synthetic-issuer.example';
const ENV = { KYBERION_SESSION_SECRET: 'synthetic-browser-session-key-for-testing-only' };
const config: HumanRequestRuntimeConfig = {
  version: 1,
  policy: {
    authorityNamespace: 'test-deployment',
    tenantSlugs: ['alpha', 'beta'],
    organizationIds: ['org-a'],
    projectIds: ['project-a'],
    tierAccess: ['public', 'confidential'],
  },
  browser: {
    enabled: true,
    operationScopes: ['kyberion:requests:read', 'kyberion:requests:receive'],
  },
};
const narrowing = {
  tenant: 'alpha',
  organizationId: 'org-a',
  projectId: 'project-a',
  tier: 'public' as const,
};
function session(subject = 'alice-sub', ttlSeconds = 300) {
  return mintBrowserSessionToken({ idpIssuer: ISSUER, subject, ttlSeconds }, { env: ENV, now: NOW })
    .token;
}
function viewer(token = session()) {
  const { scope, principal } = resolveAuthnSurfaceViewerScope({
    token,
    local: false,
    providerIds: ['browser-session'],
    allowPersonalTier: false,
    deps: { env: ENV, now: NOW },
  });
  return { ...scope, principal };
}
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  registry.unreadable = false;
  registry.members = [
    {
      member_id: 'alice',
      display_name: 'Synthetic Alice',
      status: 'active',
      memberships: [
        { tenant_slug: 'alpha', role: 'operator' },
        { tenant_slug: 'beta', role: 'viewer' },
      ],
      external_identities: [{ issuer: ISSUER, subject: 'alice-sub' }],
      access_registrations: [],
      created_at: '2026-10-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
    },
  ];
});
afterEach(() => {
  vi.useRealTimers();
});
describe('verified browser request bridge', () => {
  it('retains immutable issuer/subject/expiry only on the exact verified principal', () => {
    const v = viewer();
    const proof = verifiedBrowserSessionIdentity(v.principal)!;
    expect(proof).toEqual({
      issuer: ISSUER,
      subject: 'alice-sub',
      expiresAt: '2026-10-11T00:05:00.000Z',
      provider: 'browser-session',
      source: 'oidc',
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(verifiedBrowserSessionIdentity({ ...v.principal })).toBeUndefined();
    expect(verifiedBrowserSessionIdentity(structuredClone(v.principal))).toBeUndefined();
    expect(v.principal.claims).not.toHaveProperty('sub');
    v.principal.claims = { iss: 'https://forged.example', sub: 'forged-sub' };
    v.principal.expiresAt = '2999-01-01T00:00:00.000Z';
    expect(verifiedBrowserSessionIdentity(v.principal)).toEqual(proof);
    expect(() =>
      resolveBrowserHumanRequestIdentity(v, config, narrowing, { now: NOW + 300_000 })
    ).toThrow();
    expect(() =>
      resolveBrowserHumanRequestIdentity({ ...v, principal: { ...v.principal } }, config, narrowing)
    ).toThrow();
  });
  it('requires explicit enablement and leaves non-browser legacy paths unchanged', () => {
    const v = viewer();
    expect(resolveBrowserHumanRequestIdentity(v, { version: 1 }, narrowing)).toBeUndefined();
    expect(
      resolveBrowserHumanRequestIdentity(v, { ...config, browser: { enabled: false } }, narrowing)
    ).toBeUndefined();
    expect(
      resolveBrowserHumanRequestIdentity({ ...v, principal: undefined }, config, narrowing)
    ).toBeUndefined();
  });
  it('uses fresh exact bindings and selected-tenant operation policy without localadmin', () => {
    const v = viewer();
    expect(v.role).toBe('readonly');
    const resolved = resolveBrowserHumanRequestIdentity(v, config, narrowing)!;
    expect(resolved.viewer).toMatchObject({
      role: 'readonly',
      principalId: 'user:alice',
      memberId: 'alice',
      tenantSlugs: ['alpha'],
      tierAccess: ['public'],
      canonicalHuman: { memberId: 'alice', authorityNamespace: 'test-deployment' },
    });
    expect(resolved.permissions).toContain('surface.headless.write');
    const audit = vi.fn();
    authorizeBrowserHumanRequest(
      resolved,
      'receive',
      '11111111-1111-4111-8111-111111111111',
      audit
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer: ISSUER,
        subject: 'alice-sub',
        tenant: 'alpha',
        transport: 'browser-session',
      })
    );
    const readonly = resolveBrowserHumanRequestIdentity(v, config, {
      ...narrowing,
      tenant: 'beta',
    })!;
    expect(() => authorizeBrowserHumanRequest(readonly, 'receive', undefined, audit)).toThrow();
    expect(audit).toHaveBeenCalledTimes(1);
  });
  it('cannot widen the final viewer restrictions using configuration or client hints', () => {
    const v = viewer();
    expect(() =>
      resolveBrowserHumanRequestIdentity({ ...v, tenantSlugs: ['alpha'] }, config, {
        ...narrowing,
        tenant: 'beta',
      })
    ).toThrow();
    expect(() =>
      resolveBrowserHumanRequestIdentity({ ...v, tierAccess: ['public'] }, config, {
        ...narrowing,
        tier: 'confidential',
      })
    ).toThrow();
    expect(() =>
      resolveBrowserHumanRequestIdentity({ ...v, organizationIds: ['org-b'] }, config, narrowing)
    ).toThrow();
    expect(() =>
      resolveBrowserHumanRequestIdentity({ ...v, projectIds: ['project-b'] }, config, narrowing)
    ).toThrow();
    expect(() =>
      resolveBrowserHumanRequestIdentity({ ...v, memberId: 'other' }, config, narrowing)
    ).toThrow();
  });
  it('rechecks expiry, revocation, duplicates and unreadable registry on every operation resolution', () => {
    const v = viewer();
    expect(() =>
      resolveBrowserHumanRequestIdentity(v, config, narrowing, { now: NOW + 300_000 })
    ).toThrow();
    registry.members[0].status = 'suspended';
    expect(() => resolveBrowserHumanRequestIdentity(v, config, narrowing)).toThrow();
    registry.members[0].status = 'active';
    registry.members.push({ ...registry.members[0], member_id: 'duplicate' });
    expect(() => resolveBrowserHumanRequestIdentity(v, config, narrowing)).toThrow();
    registry.members.pop();
    registry.unreadable = true;
    expect(() => resolveBrowserHumanRequestIdentity(v, config, narrowing)).toThrow();
    registry.unreadable = false;
    registry.members[0].external_identities = [];
    expect(() => resolveBrowserHumanRequestIdentity(v, config, narrowing)).toThrow();
  });
  it('rejects forged sessions before producing any proof', () => {
    const token = session();
    expect(() => viewer(token.slice(0, -4) + 'AAAA')).toThrow();
    const wrong = mintBrowserSessionToken(
      { idpIssuer: ISSUER, subject: 'alice-sub', ttlSeconds: 300 },
      { env: { KYBERION_SESSION_SECRET: 'different-synthetic-session-key-123456' }, now: NOW }
    ).token;
    expect(() => viewer(wrong)).toThrow();
  });
  it('fails closed when operation audit throws', () => {
    const resolved = resolveBrowserHumanRequestIdentity(viewer(), config, narrowing)!;
    expect(() =>
      authorizeBrowserHumanRequest(resolved, 'history', undefined, () => {
        throw Error('audit unavailable');
      })
    ).toThrow('audit unavailable');
  });
});
