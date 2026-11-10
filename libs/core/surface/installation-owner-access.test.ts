import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as pathResolver from '../path-resolver.js';
import { safeRmSync } from '../secure-io.js';
import { withExecutionContext } from '../authority.js';
import { humanActor, serviceActor, agentActor } from '../contracts/actor.js';
import type { ResolvedPrincipal } from '../authn/authn-principal-resolver.js';

const secretStore = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock('../secret/secret-guard.js', () => ({
  secretGuard: {
    loadConnectionDocument: (id: string) => ({ ...(secretStore.get(id) ?? {}) }),
    storeConnectionDocument: (id: string, patch: Record<string, unknown>) => {
      secretStore.set(id, { ...(secretStore.get(id) ?? {}), ...patch });
      return { path: id, changedKeys: Object.keys(patch) };
    },
  },
}));

import {
  ANONYMOUS_LOOPBACK_PRINCIPAL_ID,
  INSTALLATION_ANONYMOUS_LOOPBACK_ENV,
  INSTALLATION_STEP_UP_WINDOW_MS,
  anonymousLoopbackAllowed,
  evaluateInstallationOwnerAccess,
  installationBootstrapOpen,
  isIssuedInstallationOwnerGrant,
  recordInstallationAccessAudit,
  resetInstallationBootstrapCache,
  resolveInstallationOwnerAccess,
  type InstallationOwnerFacts,
} from './installation-owner-access.js';
import { writeMemberProfile, type MemberProfile } from '../organization/member-registry.js';
import {
  createPasskeyRegistrationOptions,
  createPasskeyStepUpOptions,
  verifyPasskeyRegistration,
  verifyPasskeyStepUp,
  type WebAuthnRelyingParty,
} from '../authn/webauthn-verifier.js';
import {
  readFreshInstallationStepUp,
  recordInstallationStepUp,
} from '../authn/installation-step-up.js';
import {
  createTestAuthenticator,
  type TestAuthenticator,
} from '../authn/__tests__/webauthn-fixtures.js';

const NOW = Date.parse('2026-11-04T00:00:00.000Z');

