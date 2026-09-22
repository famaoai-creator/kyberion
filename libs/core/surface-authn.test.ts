import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  authorizeSurfaceContextOperation,
  principalFromSurfaceAuthorizationContext,
  resolveAuthnSurfaceViewerScope,
} from './surface-authn.js';

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

const TMP_DIR = `active/shared/tmp/surface-authn-tests-${process.pid}`;
let memberFixtureCounter = 0;

function writeMemberFixture(
  memberId: string,
  status: 'active' | 'suspended',
  registrationLabels: string[] = []
): string {
  const root = pathResolver.rootResolve(`${TMP_DIR}/members-${++memberFixtureCounter}`);
  const dir = `${root}/knowledge/personal/members`;
  safeMkdir(dir, { recursive: true });
  safeWriteFile(
    `${dir}/${memberId}.json`,
    JSON.stringify(
      {
        member_id: memberId,
        display_name: memberId,
        status,
        memberships: [{ tenant_slug: 'default', role: 'owner' }],
        access_registrations: registrationLabels.map((label) => ({ label })),
        created_at: '2026-09-23T00:00:00.000Z',
        updated_at: '2026-09-23T00:00:00.000Z',
      },
      null,
      2
    )
  );
  return root;
}

afterAll(() => {
  safeRmSync(pathResolver.rootResolve(TMP_DIR), { recursive: true, force: true });
});

const originalApiToken = process.env.KYBERION_API_TOKEN;
const originalAdminToken = process.env.KYBERION_LOCALADMIN_TOKEN;

afterEach(() => {
  if (originalApiToken === undefined) delete process.env.KYBERION_API_TOKEN;
  else process.env.KYBERION_API_TOKEN = originalApiToken;
  if (originalAdminToken === undefined) delete process.env.KYBERION_LOCALADMIN_TOKEN;
  else process.env.KYBERION_LOCALADMIN_TOKEN = originalAdminToken;
});

