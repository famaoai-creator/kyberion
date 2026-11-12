import { afterEach, describe, expect, it, vi } from 'vitest';

const registry = vi.hoisted(() => ({
  slugs: ['tenant-other'] as string[],
  unreadable: false,
}));
vi.mock('@agent/core/organization/tenant-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/organization/tenant-registry')>()),
  listTenantProfileSlugs: () => {
    if (registry.unreadable) throw new Error('registry unreadable');
    return registry.slugs;
  },
}));
import {
  PresenceStudioViewerError,
  parsePresenceStudioAgentIdentity,
  parsePresenceStudioSovereignIdentity,
  presenceStudioDemoFrameSchema,
  presenceStudioMinutesSessionStartSchema,
  presenceStudioVoiceStopSchema,
  requirePresenceStudioLocalAdmin,
  resolvePresenceStudioViewerContext,
  presenceStudioRecordInScope,
} from './security.js';

function request(remoteAddress: string, authorization?: string) {
  return {
    socket: { remoteAddress },
    headers: authorization ? { authorization } : {},
  } as never;
}

describe('Presence Studio OS viewer scope', () => {
  it('uses the shared exact person admission for a tenant-bound owner', () => {
    const owner = { principalId: 'alice', tenantSlugs: ['acme'], source: 'token' as const };
    expect(presenceStudioRecordInScope(owner, { scope: { nhi_id: 'alice' } })).toBe(true);
    expect(presenceStudioRecordInScope(owner, { scope: { nhi_id: 'bob' } })).toBe(false);
    expect(presenceStudioRecordInScope({ ...owner, tenantSlugs: 'all' }, { nhi_id: '' })).toBe(
      false
    );
    expect(presenceStudioRecordInScope(owner, { owner_nhi: 'alice', nhi_id: 'bob' })).toBe(false);
  });
  it('keeps the server tier ceiling independent of exact owner custody', () => {
    const remote = { principalId: 'alice', tenantSlugs: ['acme'], source: 'token' as const };
    const local = { ...remote, source: 'loopback' as const };
    for (const record of [
      { nhi_id: 'alice', tier: 'personal' },
      { scope: { nhi_id: 'alice', tier: 'personal' } },
      { nhi_id: 'alice', metadata: { tier: 'personal' } },
    ]) {
      expect(presenceStudioRecordInScope(remote, record)).toBe(false);
      expect(presenceStudioRecordInScope(local, record)).toBe(true);
    }
    expect(presenceStudioRecordInScope(remote, { nhi_id: 'alice' })).toBe(true);
    for (const record of [
      { nhi_id: 'alice', tier: 'public', scope: { tier: 'personal' } },
      { nhi_id: 'alice', metadata: { tier: 123 } },
      { nhi_id: 'alice', scope_context: { tier: 'unknown' } },
    ])
      expect(presenceStudioRecordInScope(local, record)).toBe(false);
    expect(presenceStudioRecordInScope(local, { nhi_id: 'bob', tier: 'personal' })).toBe(false);
    expect(
      presenceStudioRecordInScope(
        { ...local, organizationIds: ['org-a'] },
        { nhi_id: 'alice', tier: 'personal', organization_id: 'org-b' }
      )
    ).toBe(false);
  });
  afterEach(() => {
    registry.slugs = ['tenant-other'];
    registry.unreadable = false;
    vi.unstubAllEnvs();
  });

  it('treats loopback as a server-derived local human scope', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-local');

    expect(resolvePresenceStudioViewerContext(request('127.0.0.1'))).toEqual({
      principalId: 'human:presence-studio-localadmin',
      tenantSlugs: ['tenant-local'],
      source: 'loopback',
      principal: expect.objectContaining({ provider: 'loopback-local', role: 'localadmin' }),
      loopbackDefaultTenant: 'tenant-local',
    });
  });

  it('FD-01: lets the loopback owner narrow to another tenant with ?tenant=, keeping the server tenant as the default', () => {
    vi.stubEnv('KYBERION_TENANT', 'tenant-local');
    const req = request('127.0.0.1') as unknown as { query?: Record<string, string> };
    req.query = { tenant: 'tenant-other' };
    expect(resolvePresenceStudioViewerContext(req as never)).toMatchObject({
      tenantSlugs: ['tenant-other'],
      source: 'loopback',
      loopbackDefaultTenant: 'tenant-local',
    });
    req.query = { tenant: '../escape' };
    expect(resolvePresenceStudioViewerContext(req as never).tenantSlugs).toEqual(['tenant-local']);
  });

  it('refuses a loopback tenant hint that names no registered tenant', () => {
    const req = request('127.0.0.1') as unknown as {
      query?: Record<string, string>;
      headers: Record<string, string>;
    };
    const refusal = (): PresenceStudioViewerError => {
      try {
        resolvePresenceStudioViewerContext(req as never);
      } catch (error) {
        return error as PresenceStudioViewerError;
      }
      throw new Error('expected the viewer to be refused');
    };

    // No server tenant: an unregistered slug would otherwise become the scope.
    req.query = { tenant: 'tenant-ghost' };
    expect(refusal()).toBeInstanceOf(PresenceStudioViewerError);
    expect(refusal()).toMatchObject({
      status: 403,
      message: "Tenant 'tenant-ghost' is not a registered tenant.",
    });
    req.query = {};
    req.headers = { 'x-kyberion-tenant': 'tenant-ghost' };
    expect(refusal().status).toBe(403);

    // An unreadable registry confirms nothing.
    req.headers = {};
    req.query = { tenant: 'tenant-other' };
    registry.unreadable = true;
    expect(refusal().status).toBe(403);
  });

  it('keeps registered hints, the server default tenant and the no-hint view working', () => {
    const req = request('127.0.0.1') as unknown as { query?: Record<string, string> };

    // No hint, no server tenant: the all-tenant owner, without a registry read.
    registry.unreadable = true;
    expect(resolvePresenceStudioViewerContext(req as never).tenantSlugs).toBe('all');
    registry.unreadable = false;

    req.query = { tenant: 'tenant-other' };
    expect(resolvePresenceStudioViewerContext(req as never).tenantSlugs).toEqual(['tenant-other']);

    // The server's default tenant is the no-hint view even when unregistered.
    vi.stubEnv('KYBERION_TENANT', 'tenant-local');
    req.query = { tenant: 'tenant-local' };
    expect(resolvePresenceStudioViewerContext(req as never).tenantSlugs).toEqual(['tenant-local']);
  });

  it('lets /api/me drop an unregistered hint instead of refusing, never adopting it', () => {
    const req = request('127.0.0.1') as unknown as { query?: Record<string, string> };
    req.query = { tenant: 'tenant-ghost' };
    const ignore = { unregisteredTenantHint: 'ignore' } as const;

    expect(resolvePresenceStudioViewerContext(req as never, ignore).tenantSlugs).toBe('all');
    vi.stubEnv('KYBERION_TENANT', 'tenant-local');
    expect(resolvePresenceStudioViewerContext(req as never, ignore).tenantSlugs).toEqual([
      'tenant-local',
    ]);
  });

  it('requires a bearer token and server tenant scope for remote access', () => {
    vi.stubEnv('PRESENCE_STUDIO_ALLOW_REMOTE', 'true');
    vi.stubEnv('PRESENCE_STUDIO_TOKEN', 'presence-token');

    expect(() => resolvePresenceStudioViewerContext(request('198.51.100.24'))).toThrow(
      PresenceStudioViewerError
    );
    expect(() =>
      resolvePresenceStudioViewerContext(request('198.51.100.24', 'Bearer presence-token'))
    ).toThrow(/server-side KYBERION_TENANT/);

    vi.stubEnv('KYBERION_TENANT', 'tenant-remote');
    expect(
      resolvePresenceStudioViewerContext(request('198.51.100.24', 'Bearer presence-token'))
    ).toEqual({
      principalId: 'human:presence-studio-token',
      tenantSlugs: ['tenant-remote'],
      source: 'token',
      principal: expect.objectContaining({ provider: 'env-token', role: 'readonly' }),
    });
  });

  it('denies held-action mutations for readonly token viewers', () => {
    expect(() =>
      requirePresenceStudioLocalAdmin({
        principalId: 'human:presence-studio-token',
        tenantSlugs: ['tenant-remote'],
        source: 'token',
      })
    ).toThrow(/localadmin/);
    expect(() =>
      requirePresenceStudioLocalAdmin({
        principalId: 'human:presence-studio-localadmin',
        tenantSlugs: ['tenant-local'],
        source: 'loopback',
      })
    ).not.toThrow();
  });

  it('rejects ambiguous minutes and voice-stop request bodies before side effects', () => {
    expect(
      presenceStudioMinutesSessionStartSchema.safeParse({
        missionId: ['MSN-1'],
      }).success
    ).toBe(false);
    expect(
      presenceStudioMinutesSessionStartSchema.safeParse({
        missionId: 'MSN-1',
        unexpected: true,
      }).success
    ).toBe(false);
    expect(
      presenceStudioMinutesSessionStartSchema.parse({
        missionId: ' MSN-1 ',
        title: ' Weekly sync ',
      })
    ).toEqual({ missionId: 'MSN-1', title: 'Weekly sync' });

    expect(presenceStudioVoiceStopSchema.safeParse({ reason: { value: 'stop' } }).success).toBe(
      false
    );
    expect(presenceStudioVoiceStopSchema.safeParse({ unexpected: true }).success).toBe(false);
    expect(presenceStudioVoiceStopSchema.parse({ reason: ' manual ' })).toEqual({
      reason: 'manual',
    });
    expect(presenceStudioVoiceStopSchema.parse(undefined)).toEqual({});

    expect(
      presenceStudioDemoFrameSchema.safeParse({
        transcript: [{ speaker: 'AI', text: 'ok', extra: true }],
      }).success
    ).toBe(false);
    expect(presenceStudioDemoFrameSchema.safeParse({ expression: ['joy'] }).success).toBe(false);
    expect(
      presenceStudioDemoFrameSchema.parse({
        title: ' Demo ',
        transcript: [{ speaker: ' AI ', text: ' Hello ' }],
      })
    ).toEqual({ title: 'Demo', transcript: [{ speaker: 'AI', text: 'Hello' }] });
    expect(presenceStudioDemoFrameSchema.parse(undefined)).toEqual({});
  });

  it('parses identity files through a display-only field contract', () => {
    expect(parsePresenceStudioSovereignIdentity({ name: ' Operator ', extra: true })).toEqual({
      name: 'Operator',
    });
    expect(parsePresenceStudioAgentIdentity({ agent_id: 'agent-1', trust_tier: 'T2' })).toEqual({
      agent_id: 'agent-1',
      trust_tier: 'T2',
    });
    expect(parsePresenceStudioSovereignIdentity({ name: 42 })).toBeNull();
    expect(parsePresenceStudioAgentIdentity({ agent_id: ['agent-1'] })).toBeNull();
    expect(parsePresenceStudioSovereignIdentity(['Operator'])).toBeNull();
  });
});
