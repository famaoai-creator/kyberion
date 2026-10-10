import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MemberProfile } from '../organization/member-registry.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';

const registry = vi.hoisted(() => ({
  profiles: {} as Record<string, MemberProfile>,
  ids: undefined as string[] | undefined,
  listError: false,
  readError: undefined as string | undefined,
  observedRoles: [] as (string | undefined)[],
}));
vi.mock('../organization/member-registry.js', async (original) => ({
  ...(await original<typeof import('../organization/member-registry.js')>()),
  listMemberIdsStrict: vi.fn(() => {
    registry.observedRoles.push(process.env.MISSION_ROLE);
    if (registry.listError) throw new Error('private registry enumeration failure');
    return registry.ids ?? Object.keys(registry.profiles).sort();
  }),
  readMemberProfile: vi.fn((id: string) => {
    registry.observedRoles.push(process.env.MISSION_ROLE);
    if (registry.readError === id) throw new Error('private corrupt registry profile');
    return registry.profiles[id] ? structuredClone(registry.profiles[id]) : null;
  }),
}));

import { listMemberIdsStrict, readMemberProfile } from '../organization/member-registry.js';
import { SurfaceViewerScopeError } from './surface-mutation-guard.js';
import { SurfaceViewerScopeError as ContractScopeError } from './surface-viewer-scope-contract.js';
import { canonicalHumanOwner as contractHumanOwner } from './verified-human-request-contract.js';
import {
  canonicalHumanOwner,
  HUMAN_REQUEST_READ_SCOPE,
  HUMAN_REQUEST_RECEIVE_SCOPE,
  resolveVerifiedBrowserHumanRequestIdentity,
  resolveVerifiedHumanRequestIdentity,
  type HumanRequestServerPolicy,
  type VerifiedBrowserHumanProof,
  type VerifiedHumanRequestInput,
} from './verified-human-request-identity.js';