describe('resolveAuthnSurfaceViewerScope', () => {
  it('resolves an adapter-proven loopback request through the seam', () => {
    const resolution = resolveAuthnSurfaceViewerScope({
      local: true,
      allowLoopback: true,
      loopbackRole: 'localadmin',
      serverTenant: 'tenant-a',
      principalIds: { localadmin: 'human:presence-studio-localadmin' },
    });
    expect(resolution.decision.provider_id).toBe('loopback-local');
    expect(resolution.scope).toMatchObject({
      role: 'localadmin',
      // loopbackUsesServerTenant unset → the legacy all-tenant boundary holds
      tenantSlugs: 'all',
      source: 'loopback',
      principalId: 'human:presence-studio-localadmin',
    });
    expect(resolution.principal.provider).toBe('loopback-local');
  });

  it('binds loopback scope to the server tenant only when the adapter opts in', () => {
    const resolution = resolveAuthnSurfaceViewerScope({
      local: true,
      allowLoopback: true,
      loopbackRole: 'localadmin',
      loopbackUsesServerTenant: true,
      serverTenant: 'tenant-a',
    });
    expect(resolution.scope.tenantSlugs).toEqual(['tenant-a']);
  });

  it('accepts surface-configured credentials through the env-token provider', () => {
    const resolution = resolveAuthnSurfaceViewerScope({
      token: 'presence-token',
      configuredCredentials: [{ token: 'presence-token', role: 'readonly' }],
      serverTenant: 'tenant-remote',
      principalIds: { readonly: 'human:presence-studio-token' },
    });
    expect(resolution.decision.provider_id).toBe('env-token');
    expect(resolution.scope).toMatchObject({
      role: 'readonly',
      tenantSlugs: ['tenant-remote'],
      source: 'token',
      principalId: 'human:presence-studio-token',
    });
  });

  it('keeps KYBERION_* env tokens ahead of surface-configured credentials', () => {
    const resolution = resolveAuthnSurfaceViewerScope({
      token: 'admin-token',
      localadminToken: 'admin-token',
      configuredCredentials: [{ token: 'admin-token', role: 'readonly' }],
      serverTenant: 'tenant-a',
    });
    expect(resolution.scope.role).toBe('localadmin');
  });

  it('never lets ambient KYBERION_* env authenticate a surface that did not opt in', () => {
    process.env.KYBERION_API_TOKEN = 'ambient-token';
    expect(() => resolveAuthnSurfaceViewerScope({ token: 'ambient-token' })).toThrow(
      'Unknown viewer token'
    );
  });

  it('requires server-side tenant scope for remote env credentials', () => {
    expect(() =>
      resolveAuthnSurfaceViewerScope({ token: 'api-token', apiToken: 'api-token' })
    ).toThrow('Remote viewer access requires server-side tenant scope');
  });

  it('maps unresolvable credentials and absent principals to the legacy errors', () => {
    expect(() => resolveAuthnSurfaceViewerScope({ token: 'nope' })).toThrow('Unknown viewer token');
    expect(() => resolveAuthnSurfaceViewerScope({})).toThrow('A viewer principal is required.');
  });

  it('preserves registration scope, label, and member id', () => {
    const memberRoot = writeMemberFixture('member-1', 'active');
    const resolution = resolveAuthnSurfaceViewerScope({
      token: 'registered-token',
      registrations: [
        {
          token_hash: tokenHash('registered-token'),
          role: 'localadmin',
          tenant_slugs: ['tenant-a'],
          organization_ids: ['org-a'],
          label: 'registered viewer',
          member_id: 'member-1',
        },
      ],
      principalIds: { localadmin: 'should-not-apply' },
      deps: { memberRegistry: { rootDir: memberRoot } },
    });
    expect(resolution.decision.provider_id).toBe('registry-token');
    expect(resolution.scope).toMatchObject({
      role: 'localadmin',
      tenantSlugs: ['tenant-a'],
      organizationIds: ['org-a'],
      principalId: 'registered viewer',
      memberId: 'member-1',
    });
  });

  it('denies a registration bound to an unknown or suspended member', () => {
    const memberRoot = writeMemberFixture('member-1', 'suspended');
    for (const memberId of ['member-1', 'member-unknown']) {
      expect(() =>
        resolveAuthnSurfaceViewerScope({
          token: 'registered-token',
          registrations: [
            {
              token_hash: tokenHash('registered-token'),
              role: 'localadmin',
              tenant_slugs: ['tenant-a'],
              member_id: memberId,
            },
          ],
          deps: { memberRegistry: { rootDir: memberRoot } },
        })
      ).toThrow('bound to');
    }
  });

  it('rejects an unknown bearer even on a proven loopback request', () => {
    expect(() =>
      resolveAuthnSurfaceViewerScope({
        token: 'nope',
        local: true,
        allowLoopback: true,
        loopbackRole: 'localadmin',
      })
    ).toThrow('Unknown viewer token');
  });

  it('registrations: null disables registry self-load and keeps the legacy credential set', () => {
    expect(() =>
      resolveAuthnSurfaceViewerScope({
        token: 'registered-token',
        registrations: null,
        apiToken: 'api-token',
        serverTenant: 'tenant-a',
      })
    ).toThrow('Unknown viewer token');
  });

  it('a configured stub principal never authenticates a remote credential-free request', () => {
    // deps.env without VITEST simulates a served (non-test) process.
    expect(() =>
      resolveAuthnSurfaceViewerScope({
        deps: { env: { KYBERION_AUTHN_STUB_PRINCIPAL: 'stub:remote-user' } },
      })
    ).toThrow('A viewer principal is required.');
  });

  it('masks personal tier on the attached principal as well as the scope', () => {
    const masked = resolveAuthnSurfaceViewerScope({
      token: 'admin-token',
      localadminToken: 'admin-token',
      serverTenant: 'tenant-a',
      allowPersonalTier: false,
    });
    expect(masked.scope.tierAccess).toEqual(['confidential', 'public']);
    expect(masked.principal.tierAccess).toEqual(['confidential', 'public']);
  });

  it('masks personal tier and fails closed for registrations that requested it', () => {
    const masked = resolveAuthnSurfaceViewerScope({
      token: 'admin-token',
      localadminToken: 'admin-token',
      serverTenant: 'tenant-a',
      allowPersonalTier: false,
    });
    expect(masked.scope.tierAccess).toEqual(['confidential', 'public']);

    expect(() =>
      resolveAuthnSurfaceViewerScope({
        token: 'registered-token',
        registrations: [
          {
            token_hash: tokenHash('registered-token'),
            role: 'localadmin',
            tenant_slugs: ['tenant-a'],
            tier_access: ['personal'],
          },
        ],
        allowPersonalTier: false,
      })
    ).toThrow('viewer tier scope exceeds');
  });
});

