import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { MemberProfile } from '@agent/core/organization/member-registry';
import type { HumanRequestRuntimeConfig } from '@agent/core/surface/human-request-runtime-config';
const state = vi.hoisted(() => ({
  members: [] as MemberProfile[],
  config: {} as HumanRequestRuntimeConfig,
  resolve: vi.fn(),
  audit: vi.fn(),
  run: vi.fn(),
  read: vi.fn(),
  result: vi.fn(),
  forge: false,
  configError: false,
  registryError: false,
}));
vi.mock('@agent/core/secret/secret-guard', () => ({
  secretGuard: { loadConnectionDocument: () => undefined },
}));
vi.mock('@agent/core/organization/member-registry', async (original) => ({
  ...(await original<typeof import('@agent/core/organization/member-registry')>()),
  findMemberByExternalIdentity: (issuer: string, subject: string) =>
    state.members.find(
      (m) =>
        m.status === 'active' &&
        m.external_identities?.some((b) => b.issuer === issuer && b.subject === subject)
    ) ?? null,
  externalIdentityBindingDenied: () => false,
  listMemberIdsStrict: () => {
    if (state.registryError) throw Error('private registry');
    return state.members.map((m) => m.member_id);
  },
  readMemberProfile: (id: string) => state.members.find((m) => m.member_id === id) ?? null,
}));
vi.mock('@agent/core/surface/human-request-runtime-config', () => ({
  loadHumanRequestRuntimeConfig: () => {
    if (state.configError) throw Error('private config path');
    return state.config;
  },
}));
vi.mock('@agent/core/governance/audit-chain', () => ({
  auditChain: {
    record: (event: { action: string }) => {
      if (event.action === 'browser_human_request') state.audit(event);
    },
  },
}));
vi.mock('../../../lib/viewer-context', async (original) => ({
  ...(await original<typeof import('../../../lib/viewer-context')>()),
  resolveConciergeViewer: state.resolve,
}));
vi.mock('@agent/core/surface/front-desk-request-service', () => ({
  runFrontDeskRequest: state.run,
}));
vi.mock('@agent/core/surface/front-desk-request-result', () => ({
  readFrontDeskRequest: state.result,
}));
vi.mock('@agent/core/surface/front-desk-conversation-store', async (original) => ({
  ...(await original<typeof import('@agent/core/surface/front-desk-conversation-store')>()),
  readConversationHistory: state.read,
}));
import { mintBrowserSessionToken } from '@agent/core/authn-providers';
import { resolveAuthnSurfaceViewerScope } from '@agent/core/surface/surface-authn';
import { conciergeCredential } from '../../../lib/viewer-context';
import { requireConciergeMutationAccess } from '../../../lib/api-guard';
import { GET, POST } from './route';
const NOW = Date.parse('2026-10-11T00:00:00Z');
const ISSUER = 'https://synthetic-issuer.example';
const ENV = { KYBERION_SESSION_SECRET: 'synthetic-browser-session-key-for-testing-only' };
const ID = '11111111-1111-4111-8111-111111111111';
function token() {
  return mintBrowserSessionToken(
    { idpIssuer: ISSUER, subject: 'alice-sub', ttlSeconds: 300 },
    { env: ENV, now: NOW }
  ).token;
}
function request(
  method = 'POST',
  headers: Record<string, string> = {},
  query = '',
  body: Record<string, unknown> = {}
) {
  return new NextRequest(
    'https://app.example/api/message' + (query ? query + '&tenant=alpha' : '?tenant=alpha'),
    {
      method,
      headers: {
        host: 'app.example',
        origin: 'https://app.example',
        cookie: 'kyberion_session=' + token(),
        'content-type': 'application/json',
        ...headers,
      },
      ...(method === 'POST'
        ? { body: JSON.stringify({ text: 'hello', requestId: ID, ...body }) }
        : {}),
    }
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  state.forge = false;
  state.configError = false;
  state.registryError = false;
  state.config = {
    version: 1,
    policy: {
      authorityNamespace: 'fixture',
      tenantSlugs: ['alpha'],
      organizationIds: ['org-a'],
      projectIds: ['project-a'],
      tierAccess: ['public'],
    },
    browser: {
      enabled: true,
      operationScopes: ['kyberion:requests:read', 'kyberion:requests:receive'],
    },
  };
  state.members = [
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
  state.resolve.mockImplementation((req: NextRequest) => {
    try {
      const { scope, principal } = resolveAuthnSurfaceViewerScope({
        token: conciergeCredential(req).token,
        local: false,
        providerIds: ['browser-session'],
        allowPersonalTier: false,
        deps: { env: ENV, now: NOW },
      });
      return { context: { ...scope, principal: state.forge ? { ...principal } : principal } };
    } catch {
      return { response: NextResponse.json({ ok: false, error: 'denied' }, { status: 403 }) };
    }
  });
  state.audit.mockImplementation(() => {});
  state.run.mockResolvedValue({ kind: 'replayed', reply: 'ok', requestId: ID });
  state.read.mockReturnValue({ messages: [] });
  state.result.mockReturnValue({ requestId: ID });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
describe('request-only browser identity route', () => {
  it('admits a signed same-origin operator with readonly flat role exactly once', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(state.resolve).toHaveBeenCalledOnce();
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'readonly',
        principalId: 'user:alice',
        tenantSlugs: ['alpha'],
        canonicalHuman: expect.objectContaining({ memberId: 'alice' }),
      }),
      expect.anything()
    );
    expect(state.audit).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'receive', tenantSlug: 'alpha' })
    );
    expect(state.audit.mock.invocationCallOrder[0]).toBeLessThan(
      state.run.mock.invocationCallOrder[0]
    );
  });
  it('denies cross-origin cookie mutation before authentication or work', async () => {
    expect((await POST(request('POST', { origin: 'https://evil.example' }))).status).toBe(403);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });
  it('keeps Authorization priority and rejects malformed explicit headers without cookie fallback', async () => {
    for (const authorization of ['Bearer invalid', 'Basic invalid', 'Bearer ']) {
      expect((await POST(request('POST', { authorization }))).status).toBe(403);
    }
    expect(state.run).not.toHaveBeenCalled();
    expect(GET(request('GET', { authorization: 'Basic invalid' })).status).toBe(403);
  });
  it('uses a valid header identity rather than the accompanying browser cookie', async () => {
    state.members.push({
      ...state.members[0],
      member_id: 'bob',
      external_identities: [{ issuer: ISSUER, subject: 'bob-sub' }],
    });
    const headerToken = mintBrowserSessionToken(
      { idpIssuer: ISSUER, subject: 'bob-sub', ttlSeconds: 300 },
      { env: ENV, now: NOW }
    ).token;
    expect((await POST(request('POST', { authorization: 'Bearer ' + headerToken }))).status).toBe(
      200
    );
    expect(state.run.mock.calls[0][0].canonicalHuman.memberId).toBe('bob');
    expect(state.resolve).toHaveBeenCalledOnce();
  });
  it('rejects a forged signed-session cookie before any canonical operation', async () => {
    const forged = token().slice(0, -4) + 'AAAA';
    expect((await POST(request('POST', { cookie: 'kyberion_session=' + forged }))).status).toBe(
      403
    );
    expect(state.run).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
  });
  it('does not accept a copied principal proof or fall back after registry failure', async () => {
    state.forge = true;
    expect((await POST(request())).status).toBe(403);
    state.forge = false;
    state.registryError = true;
    expect((await POST(request())).status).toBe(403);
    expect(state.run).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
  });
  it('preserves disabled localadmin gate and legacy history partition', async () => {
    state.config = { version: 1 };
    const response = await POST(request());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Concierge mutation requires a localadmin viewer.',
    });
    expect(GET(request('GET')).status).toBe(200);
    expect(state.read.mock.calls[0][0]).not.toHaveProperty('canonicalHuman');
    expect(state.audit).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });
  it('does not widen unrelated mutation guards', () => {
    const req = request();
    expect(conciergeCredential(req).source).toBe('session-cookie');
    expect(state.resolve(req).context.role).toBe('readonly');
    expect(requireConciergeMutationAccess(req)?.status).toBe(403);
  });
  it('audits result and history before reading', () => {
    expect(GET(request('GET')).status).toBe(200);
    expect(GET(request('GET', {}, '?requestId=' + ID)).status).toBe(200);
    expect(state.audit.mock.calls.map((call) => call[0].operation)).toEqual(['history', 'result']);
    expect(state.audit.mock.invocationCallOrder[0]).toBeLessThan(
      state.read.mock.invocationCallOrder[0]
    );
    expect(state.audit.mock.invocationCallOrder[1]).toBeLessThan(
      state.result.mock.invocationCallOrder[0]
    );
  });
  it('fails closed for all audit errors without exposing private details', async () => {
    state.audit.mockImplementation(() => {
      throw Error('private audit path');
    });
    const responses = [
      await POST(request()),
      GET(request('GET')),
      GET(request('GET', {}, '?requestId=' + ID)),
    ];
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(JSON.stringify(await response.json())).not.toContain('private');
    }
    expect(state.run).not.toHaveBeenCalled();
    expect(state.read).not.toHaveBeenCalled();
    expect(state.result).not.toHaveBeenCalled();
  });
  it('denies receive without membership permission and cannot widen tenant selection', async () => {
    state.members[0].memberships[0].role = 'viewer';
    expect((await POST(request())).status).toBe(403);
    expect(GET(request('GET')).status).toBe(200);
    expect((await POST(request('POST', {}, '', { tenant: 'beta' }))).status).toBe(403);
    expect(state.run).not.toHaveBeenCalled();
  });
  it('fails closed on configured runtime errors', async () => {
    state.configError = true;
    expect((await POST(request())).status).toBe(503);
    expect(GET(request('GET')).status).toBe(503);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.run).not.toHaveBeenCalled();
  });
});
