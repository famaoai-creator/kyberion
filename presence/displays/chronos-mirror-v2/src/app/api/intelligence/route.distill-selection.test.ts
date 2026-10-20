import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const state = vi.hoisted(() => ({ tenantSlugs: 'all' as string[] | 'all', handler: vi.fn() }));
vi.mock('../../../lib/api-guard', () => ({
  guardRequest: () => null,
  requireChronosAccess: () => null,
  getChronosAccessRoleOrThrow: () => 'localadmin',
}));
vi.mock('../../../lib/viewer-context', async (original) => ({
  ...(await original<typeof import('../../../lib/viewer-context')>()),
  resolveViewerContextForRequest: () => ({
    context: {
      role: 'localadmin',
      source: 'token',
      tenantSlugs: state.tenantSlugs,
      organizationIds: 'all',
      projectIds: 'all',
      tierAccess: ['public', 'confidential'],
    },
  }),
}));
vi.mock('./actions', () => ({
  INTELLIGENCE_ACTION_HANDLERS: { distill_candidate_decision: state.handler },
}));
import { POST } from './route';
function request(tenant: string, bodyTenant?: string) {
  return new NextRequest('http://localhost/api/intelligence?tenant=' + tenant, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'distill_candidate_decision',
      candidateId: 'DSC-DUPLICATE',
      decision: 'archive',
      ...(bodyTenant ? { tenant: bodyTenant } : {}),
    }),
  });
}
beforeEach(() => {
  state.tenantSlugs = 'all';
  vi.clearAllMocks();
  state.handler.mockImplementation((body) => NextResponse.json({ ok: true, tenant: body.tenant }));
});
describe('distill decision POST tenant selection', () => {
  it('passes query-only UI selection to the exact-scope handler', async () => {
    const result = await POST(request('acme'));
    expect(result.status).toBe(200);
    expect((await result.json()).tenant).toBe('acme');
    expect(state.handler.mock.calls[0][0].tenant).toBe('acme');
  });
  it('rejects contradictory selections without dispatch', async () => {
    expect((await POST(request('acme', 'beta'))).status).toBe(400);
    expect(state.handler).not.toHaveBeenCalled();
  });
  it('forbids query selection outside authenticated viewer scope', async () => {
    state.tenantSlugs = ['acme'];
    expect((await POST(request('beta'))).status).toBe(403);
    expect(state.handler).not.toHaveBeenCalled();
  });
});