describe('authorizeSurfaceContextOperation', () => {
  const localadminContext = {
    role: 'localadmin' as const,
    tenantSlugs: ['tenant-a'],
    organizationIds: 'all' as const,
    projectIds: 'all' as const,
    tierAccess: ['personal', 'confidential', 'public'],
  };

  it('allows an in-scope write for a localadmin viewer', () => {
    const decision = authorizeSurfaceContextOperation({
      context: localadminContext,
      operation: {
        operationId: 'front_desk.approve',
        effect: 'write',
        requiredPermissions: ['surface.headless.write'],
      },
      resource: { tenantSlug: 'tenant-a' },
      surface: 'presence-studio',
    });
    expect(decision.allowed).toBe(true);
    expect(decision.provider).toBe('role-scope');
  });

  it('denies a write for a readonly viewer and reports the deny reason', () => {
    const decision = authorizeSurfaceContextOperation({
      context: { ...localadminContext, role: 'readonly' },
      operation: {
        operationId: 'front_desk.approve',
        effect: 'write',
        requiredPermissions: ['surface.headless.write'],
      },
      resource: { tenantSlug: 'tenant-a' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('permission_denied');
  });

  it('denies resources outside the viewer tenant scope', () => {
    const decision = authorizeSurfaceContextOperation({
      context: localadminContext,
      operation: {
        operationId: 'front_desk.approve',
        effect: 'write',
        requiredPermissions: ['surface.headless.write'],
      },
      resource: { tenantSlug: 'tenant-b' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('tenant_scope_denied');
  });

  it('honors an explicit FD-07 permission replacement set through the seam', () => {
    // An approver-shaped context: localadmin role but only decision+read
    // permissions — headless.write must be denied exactly like the legacy path.
    const approverContext = {
      ...localadminContext,
      permissions: ['surface.headless.read', 'surface.decision.write'] as const,
    };
    const writeDecision = authorizeSurfaceContextOperation({
      context: approverContext,
      operation: {
        operationId: 'front_desk.approve',
        effect: 'write',
        requiredPermissions: ['surface.headless.write'],
      },
      resource: { tenantSlug: 'tenant-a' },
    });
    expect(writeDecision.allowed).toBe(false);
    expect(writeDecision.reasonCode).toBe('permission_denied');

    const readDecision = authorizeSurfaceContextOperation({
      context: approverContext,
      operation: {
        operationId: 'front_desk.read',
        effect: 'read',
        requiredPermissions: ['surface.headless.read'],
      },
      resource: { tenantSlug: 'tenant-a' },
    });
    expect(readDecision.allowed).toBe(true);
  });

  it('prefers the context principal over a synthesized one', () => {
    const { principal } = resolveAuthnSurfaceViewerScope({
      local: true,
      allowLoopback: true,
      loopbackRole: 'localadmin',
    });
    const decision = authorizeSurfaceContextOperation({
      context: { ...localadminContext, principal },
      operation: {
        operationId: 'front_desk.read',
        effect: 'read',
        requiredPermissions: ['surface.headless.read'],
      },
    });
    expect(decision.allowed).toBe(true);
  });

  it('fails closed when an explicit provider selection denies', () => {
    const decision = authorizeSurfaceContextOperation({
      context: localadminContext,
      operation: {
        operationId: 'front_desk.approve',
        effect: 'write',
        requiredPermissions: ['surface.headless.write'],
      },
      providerIds: ['deny-all'],
    });
    expect(decision.allowed).toBe(false);
    expect(decision.provider).toBe('deny-all');
  });
});

describe('principalFromSurfaceAuthorizationContext', () => {
  it('synthesizes a claims-only principal for legacy contexts', () => {
    const principal = principalFromSurfaceAuthorizationContext({
      role: 'readonly',
      tenantSlugs: ['tenant-a'],
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['public', 'confidential'],
      principalId: 'viewer-1',
      source: 'token',
    });
    expect(principal).toMatchObject({
      principalId: 'viewer-1',
      role: 'readonly',
      provider: 'surface-context',
      source: 'token',
      tenantSlugs: ['tenant-a'],
    });
    expect(principal.memberId).toBeUndefined();
  });

  it('carries a valid member id onto a human actor', () => {
    const principal = principalFromSurfaceAuthorizationContext({
      role: 'localadmin',
      tenantSlugs: 'all',
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['public'],
      memberId: 'member-1',
    });
    expect(principal.memberId).toBe('member-1');
    expect(principal.actor.kind).toBe('human');
  });
});
