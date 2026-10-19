import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { ResolvedPrincipal } from '@agent/core/authn-principal-resolver';
import type { ConciergeViewerContext } from '../src/lib/viewer-context';
type RouteContext = ConciergeViewerContext & { principal: ResolvedPrincipal };
const state = vi.hoisted(() => ({
  source: 'header',
  token: 'synthetic',
  context: null as RouteContext | null,
  execute: vi.fn(async () => ({ ok: true, setup: { stage: 'registered' } })),
}));
vi.mock('@agent/core/organization/company-setup-workflow', () => ({
  executeCompanySetup: state.execute,
}));
vi.mock('../src/lib/api-guard', () => ({ requireConciergeMutationAccess: () => null }));
vi.mock('../src/lib/viewer-context', () => ({
  guardConciergeRequest: () => null,
  conciergeCredential: () => ({ source: state.source, token: state.token }),
  resolveConciergeViewer: () => ({ context: state.context }),
}));
import { GET, POST } from '../src/app/api/setup/company/route';
function context(): RouteContext {
  if (!state.context) throw new Error('Expected a viewer fixture');
  return state.context;
}
const principal = (): ResolvedPrincipal => ({
  principalId: 'fixture-owner',
  provider: 'fixture',
  actor: { kind: 'human', id: 'user:owner' },
  source: 'token',
  assurance: 'medium',
  memberId: 'owner',
  role: 'localadmin',
  tenantSlugs: ['acme'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential'],
});
beforeEach(() => {
  state.source = 'header';
  state.token = 'synthetic';
  state.context = {
    source: 'token',
    role: 'localadmin',
    memberId: 'owner',
    tenantSlugs: ['acme'],
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['confidential'],
    principal: principal(),
  };
  state.execute.mockClear();
  state.execute.mockResolvedValue({ ok: true, setup: { stage: 'registered' } });
});
const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(
    new NextRequest('http://localhost/api/setup/company', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost', ...headers },
      body: JSON.stringify(body),
    })
  );
describe('company setup HTTP authorization', () => {
  it('passes exact verified owner to the shared service', async () => {
    expect((await post({ action: 'probe', tenantSlug: 'acme' })).status).toBe(200);
    expect(state.execute).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'user:owner', tenantSlug: 'acme' }),
      { action: 'probe' },
      context().principal
    );
  });
  it.each(['anonymous', 'agent', 'loopback'] as const)('rejects %s principals', async (source) => {
    context().principal.source = source;
    if (source === 'agent')
      context().principal.actor = { kind: 'agent', id: 'kyberion://agent/acme/a' };
    expect((await post({ action: 'probe', tenantSlug: 'acme' })).status).toBe(403);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it('rejects a flat localadmin without a verified member', async () => {
    delete context().principal.memberId;
    expect((await post({ action: 'probe', tenantSlug: 'acme' })).status).toBe(403);
  });
  it('rejects expired credentials and other tenant selection', async () => {
    expect((await post({ action: 'probe', tenantSlug: 'other' })).status).toBe(403);
    context().principal.expiresAt = '2000-01-01T00:00:00Z';
    expect((await post({ action: 'probe', tenantSlug: 'acme' })).status).toBe(403);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it.each(['ownerId', 'rootDir', 'evidenceRef', 'accept', 'authenticated', 'force'])(
    'rejects client-controlled %s',
    async (field) => {
      expect(
        (
          await post({
            action: 'register_company',
            tenantSlug: 'acme',
            vertical: 'x',
            firstWork: 'y',
            reviewDigest: 'z',
            [field]: 'bad',
          })
        ).status
      ).toBe(400);
      expect(state.execute).not.toHaveBeenCalled();
    }
  );
  it('rejects fields belonging to another action and inherited operation names', async () => {
    expect((await post({ action: 'probe', tenantSlug: 'acme', requestId: 'x' })).status).toBe(400);
    expect((await post({ action: 'constructor', tenantSlug: 'acme' })).status).toBe(400);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it('rejects duplicate and unexpected query keys', async () => {
    expect(
      (await GET(new NextRequest('http://localhost/api/setup/company?tenant=acme&tenant=other')))
        .status
    ).toBe(400);
    expect(
      (await GET(new NextRequest('http://localhost/api/setup/company?rootDir=x'))).status
    ).toBe(400);
  });
  it('requires same-origin for cookie mutations', async () => {
    state.source = 'cookie';
    expect(
      (await post({ action: 'probe', tenantSlug: 'acme' }, { origin: 'https://attacker.example' }))
        .status
    ).toBe(403);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it('does not leak internal failures', async () => {
    state.execute.mockRejectedValueOnce(new Error('private path /secret/token and internal stack'));
    const r = await post({ action: 'probe', tenantSlug: 'acme' });
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await r.json())).not.toContain('/secret');
  });
});