const identity = { issuer: 'https://fixture-idp.example', subject: 'verified-subject' };
const scopes = [HUMAN_REQUEST_READ_SCOPE, HUMAN_REQUEST_RECEIVE_SCOPE];
function profile(id = 'alice'): MemberProfile {
  return {
    member_id: id,
    display_name: id,
    status: 'active',
    memberships: [
      { tenant_slug: 'alpha', role: 'owner' },
      { tenant_slug: 'beta', role: 'viewer' },
    ],
    external_identities: [{ ...identity }],
    access_registrations: [],
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}
function policy(): HumanRequestServerPolicy {
  return {
    authorityNamespace: 'fixture-deployment:v1',
    tenantSlugs: ['alpha', 'beta'],
    organizationIds: ['org-a', 'org-b'],
    projectIds: ['project-a', 'project-b'],
    tierAccess: ['public', 'confidential'],
  };
}
function input(overrides: Partial<VerifiedHumanRequestInput> = {}): VerifiedHumanRequestInput {
  return {
    identity: { ...identity },
    policy: policy(),
    oauthScopes: [...scopes],
    transport: 'mcp-oauth',
    narrowing: { tenant: 'alpha', organizationId: 'org-a', projectId: 'project-a', tier: 'public' },
    memberRegistry: { rootDir: '/synthetic-registry-not-read' },
    ...overrides,
  };
}
const resolve = (overrides: Partial<VerifiedHumanRequestInput> = {}) =>
  resolveVerifiedHumanRequestIdentity(input(overrides));

beforeEach(() => {
  registry.profiles = { alice: profile() };
  registry.ids = undefined;
  registry.listError = false;
  registry.readError = undefined;
  registry.observedRoles = [];
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

describe('strict verified human identity', () => {
  it('uses a governed full registry scan and restores the caller context', () => {
    vi.stubEnv('MISSION_ROLE', 'mission_controller');
    const result = resolve();
    expect(registry.observedRoles).toEqual(['sovereign_concierge', 'sovereign_concierge']);
    expect(process.env.MISSION_ROLE).toBe('mission_controller');
    expect(listMemberIdsStrict).toHaveBeenCalledWith({ rootDir: '/synthetic-registry-not-read' });
    expect(readMemberProfile).toHaveBeenCalledWith('alice', {
      rootDir: '/synthetic-registry-not-read',
    });
    expect(result.viewer).toMatchObject({
      role: 'readonly',
      memberId: 'alice',
      principalId: 'user:alice',
    });
    expect(result.permissions).toEqual(['surface.headless.read', 'surface.headless.write']);
    expect(result.viewer.canonicalHuman.membershipFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('honors role-assumption denial rather than reading through a fallback', () => {
    vi.stubEnv('SYSTEM_ROLE', 'event_intake_surface');
    expect(() => resolve()).toThrow('Verified human identity denied');
    expect(listMemberIdsStrict).not.toHaveBeenCalled();
    expect(readMemberProfile).not.toHaveBeenCalled();
  });

  it('maps aliases to one canonical member while keeping provenance separate', () => {
    const alias = { issuer: 'https://second-idp.example', subject: 'other-subject' };
    registry.profiles.alice.external_identities!.push(alias);
    const first = resolve();
    const second = resolve({ identity: alias });
    expect(second.viewer).toEqual(first.viewer);
    expect(second.transportEvidence).toEqual({ ...alias, transport: 'mcp-oauth' });
    expect(second.transportEvidence).not.toEqual(first.transportEvidence);
  });

  it.each([
    { issuer: 'https://other-idp.example', subject: identity.subject },
    { issuer: identity.issuer + '/', subject: identity.subject },
    { issuer: ' ' + identity.issuer, subject: identity.subject },
    { issuer: identity.issuer, subject: identity.subject + ' ' },
    { issuer: identity.issuer, subject: 'alice' },
    { issuer: identity.issuer, subject: 'user:alice' },
    { issuer: '', subject: identity.subject },
  ])('requires the exact issuer + subject pair: %j', (candidate) => {
    expect(() => resolve({ identity: candidate })).toThrow(SurfaceViewerScopeError);
  });

  it('never uses asserted member ids, roles, or subject-only fallback', () => {
    const claimed = {
      issuer: identity.issuer,
      subject: 'unbound',
      member_id: 'alice',
      role: 'localadmin',
    };
    expect(() => resolve({ identity: claimed })).toThrow('Verified human identity denied');
    const result = resolve({
      identity: { ...identity, ...{ member_id: 'bob', role: 'localadmin' } },
    });
    expect(result.viewer.memberId).toBe('alice');
    expect(result.viewer.role).toBe('readonly');
    expect(result.viewer.tierAccess).toEqual(['public']);
  });

  it.each([
    'enumeration',
    'corrupt',
    'missing',
    'suspended',
    'duplicate-active',
    'duplicate-suspended',
    'duplicate-id',
  ])('denies an unverifiable registry or binding: %s', (failure) => {
    if (failure === 'enumeration') registry.listError = true;
    if (failure === 'corrupt' || failure === 'missing') {
      registry.ids = ['alice', 'zz-unknown'];
      if (failure === 'corrupt') registry.readError = 'zz-unknown';
    }
    if (failure === 'suspended') registry.profiles.alice.status = 'suspended';
    if (failure.startsWith('duplicate-') && failure !== 'duplicate-id') {
      registry.profiles.bob = profile('bob');
      if (failure === 'duplicate-suspended') registry.profiles.bob.status = 'suspended';
    }
    if (failure === 'duplicate-id') registry.ids = ['alice', 'alice'];
    expect(() => resolve()).toThrow('Verified human identity denied.');
    try {
      resolve();
    } catch (error) {
      expect(String(error)).not.toContain('private');
    }
  });

  it('denies empty registries and profiles with a mismatching member id', () => {
    registry.profiles = {};
    expect(() => resolve()).toThrow('Verified human identity denied');
    registry.profiles = { alice: profile('bob') };
    expect(() => resolve()).toThrow('Verified human identity denied');
  });

  it('fingerprints all current memberships, tolerates identical duplicates, and ignores display data', () => {
    const first = resolve().viewer.canonicalHuman;
    registry.profiles.alice.memberships.reverse();
    registry.profiles.alice.memberships.push({ tenant_slug: 'alpha', role: 'owner' });
    registry.profiles.alice.display_name = 'New display name';
    registry.profiles.alice.updated_at = '2026-10-02T00:00:00.000Z';
    expect(resolve().viewer.canonicalHuman).toEqual(first);
    registry.profiles.alice.memberships = [
      { tenant_slug: 'alpha', role: 'owner' },
      { tenant_slug: 'beta', role: 'operator' },
    ];
    expect(resolve().viewer.canonicalHuman.membershipFingerprint).not.toBe(
      first.membershipFingerprint
    );
  });

  it('denies contradictory membership rows and refreshes membership downgrades', () => {
    const first = resolve();
    registry.profiles.alice.memberships.push({ tenant_slug: 'alpha', role: 'viewer' });
    expect(() => resolve()).toThrow('Verified human identity denied');
    registry.profiles.alice.memberships = [{ tenant_slug: 'alpha', role: 'viewer' }];
    const downgraded = resolve();
    expect(downgraded.permissions).toEqual(['surface.headless.read']);
    expect(downgraded.viewer.canonicalHuman.membershipFingerprint).not.toBe(
      first.viewer.canonicalHuman.membershipFingerprint
    );
    registry.profiles.alice.memberships = [{ tenant_slug: 'beta', role: 'viewer' }];
    expect(() => resolve()).toThrow(SurfaceViewerScopeError);
  });
});

describe('monotonic request authority', () => {
  it('intersects server and member tenants then narrows every dimension', () => {
    const result = resolve({ policy: { ...policy(), tenantSlugs: ['alpha', 'unrelated'] } });
    expect(result.viewer).toMatchObject({
      tenantSlugs: ['alpha'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
      tierAccess: ['public'],
    });
  });

  it.each([
    { tenant: 'unrelated' },
    { organizationId: 'org-unknown' },
    { projectId: 'project-unknown' },
    { tier: 'personal' },
  ])('request narrowing cannot widen server caps: %j', (narrowing) => {
    expect(() =>
      resolve({ narrowing: narrowing as VerifiedHumanRequestInput['narrowing'] })
    ).toThrow(SurfaceViewerScopeError);
  });

  it.each([
    { authorityNamespace: undefined },
    { authorityNamespace: 123 },
    { authorityNamespace: '' },
    { authorityNamespace: 'bad namespace' },
    { authorityNamespace: 'a'.repeat(129) },
    { tenantSlugs: 'all' },
    { tenantSlugs: [] },
    { tenantSlugs: ['unrelated'] },
    { tenantSlugs: ['public'] },
    { organizationIds: [] },
    { projectIds: [] },
    { tierAccess: [] },
    { tierAccess: ['personal'] },
  ])('rejects absent or invalid explicit server caps: %j', (patch) => {
    expect(() =>
      resolve({ policy: { ...policy(), ...patch } as HumanRequestServerPolicy })
    ).toThrow(SurfaceViewerScopeError);
  });

  it('allows explicit org/project all caps while requiring finite tenant membership', () => {
    const result = resolve({
      policy: { ...policy(), organizationIds: 'all', projectIds: 'all' },
      narrowing: { tenant: 'alpha', tier: 'public' },
    });
    expect(result.viewer.organizationIds).toBe('all');
    expect(result.viewer.projectIds).toBe('all');
    expect(result.viewer.tenantSlugs).toEqual(['alpha']);
  });

  it.each(['viewer', 'approver', 'operator', 'owner'] as const)(
    'receive scope checks the selected tenant membership: %s',
    (role) => {
      registry.profiles.alice.memberships[0].role = role;
      expect(resolve().permissions.includes('surface.headless.write')).toBe(
        role === 'owner' || role === 'operator'
      );
      expect(resolve().viewer.role).toBe('readonly');
    }
  );

  it('never carries receive authority from an owner tenant to a viewer tenant or a multi-tenant scope', () => {
    expect(resolve({ narrowing: { tenant: 'beta' } }).permissions).toEqual([
      'surface.headless.read',
    ]);
    expect(resolve({ narrowing: undefined }).permissions).toEqual(['surface.headless.read']);
  });

  it('operation grants are independent, unknown scopes have no authority, and never change ownership', () => {
    const initial = resolve();
    expect(resolve({ oauthScopes: [] }).permissions).toEqual([]);
    expect(
      resolve({ oauthScopes: ['openid', 'admin', 'kyberion_role:localadmin'] }).permissions
    ).toEqual([]);
    expect(resolve({ oauthScopes: [HUMAN_REQUEST_RECEIVE_SCOPE] }).permissions).toEqual([
      'surface.headless.write',
    ]);
    const read = resolve({ oauthScopes: [HUMAN_REQUEST_READ_SCOPE] });
    expect(read.permissions).toEqual(['surface.headless.read']);
    expect(read.viewer).toEqual(initial.viewer);
  });

  it('detaches and freezes returned authority and provenance', () => {
    const request = input({ narrowing: undefined });
    const result = resolveVerifiedHumanRequestIdentity(request);
    (request.policy.tenantSlugs as string[]).push('new-tenant');
    (request.policy.organizationIds as string[]).push('new-org');
    request.identity.subject = 'changed';
    registry.profiles.alice.memberships[0].role = 'viewer';
    expect(result.viewer.tenantSlugs).toEqual(['alpha', 'beta']);
    expect(result.viewer.organizationIds).toEqual(['org-a', 'org-b']);
    expect(result.transportEvidence.subject).toBe(identity.subject);
    for (const value of [
      result,
      result.viewer,
      result.viewer.tenantSlugs,
      result.viewer.organizationIds,
      result.viewer.projectIds,
      result.viewer.tierAccess,
      result.viewer.canonicalHuman,
      result.permissions,
      result.transportEvidence,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
});

describe('canonical ownership validation', () => {
  it('preserves canonical validation and error constructor identity through legacy exports', () => {
    expect(canonicalHumanOwner).toBe(contractHumanOwner);
    expect(SurfaceViewerScopeError).toBe(ContractScopeError);
    const viewer = resolve().viewer;
    for (const [patch, message] of [
      [{ canonicalHuman: undefined }, 'Verified human identity denied.'],
      [{ principalId: 'user:bob' }, 'Verified human identity denied.'],
      [{ tenantSlugs: ['public'] }, 'Verified human request scope denied.'],
      [{ tenantSlugs: ['alpha\n'] }, 'Verified human request scope denied.'],
      [{ organizationIds: ['org a'] }, 'Verified human request scope denied.'],
      [{ projectIds: ['project/a'] }, 'Verified human request scope denied.'],
      [{ tierAccess: ['personal'] }, 'Verified human request scope denied.'],
    ] as const) {
      let thrown: unknown;
      try {
        contractHumanOwner({ ...viewer, ...patch } as SurfaceViewerScope);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SurfaceViewerScopeError);
      expect(thrown).toBeInstanceOf(ContractScopeError);
      expect(thrown).toMatchObject({ name: 'SurfaceViewerScopeError', status: 403, message });
    }
  });

  it('rejects an inherited malformed marker and keeps valid ownership detached and frozen', () => {
    const { canonicalHuman, ...legacy } = resolve().viewer;
    expect(contractHumanOwner(legacy)).toBeUndefined();
    const inherited = Object.assign(Object.create({ canonicalHuman: undefined }), legacy);
    expect(() => contractHumanOwner(inherited)).toThrow('Verified human identity denied.');
    const owner = contractHumanOwner({ ...legacy, canonicalHuman: { ...canonicalHuman } });
    expect(owner).toEqual(canonicalHuman);
    expect(owner).not.toBe(canonicalHuman);
    expect(Object.isFrozen(owner)).toBe(true);
  });

  it('leaves unmarked legacy viewers alone, but rejects malformed markers without fallback', () => {
    const { canonicalHuman: _marker, ...legacy } = resolve().viewer;
    expect(canonicalHumanOwner(legacy)).toBeUndefined();
    for (const canonicalHuman of [
      undefined,
      null,
      {},
      { ...resolve().viewer.canonicalHuman, transport: 'mcp' },
    ])
      expect(() =>
        canonicalHumanOwner({ ...legacy, canonicalHuman } as SurfaceViewerScope)
      ).toThrow(SurfaceViewerScopeError);
  });

  it.each([
    { source: 'loopback' },
    { role: 'localadmin' },
    { memberId: 'bob' },
    { principalId: identity.subject },
    { tenantSlugs: 'all' },
    { tierAccess: ['personal'] },
  ])('rejects a contradictory canonical viewer: %j', (patch) => {
    expect(() =>
      canonicalHumanOwner({ ...resolve().viewer, ...patch } as SurfaceViewerScope)
    ).toThrow(SurfaceViewerScopeError);
  });

  it.each([
    { version: 2 },
    { authorityNamespace: '' },
    { authorityNamespace: 'bad namespace' },
    { memberId: 'ext-unregistered' },
    { membershipFingerprint: 'not-a-hash' },
  ])('rejects a malformed identity marker: %j', (patch) => {
    const viewer = resolve().viewer;
    expect(() =>
      canonicalHumanOwner({
        ...viewer,
        canonicalHuman: { ...viewer.canonicalHuman, ...patch },
      } as SurfaceViewerScope)
    ).toThrow(SurfaceViewerScopeError);
  });

  it('separates registry namespaces and members while returning a detached owner', () => {
    const viewer = resolve().viewer;
    const second = resolve({
      policy: { ...policy(), authorityNamespace: 'another-deployment' },
    }).viewer;
    expect(second.canonicalHuman).not.toEqual(viewer.canonicalHuman);
    expect(canonicalHumanOwner(viewer)).toEqual(viewer.canonicalHuman);
    expect(canonicalHumanOwner(viewer)).not.toBe(viewer.canonicalHuman);
  });

  it('canonicalizes marker field order before ownership hashing', () => {
    const viewer = resolve().viewer;
    const canonicalHuman = {
      membershipFingerprint: viewer.canonicalHuman.membershipFingerprint,
      memberId: viewer.canonicalHuman.memberId,
      authorityNamespace: viewer.canonicalHuman.authorityNamespace,
      version: 1 as const,
    };
    expect(JSON.stringify(canonicalHumanOwner({ ...viewer, canonicalHuman }))).toBe(
      JSON.stringify(canonicalHumanOwner(viewer))
    );
  });
});

describe('explicit trusted browser parity seam', () => {
  const now = Date.parse('2026-10-10T00:00:00.000Z');
  const proof = (): VerifiedBrowserHumanProof => ({
    ...identity,
    provider: 'browser-session',
    source: 'oidc',
    expiresAt: '2026-10-10T01:00:00.000Z',
  });
  const browser = (patch: Record<string, unknown> = {}) =>
    resolveVerifiedBrowserHumanRequestIdentity({
      ...input(),
      enabled: true,
      proof: proof(),
      now,
      ...patch,
    });

  it('shares canonical ownership only through explicit trusted verified identity proof', () => {
    const web = browser();
    expect(web.viewer).toEqual(resolve().viewer);
    expect(web.permissions).toEqual(resolve().permissions);
    expect(web.transportEvidence).toEqual({ ...identity, transport: 'browser-session' });
  });

  it.each([
    { enabled: undefined },
    { enabled: false },
    { proof: undefined },
    { proof: { ...proof(), provider: 'oidc-jwt' } },
    { proof: { ...proof(), source: 'loopback' } },
    { proof: { ...proof(), expiresAt: undefined } },
    { proof: { ...proof(), expiresAt: 'invalid' } },
    { proof: { ...proof(), expiresAt: '2026-10-10T00:00:00.000Z' } },
    { proof: { ...proof(), subject: undefined, principalId: identity.subject } },
    { proof: undefined, token: 'a-raw-browser-bearer' },
    { now: Number.NaN },
  ])('denies missing opt-in, evidence, or expiry: %j', (patch) => {
    expect(() => browser(patch)).toThrow(SurfaceViewerScopeError);
  });

  it('rechecks binding and membership instead of trusting a previously verified browser proof', () => {
    browser();
    registry.profiles.alice.status = 'suspended';
    expect(() => browser()).toThrow(SurfaceViewerScopeError);
    registry.profiles.alice.status = 'active';
    registry.profiles.alice.external_identities = [];
    expect(() => browser()).toThrow(SurfaceViewerScopeError);
  });
});