function principal(overrides: Partial<ResolvedPrincipal> = {}): ResolvedPrincipal {
  return {
    actor: humanActor('owner'),
    principalId: 'dev-user',
    role: 'localadmin',
    tenantSlugs: ['default'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
    source: 'oidc',
    provider: 'browser-session',
    assurance: 'high',
    memberId: 'owner',
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    ...overrides,
  };
}

const anonymousLoopback = principal({
  actor: humanActor('owner'),
  principalId: 'user:owner',
  source: 'loopback',
  provider: 'loopback-local',
  assurance: 'medium',
  memberId: undefined,
  expiresAt: undefined,
});

function facts(overrides: Partial<InstallationOwnerFacts> = {}): InstallationOwnerFacts {
  return {
    mode: 'write',
    principal: principal(),
    trustedLoopback: false,
    ownerMemberStatus: 'active',
    bootstrapOpen: false,
    anonymousLoopbackOverride: false,
    stepUpVerifiedAt: null,
    now: NOW,
    ...overrides,
  };
}

const fresh = new Date(NOW - 60_000).toISOString();
const stale = new Date(NOW - INSTALLATION_STEP_UP_WINDOW_MS - 1_000).toISOString();

describe('installation-owner decision table', () => {
  it.each([
    ['owner reads remotely', { mode: 'read' as const }, { allowed: true, stepUp: false }],
    ['owner writes on loopback', { trustedLoopback: true }, { allowed: true, stepUp: false }],
    [
      'owner writes remotely without step-up',
      {},
      { allowed: false, status: 403, code: 'installation_step_up_required' },
    ],
    [
      'owner writes remotely with a fresh step-up',
      { stepUpVerifiedAt: fresh },
      { allowed: true, stepUp: true, transport: 'remote' },
    ],
    [
      'owner writes remotely with a stale step-up',
      { stepUpVerifiedAt: stale },
      { allowed: false, code: 'installation_step_up_required' },
    ],
    [
      'owner writes remotely with a step-up dated in the future',
      { stepUpVerifiedAt: new Date(NOW + 60_000).toISOString() },
      { allowed: false, code: 'installation_step_up_required' },
    ],
    [
      'suspended owner on loopback',
      { trustedLoopback: true, ownerMemberStatus: 'suspended' as const },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'owner whose profile is missing',
      { mode: 'read' as const, ownerMemberStatus: null },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'another member (approver) on loopback',
      {
        trustedLoopback: true,
        principal: principal({ actor: humanActor('alice'), memberId: 'alice' }),
      },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'another member reading',
      {
        mode: 'read' as const,
        principal: principal({ actor: humanActor('bob'), memberId: 'bob' }),
      },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'an env localadmin token (service actor)',
      {
        trustedLoopback: true,
        principal: principal({
          actor: serviceActor('env-localadmin-token'),
          source: 'token',
          provider: 'env-token',
          assurance: 'low',
          memberId: undefined,
        }),
      },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'an agent acting for the owner',
      {
        trustedLoopback: true,
        principal: principal({
          actor: agentActor('kyberion://agent/default/assistant'),
          source: 'agent',
          provider: 'agent-token',
        }),
      },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'a principal claiming memberId owner with another actor',
      { mode: 'read' as const, principal: principal({ actor: humanActor('mallory') }) },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'a readonly credential bound to the owner member',
      { mode: 'read' as const, trustedLoopback: true, principal: principal({ role: 'readonly' }) },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'an owner principal with no assurance',
      { mode: 'read' as const, principal: principal({ assurance: 'none' }) },
      { allowed: false, status: 403, code: 'installation_owner_required' },
    ],
    [
      'an expired owner credential',
      {
        trustedLoopback: true,
        principal: principal({ expiresAt: new Date(NOW - 1).toISOString() }),
      },
      { allowed: false, status: 401, code: 'authentication_required' },
    ],
    [
      'anonymous loopback during bootstrap',
      { principal: anonymousLoopback, trustedLoopback: true, bootstrapOpen: true },
      { allowed: true, basis: 'bootstrap_loopback', actorId: ANONYMOUS_LOOPBACK_PRINCIPAL_ID },
    ],
    [
      'no principal at all on loopback during bootstrap',
      { principal: null, trustedLoopback: true, bootstrapOpen: true },
      { allowed: true, basis: 'bootstrap_loopback' },
    ],
    [
      'anonymous loopback after the owner is bound',
      { principal: anonymousLoopback, trustedLoopback: true },
      { allowed: false, status: 401, code: 'authentication_required' },
    ],
    [
      'anonymous loopback with the escape hatch on',
      { principal: anonymousLoopback, trustedLoopback: true, anonymousLoopbackOverride: true },
      { allowed: true, basis: 'anonymous_loopback_override' },
    ],
    [
      'anonymous remote request even during bootstrap',
      { principal: null, trustedLoopback: false, bootstrapOpen: true },
      { allowed: false, status: 401, code: 'authentication_required' },
    ],
    [
      'anonymous remote request with the escape hatch on',
      { principal: null, trustedLoopback: false, anonymousLoopbackOverride: true },
      { allowed: false, status: 401, code: 'authentication_required' },
    ],
  ])('%s', (_label, overrides, expected) => {
    expect(evaluateInstallationOwnerAccess(facts(overrides))).toMatchObject(expected);
  });
});

describe('installation-owner evidence gathering', () => {
  const RP: WebAuthnRelyingParty = {
    rpId: 'localhost',
    origin: 'http://localhost:3050',
    rpName: 'Kyberion',
  };
  let root = '';
  let store: { rootDir: string };
  let authenticator: TestAuthenticator;
  let counter = 1;
  let savedPersona: string | undefined;
  let savedRole: string | undefined;

  function writeOwner(patch: Partial<MemberProfile> = {}) {
    withExecutionContext('sovereign_concierge', () =>
      writeMemberProfile(
        {
          member_id: 'owner',
          display_name: 'Owner',
          status: 'active',
          memberships: [{ tenant_slug: 'default', role: 'owner' }],
          access_registrations: [],
          created_at: new Date(NOW).toISOString(),
          updated_at: new Date(NOW).toISOString(),
          ...patch,
        } as MemberProfile,
        { rootDir: root }
      )
    );
  }

  async function confirmInstallation(binding: string, at: Date) {
    return withExecutionContext('sovereign_concierge', async () => {
      const options = await createPasskeyStepUpOptions({
        memberId: 'owner',
        purpose: 'installation',
        rp: RP,
        store,
        now: at,
      });
      const confirmed = await verifyPasskeyStepUp({
        memberId: 'owner',
        rp: RP,
        store,
        now: at,
        response: authenticator.assert({
          challenge: options.challenge,
          origin: RP.origin,
          rpId: RP.rpId,
          counter: counter++,
        }),
      });
      expect(confirmed.purpose).toBe('installation');
      return recordInstallationStepUp(
        'owner',
        { sessionBinding: binding, stepUpToken: confirmed.stepUpToken, now: at },
        store
      );
    });
  }

  beforeAll(async () => {
    savedPersona = process.env.KYBERION_BASE_ROLE;
    savedRole = process.env.MISSION_ROLE;
    process.env.KYBERION_BASE_ROLE = 'ecosystem_architect';
    process.env.MISSION_ROLE = 'mission_controller';
    root = path.join(
      pathResolver.rootDir(),
      'active',
      'shared',
      'tmp',
      `installation-owner-${randomUUID()}`
    );
    store = { rootDir: root };
    authenticator = createTestAuthenticator();
    const enrolledAt = new Date(NOW - 48 * 3_600_000);
    await withExecutionContext('sovereign_concierge', async () => {
      const creation = await createPasskeyRegistrationOptions({
        memberId: 'owner',
        displayName: 'Owner',
        rp: RP,
        store,
        now: enrolledAt,
      });
      await verifyPasskeyRegistration({
        memberId: 'owner',
        response: authenticator.register({
          challenge: creation.challenge,
          origin: RP.origin,
          rpId: RP.rpId,
        }),
        rp: RP,
        label: 'Laptop',
        cooldownHours: 1,
        store,
        now: enrolledAt,
      });
    });
  });

  afterAll(() => {
    safeRmSync(root, { recursive: true, force: true });
    if (savedPersona === undefined) delete process.env.KYBERION_BASE_ROLE;
    else process.env.KYBERION_BASE_ROLE = savedPersona;
    if (savedRole === undefined) delete process.env.MISSION_ROLE;
    else process.env.MISSION_ROLE = savedRole;
  });

  beforeEach(() => {
    secretStore.clear();
    resetInstallationBootstrapCache();
    writeOwner();
  });

  const resolve = (
    request: Parameters<typeof resolveInstallationOwnerAccess>[0],
    over: Partial<Parameters<typeof resolveInstallationOwnerAccess>[1]> = {}
  ) => resolveInstallationOwnerAccess(request, { rootDir: root, now: NOW, env: {}, ...over });

  it('admits a remote owner write only with this session’s fresh passkey step-up', async () => {
    const owner = principal();
    expect(
      resolve({ mode: 'write', principal: owner, trustedLoopback: false, sessionBinding: 'sess-a' })
    ).toMatchObject({ allowed: false, code: 'installation_step_up_required' });

    const recorded = await confirmInstallation('sess-a', new Date(NOW - 30_000));
    expect(Date.parse(recorded.expiresAt) - Date.parse(recorded.verifiedAt)).toBe(
      INSTALLATION_STEP_UP_WINDOW_MS
    );
    const granted = resolve({
      mode: 'write',
      principal: owner,
      trustedLoopback: false,
      sessionBinding: 'sess-a',
    });
    expect(granted).toMatchObject({ allowed: true, stepUp: true, transport: 'remote' });
    expect(isIssuedInstallationOwnerGrant(granted, 'write')).toBe(true);

    // Another session of the same member cannot use it.
    expect(
      resolve({ mode: 'write', principal: owner, trustedLoopback: false, sessionBinding: 'sess-b' })
    ).toMatchObject({ allowed: false, code: 'installation_step_up_required' });
    // It lapses after the window.
    expect(
      resolve(
        { mode: 'write', principal: owner, trustedLoopback: false, sessionBinding: 'sess-a' },
        { now: NOW + INSTALLATION_STEP_UP_WINDOW_MS }
      )
    ).toMatchObject({ allowed: false, code: 'installation_step_up_required' });
  });

  it('refuses to record a step-up confirmed for another purpose', async () => {
    const at = new Date(NOW);
    await withExecutionContext('sovereign_concierge', async () => {
      const options = await createPasskeyStepUpOptions({
        memberId: 'owner',
        purpose: 'enroll',
        rp: RP,
        store,
        now: at,
      });
      const confirmed = await verifyPasskeyStepUp({
        memberId: 'owner',
        rp: RP,
        store,
        now: at,
        response: authenticator.assert({
          challenge: options.challenge,
          origin: RP.origin,
          rpId: RP.rpId,
          counter: counter++,
        }),
      });
      expect(() =>
        recordInstallationStepUp(
          'owner',
          { sessionBinding: 'sess-c', stepUpToken: confirmed.stepUpToken, now: at },
          store
        )
      ).toThrow(/POLICY_VIOLATION/);
      expect(readFreshInstallationStepUp('owner', 'sess-c', { now: at }, store)).toBeNull();
    });
  });

  it('denies a suspended owner even on loopback', () => {
    writeOwner({ status: 'suspended' });
    expect(resolve({ mode: 'write', principal: principal(), trustedLoopback: true })).toMatchObject(
      { allowed: false, code: 'installation_owner_required' }
    );
  });

  it('opens anonymous loopback only during bootstrap, then needs the escape hatch', () => {
    // Bootstrap: first-run unclaimed and the owner cannot sign in yet.
    expect(installationBootstrapOpen({ rootDir: root, now: NOW })).toBe(true);
    expect(
      resolve({ mode: 'write', principal: anonymousLoopback, trustedLoopback: true })
    ).toMatchObject({ allowed: true, basis: 'bootstrap_loopback' });

    // The owner binds an IdP identity — bootstrap closes.
    writeOwner({ external_identities: [{ issuer: 'http://localhost:9099', subject: 'dev-user' }] });
    resetInstallationBootstrapCache();
    expect(installationBootstrapOpen({ rootDir: root, now: NOW })).toBe(false);
    expect(anonymousLoopbackAllowed({ rootDir: root, now: NOW, env: {} })).toBe(false);
    expect(
      resolve({ mode: 'read', principal: anonymousLoopback, trustedLoopback: true })
    ).toMatchObject({ allowed: false, status: 401, code: 'authentication_required' });

    const env = { [INSTALLATION_ANONYMOUS_LOOPBACK_ENV]: '1' };
    expect(anonymousLoopbackAllowed({ rootDir: root, now: NOW, env })).toBe(true);
    expect(
      resolve({ mode: 'write', principal: anonymousLoopback, trustedLoopback: true }, { env })
    ).toMatchObject({ allowed: true, basis: 'anonymous_loopback_override' });
    // The escape hatch never reaches a remote peer.
    expect(
      resolve({ mode: 'read', principal: null, trustedLoopback: false }, { env })
    ).toMatchObject({ allowed: false, status: 401 });
  });

  it('closes bootstrap for an owner credential without memberships, and keeps it closed', () => {
    writeOwner({ memberships: [] });
    expect(installationBootstrapOpen({ rootDir: root, now: NOW })).toBe(true);
    // A token issued outside the first-run claim (no claimed_at). No cache
    // reset: the member write itself invalidates the bootstrap probe.
    writeOwner({ memberships: [], access_registrations: [{ label: 'owner-side-token' }] });
    expect(installationBootstrapOpen({ rootDir: root, now: NOW })).toBe(false);
    expect(secretStore.get('kyberion-first-run')?.bootstrap_closed_at).toBeTruthy();
    // Revoking the owner's last credential never re-opens it.
    writeOwner({ memberships: [], access_registrations: [] });
    expect(installationBootstrapOpen({ rootDir: root, now: NOW })).toBe(false);
    expect(
      resolve({ mode: 'read', principal: anonymousLoopback, trustedLoopback: true })
    ).toMatchObject({ allowed: false, status: 401 });
  });

  it('re-probes bootstrap immediately after a credential write (no stale cache)', () => {
    expect(installationBootstrapOpen({ rootDir: root, now: NOW })).toBe(true);
    writeOwner({ external_identities: [{ issuer: 'http://localhost:9099', subject: 'dev-user' }] });
    // Same `now`, well inside the 5 s cache window.
    expect(installationBootstrapOpen({ rootDir: root, now: NOW })).toBe(false);
  });

  it('closes bootstrap once first-run setup is claimed', () => {
    secretStore.set('kyberion-first-run', { claimed_at: new Date(NOW).toISOString() });
    expect(installationBootstrapOpen({ rootDir: root, now: NOW })).toBe(false);
  });

  it('never accepts a copied grant as issued', () => {
    const granted = resolve({ mode: 'write', principal: principal(), trustedLoopback: true });
    expect(isIssuedInstallationOwnerGrant(granted, 'write')).toBe(true);
    expect(isIssuedInstallationOwnerGrant({ ...granted }, 'read')).toBe(false);
    const read = resolve({ mode: 'read', principal: principal(), trustedLoopback: false });
    expect(isIssuedInstallationOwnerGrant(read, 'read')).toBe(true);
    expect(isIssuedInstallationOwnerGrant(read, 'write')).toBe(false);
  });

  it('reports an audit failure so the caller can fail closed', () => {
    const granted = resolve({ mode: 'write', principal: principal(), trustedLoopback: true });
    expect(
      recordInstallationAccessAudit(
        { surface: 'concierge', operation: 'setup update', decision: granted },
        () => {
          throw new Error('audit chain unwritable');
        }
      )
    ).toBe(false);
  });

  it('audits actor, transport and step-up of an installation write', () => {
    const recorder = vi.fn();
    const granted = resolve({ mode: 'write', principal: principal(), trustedLoopback: true });
    recordInstallationAccessAudit(
      { surface: 'concierge', operation: 'services.operator.propose', decision: granted },
      recorder
    );
    expect(recorder).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'user:owner',
        action: 'installation_scope_write',
        operation: 'services.operator.propose',
        result: 'allowed',
        metadata: expect.objectContaining({
          transport: 'loopback',
          step_up: false,
          basis: 'installation_owner',
        }),
      })
    );
  });
});
