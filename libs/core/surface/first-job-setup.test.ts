import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { MemberProfile } from '../organization/member-registry.js';
import type { FirstJobSnapshot } from './first-job.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';

const state = vi.hoisted(() => ({
  profile: 'present',
  oidc: 'configured',
  member: null as MemberProfile | null,
  owner: null as MemberProfile | null,
  registryError: false,
  resolution: true,
  writes: vi.fn(),
  network: vi.fn(),
}));
vi.mock('../profile-root.js', () => ({ resolveActiveProfileRoot: () => '/fixture/profile' }));
vi.mock('../secure-io.js', async (original) => ({
  ...(await original<typeof import('../secure-io.js')>()),
  safeLstat: () => {
    if (state.profile === 'missing')
      throw Object.assign(new Error('private path'), { code: 'ENOENT' });
    if (state.profile === 'denied') throw new Error('[ROLE_VIOLATION] private profile');
    return {
      isFile: () => state.profile !== 'directory',
      isSymbolicLink: () => state.profile === 'symlink',
    };
  },
  assertSafeRepositoryPath: () => {
    if (state.profile === 'symlink') throw new Error('private symlink target');
    return '/fixture/profile/my-identity.json';
  },
  safeWriteFile: state.writes,
  safeMkdir: state.writes,
  safeExec: state.network,
  safeExecResult: state.network,
}));
vi.mock('./oidc-browser-login.js', () => ({
  resolveOidcLoginConfig: () => {
    if (state.oidc === 'unavailable') throw new Error('private issuer/client secret');
    return {
      config:
        state.oidc === 'configured'
          ? { clientSecret: 'private secret', issuer: 'private issuer' }
          : null,
    };
  },
}));
vi.mock('../organization/member-registry.js', async (original) => ({
  ...(await original<typeof import('../organization/member-registry.js')>()),
  findMemberByExternalIdentity: (issuer: string, subject: string) => {
    if (state.registryError) throw new Error('private member file');
    return issuer === 'https://fixture.invalid' && subject === 'idp-subject' ? state.member : null;
  },
  resolveMemberByPrincipal: () => {
    if (state.registryError) throw new Error('private owner file');
    return state.owner;
  },
  ensureOwnerMember: state.writes,
}));
vi.mock('./first-job.js', () => ({
  resolveFirstJobViewer: (viewer: SurfaceViewerScope) =>
    state.resolution ? { ready: true, viewer } : { ready: false, status: 'mapping_changed' },
}));
vi.mock('./front-desk-conversation-store.js', () => ({
  conversationRef: () => ({ sessionId: 'concierge-' + 'a'.repeat(64) }),
}));
import { mintBrowserSessionToken } from '../authn-providers.js';
import { readFirstJobSetup } from './first-job-setup.js';

