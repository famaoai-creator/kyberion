import { NextRequest, NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  guardConciergeRequest: vi.fn((): unknown => null),
  resolveConciergeViewerContext: vi.fn(),
  conciergeCredential: vi.fn(),
  requireConciergeMutationAccess: vi.fn((): unknown => null),
  consumeTenantBudget: vi.fn(() => ({ allowed: true })),
}));

vi.mock('../viewer-context', () => ({
  guardConciergeRequest: mocks.guardConciergeRequest,
  resolveConciergeViewerContext: mocks.resolveConciergeViewerContext,
  conciergeCredential: mocks.conciergeCredential,
}));
vi.mock('../api-guard', () => ({
  requireConciergeMutationAccess: mocks.requireConciergeMutationAccess,
}));
vi.mock('@agent/core/organization/tenant-rate-limiter', () => ({
  consumeTenantBudget: mocks.consumeTenantBudget,
}));

import { getOpsAccessRole, guardOpsRequest, requireOpsAccess } from './ops-request-guard';

function viewer(role: 'localadmin' | 'readonly', tenantSlugs: string[] | 'all' = ['acme']) {
  return {
    role,
    tenantSlugs,
    organizationIds: 'all',
    projectIds: 'all',
    tierAccess: ['public', 'confidential'],
    source: 'token',
  };
}

function request(method = 'GET', headers: Record<string, string> = {}) {
  return new NextRequest('http://127.0.0.1:3050/api/ops/workitems', { method, headers });
}

describe('operations request gates (Concierge viewer model)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.guardConciergeRequest.mockReturnValue(null);
    mocks.requireConciergeMutationAccess.mockReturnValue(null);
    mocks.consumeTenantBudget.mockReturnValue({ allowed: true });
    mocks.conciergeCredential.mockReturnValue({ token: 'opaque', source: 'header' });
  });

  it('401s when the Concierge viewer cannot be resolved', () => {
    mocks.resolveConciergeViewerContext.mockImplementation(() => {
      throw new Error('A Concierge viewer principal is required.');
    });
    expect(guardOpsRequest(request())?.status).toBe(401);
    expect(requireOpsAccess(request(), 'readonly')?.status).toBe(401);
    expect(() => getOpsAccessRole(request())).toThrow();
  });

  it('returns the Concierge rate-limit response before resolving the viewer', () => {
    mocks.guardConciergeRequest.mockReturnValue(NextResponse.json({}, { status: 429 }));
    expect(guardOpsRequest(request())?.status).toBe(429);
    expect(mocks.resolveConciergeViewerContext).not.toHaveBeenCalled();
  });

  it('charges a mutation to the tenant budget of a single-tenant viewer only', () => {
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('readonly', ['acme']));
    expect(guardOpsRequest(request('POST'))).toBeNull();
    expect(mocks.consumeTenantBudget).toHaveBeenCalledWith({
      op: 'surface:ops_request',
      tenantSlug: 'acme',
    });
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('localadmin', 'all'));
    expect(guardOpsRequest(request('POST'))).toBeNull();
    expect(mocks.consumeTenantBudget).toHaveBeenLastCalledWith({ op: 'surface:ops_request' });
  });

  it('429s a mutation once the tenant reasoning budget is spent', () => {
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('localadmin', ['acme']));
    mocks.consumeTenantBudget.mockReturnValue({ allowed: false, retry_after_ms: 1000 } as never);
    expect(guardOpsRequest(request('POST'))?.status).toBe(429);
  });

  it('never drains the tenant budget for safe reads, even when it is spent', () => {
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('readonly', ['acme']));
    mocks.consumeTenantBudget.mockReturnValue({ allowed: false, retry_after_ms: 1000 } as never);
    for (let i = 0; i < 100; i += 1) {
      expect(guardOpsRequest(request('GET'))).toBeNull();
    }
    expect(guardOpsRequest(request('HEAD'))).toBeNull();
    expect(mocks.consumeTenantBudget).not.toHaveBeenCalled();
    // Reads still pass the per-viewer Concierge read ceiling first.
    expect(mocks.guardConciergeRequest).toHaveBeenCalledTimes(101);
  });

  it('still 429s a read once the per-viewer read ceiling is exhausted', () => {
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('readonly', ['acme']));
    mocks.guardConciergeRequest.mockReturnValue(NextResponse.json({}, { status: 429 }));
    expect(guardOpsRequest(request('GET'))?.status).toBe(429);
    expect(mocks.consumeTenantBudget).not.toHaveBeenCalled();
  });

  it('lets a readonly viewer read but forbids localadmin-only actions', () => {
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('readonly'));
    expect(requireOpsAccess(request(), 'readonly')).toBeNull();
    expect(requireOpsAccess(request('POST'), 'localadmin')?.status).toBe(403);
    expect(mocks.requireConciergeMutationAccess).not.toHaveBeenCalled();
  });

  it('sends a localadmin mutation through the Concierge mutation gate', () => {
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('localadmin'));
    mocks.requireConciergeMutationAccess.mockReturnValue(
      NextResponse.json({ ok: false }, { status: 403 })
    );
    expect(requireOpsAccess(request('POST'), 'localadmin')?.status).toBe(403);
    expect(mocks.requireConciergeMutationAccess).toHaveBeenCalledTimes(1);
    // Reads never reach the mutation gate.
    expect(requireOpsAccess(request('GET'), 'localadmin')).toBeNull();
    expect(mocks.requireConciergeMutationAccess).toHaveBeenCalledTimes(1);
  });

  it('blocks a cross-origin cookie-session mutation even for a readonly route', () => {
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('readonly'));
    mocks.conciergeCredential.mockReturnValue({ token: 'kys1.x.y', source: 'session-cookie' });
    const crossOrigin = request('POST', {
      host: '127.0.0.1:3050',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    });
    expect(requireOpsAccess(crossOrigin, 'readonly')?.status).toBe(403);
    expect(guardOpsRequest(crossOrigin)?.status).toBe(403);
  });

  it('resolves the viewer once per request', () => {
    mocks.resolveConciergeViewerContext.mockReturnValue(viewer('localadmin'));
    const req = request();
    guardOpsRequest(req);
    requireOpsAccess(req, 'readonly');
    getOpsAccessRole(req);
    expect(mocks.resolveConciergeViewerContext).toHaveBeenCalledTimes(1);
  });
});