const viewer: SurfaceViewerScope = {
  principalId: 'human:presence-studio-localadmin',
  source: 'loopback',
  role: 'localadmin',
  tenantSlugs: ['test-tenant'],
  organizationIds: ['org-a'],
  projectIds: ['project-a'],
  tierAccess: ['public'],
};
function snapshot(overrides: Partial<FirstJobSnapshot> = {}): FirstJobSnapshot {
  return {
    ok: true,
    readiness: { ready: true, status: 'diagnostic_mapping_ready' },
    sessionId: 'concierge-' + 'a'.repeat(64),
    messages: [],
    tasks: [],
    pending: 0,
    next_action: { kind: 'inspect_setup', href: '/first-job' },
    ...overrides,
  };
}
function member(id = 'owner', role = 'owner', tenant = 'test-tenant'): MemberProfile {
  return {
    member_id: id,
    status: 'active',
    memberships: [{ tenant_slug: tenant, role }],
  } as MemberProfile;
}
function token(subject = 'idp-subject') {
  return mintBrowserSessionToken({ idpIssuer: 'https://fixture.invalid', subject, ttlSeconds: 300 })
    .token;
}
function read(value = token(), data = snapshot()) {
  return readFirstJobSetup(viewer, value, data);
}
beforeEach(() => {
  vi.stubEnv('KYBERION_SESSION_SECRET', 'fixture-only-browser-session-key-over-32-bytes');
  state.profile = 'present';
  state.oidc = 'configured';
  state.registryError = false;
  state.resolution = true;
  state.owner = member();
  state.member = member();
  state.writes.mockClear();
  state.network.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe('first-job advisory setup projection', () => {
  it('separates local evidence from validation and performs no effects', () => {
    const result = read();
    expect(result.profile.status).toBe('present');
    expect(result.oidc.status).toBe('configured');
    expect(result.browser_user.status).toBe('verified');
    expect(result.approval_scope.status).toBe('ready');
    expect(result.baseline.status).toBe('unchecked');
    expect(result.reasoning.status).toBe('not_required');
    expect(result.advancement.status).toBe('not_started');
    expect(state.writes).not.toHaveBeenCalled();
    expect(state.network).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toMatch(
      /private|idp-subject|fixture.invalid|profile\/|member_id|clientSecret/
    );
  });
  it.each(['missing', 'denied', 'directory', 'symlink'])('distinguishes profile %s', (profile) => {
    state.profile = profile;
    expect(read().profile.status).toBe(profile === 'missing' ? 'missing' : 'unavailable');
    expect(read().approval_scope.status).toBe('ready');
  });
  it('shows independent login and profile blockers before a mapping exists', () => {
    state.profile = 'missing';
    state.oidc = 'missing';
    const result = read(
      '',
      snapshot({ readiness: { ready: false, status: 'mapping_missing' }, sessionId: undefined })
    );
    expect(result.profile.status).toBe('missing');
    expect(result.mapping.status).toBe('mapping_missing');
    expect(result.oidc.status).toBe('configuration_required');
    expect(result.browser_user.status).toBe('sign_in_required');
    expect(result.approval_scope.status).toBe('mapping_required');
  });
  it.each(['', 'generic-localadmin-token', 'kys1.invalid', 'user:owner'])(
    'never infers browser identity from %s',
    (value) => {
      expect(read(value).browser_user.status).toBe('sign_in_required');
      expect(read(value).approval_scope.status).toBe('authentication_required');
    }
  );
  it('does not interpret an IdP subject resembling a local member as a binding', () => {
    expect(read(token('user:owner')).browser_user.status).toBe('binding_required');
  });
  it('does not confuse successful sign-in with request ownership', () => {
    state.member = member('another-member');
    expect(read().browser_user.status).toBe('verified');
    expect(read().approval_scope.status).toBe('owner_mismatch');
  });
  it.each(['viewer', 'operator'])('denies target membership with role %s', (role) => {
    state.owner = member('owner', role);
    expect(read().approval_scope.status).toBe('tenant_membership_required');
  });
  it('requires the target tenant, not membership elsewhere', () => {
    state.owner = member('owner', 'owner', 'another-tenant');
    expect(read().approval_scope.status).toBe('tenant_membership_required');
  });
  it('accepts an exact active approver and refuses an inactive owner', () => {
    state.owner = member('owner', 'approver');
    expect(read().approval_scope.status).toBe('ready');
    state.owner.status = 'suspended';
    expect(read().approval_scope.status).toBe('owner_unavailable');
  });
  it('fails closed for registry or configuration errors and redacts the cause', () => {
    state.registryError = true;
    state.oidc = 'unavailable';
    const result = read();
    expect(result.browser_user.status).toBe('unavailable');
    expect(result.approval_scope.status).not.toBe('ready');
    expect(result.oidc.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('rechecks current mapping and session binding', () => {
    state.resolution = false;
    expect(read().approval_scope.status).toBe('mapping_required');
    state.resolution = true;
    expect(
      read(token(), snapshot({ sessionId: 'concierge-' + 'b'.repeat(64) })).approval_scope.status
    ).toBe('mapping_required');
  });
  it('clears verified identity on sign-out rather than caching it', () => {
    expect(read().browser_user.status).toBe('verified');
    expect(read('').browser_user.status).toBe('sign_in_required');
    state.member = null;
    expect(read().browser_user.status).toBe('binding_required');
  });
  it('does not claim an approval exists when the request only awaits a bounded tick', () => {
    const tasks = [
      { executionStatus: 'awaiting_approval', turnState: 'completed' },
    ] as FirstJobSnapshot['tasks'];
    expect(read(token(), snapshot({ tasks })).advancement.status).toBe('review_or_tick');
    tasks[0].executionStatus = 'blocked';
    expect(read(token(), snapshot({ tasks })).advancement.status).toBe('unavailable');
  });

  it('requires sign-in again after session expiry or verification-key rotation', () => {
    const expired = mintBrowserSessionToken(
      { idpIssuer: 'https://fixture.invalid', subject: 'idp-subject', ttlSeconds: 1 },
      { now: Date.now() - 60_000 }
    ).token;
    expect(read(expired).browser_user.status).toBe('sign_in_required');
    const prior = token();
    vi.stubEnv('KYBERION_SESSION_SECRET', 'rotated-fixture-key-longer-than-thirty-two-bytes');
    expect(read(prior).browser_user.status).toBe('sign_in_required');
    expect(read(prior).approval_scope.status).toBe('authentication_required');
  });
  it('keeps an already verified session separate from incomplete future login configuration', () => {
    state.oidc = 'missing';
    const result = read();
    expect(result.oidc.status).toBe('configuration_required');
    expect(result.browser_user.status).toBe('verified');
    expect(result.approval_scope.status).toBe('ready');
  });

  it('separates terminal recovery history from the active replacement', () => {
    const terminal = { executionStatus: 'terminated_unstarted', turnState: 'settled' };
    const queued = { executionStatus: 'queued', turnState: 'settled' };
    expect(
      read(token(), snapshot({ tasks: [terminal, queued] as FirstJobSnapshot['tasks'] }))
        .advancement.status
    ).toBe('review_or_tick');
    const verified = {
      executionStatus: 'work_completed',
      turnState: 'settled',
      artifact: { verification: 'verified' },
    };
    expect(
      read(token(), snapshot({ tasks: [terminal, verified] as FirstJobSnapshot['tasks'] }))
        .advancement.status
    ).toBe('receipt_verified');
    expect(
      read(token(), snapshot({ tasks: [terminal] as FirstJobSnapshot['tasks'] })).advancement.status
    ).toBe('not_started');
  });
});
