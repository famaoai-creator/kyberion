import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({
  source: 'header',
  deny: false,
  authorize: vi.fn(),
  snapshot: vi.fn(),
  execute: vi.fn(),
}));
vi.mock('../../../lib/api-guard', () => ({
  requireConciergeMutationAccess: () =>
    mocks.deny ? NextResponse.json({ ok: false }, { status: 403 }) : null,
}));
vi.mock('../../../lib/viewer-context', () => ({
  conciergeCredential: () => ({ token: 'verified', source: mocks.source }),
  guardConciergeRequest: () => null,
}));
vi.mock('../../../lib/management-server', () => ({
  managementAuthorization: mocks.authorize,
  managementSnapshot: mocks.snapshot,
  managementContextId: () => 'context-a',
}));
vi.mock('@agent/core/surface/surface-management-mutations', () => ({
  executeSurfaceManagementMutation: mocks.execute,
  SurfaceManagementError: class extends Error {
    constructor(
      public code: string,
      public status: number,
      message: string
    ) {
      super(message);
    }
  },
}));
import { SurfaceManagementError } from '@agent/core/surface/surface-management-mutations';
import { GET, POST } from './route';
function request(body: unknown, origin = 'http://localhost') {
  return new NextRequest('http://localhost/api/management', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: 'localhost', origin },
    body: JSON.stringify(body),
  });
}
const body = {
  tenant: 'tenant-a',
  contextId: 'context-a',
  operation: 'organization.create',
  requestId: 'request-00001',
  name: 'Organization',
};
beforeEach(() => {
  mocks.source = 'header';
  mocks.deny = false;
  mocks.authorize.mockReset().mockReturnValue({ tenantSlug: 'tenant-a' });
  mocks.snapshot.mockReset().mockResolvedValue({ ok: true });
  mocks.execute.mockReset().mockResolvedValue({
    operation: 'organization.create',
    organizationId: 'org-a',
    version: 'a'.repeat(64),
    replayed: false,
    resource: { private: 'not-returned' },
  });
});
describe('management HTTP boundary', () => {
  it('rejects a changed owner context before executing a confirmed draft', async () => {
    const response = await POST(request({ ...body, contextId: 'context-b' }));
    expect(response.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects unsupported body fields before mutation', async () => {
    const response = await POST(request({ ...body, status: 'archived' }));
    expect(response.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON and absent tenant', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/management', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
    );
    expect(response.status).toBe(400);
    expect((await POST(request({ operation: 'organization.create' }))).status).toBe(400);
  });
  it.each(['session-cookie', 'none'])('requires same-origin for %s credentials', async (source) => {
    mocks.source = source;
    const response = await POST(request(body, 'https://attacker.invalid'));
    expect(response.status).toBe(403);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it('does not turn mutation-guard denial into a retry', async () => {
    mocks.deny = true;
    expect((await POST(request(body))).status).toBe(403);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
  it('returns only safe result fields after verified mutation', async () => {
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.result.resource).toBeUndefined();
    expect(mocks.execute).toHaveBeenCalledWith(
      { tenantSlug: 'tenant-a' },
      { operation: 'organization.create', requestId: 'request-00001', name: 'Organization' }
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('preserves stale/replay conflicts and never invokes mutation twice', async () => {
    mocks.execute.mockRejectedValue(new SurfaceManagementError('version_conflict', 409, 'Reload'));
    const response = await POST(request(body));
    expect(response.status).toBe(409);
    expect((await response.json()).error_code).toBe('version_conflict');
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });
  it('does not leak internal filesystem errors', async () => {
    mocks.execute.mockRejectedValue(new Error('/private/signing/key'));
    const response = await POST(request(body));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('/private');
  });
  it('rejects duplicate/unknown query controls and preserves hierarchy', async () => {
    expect(
      (await GET(new NextRequest('http://localhost/api/management?tenant=a&tenant=b'))).status
    ).toBe(400);
    expect((await GET(new NextRequest('http://localhost/api/management?debug=true'))).status).toBe(
      400
    );
    await GET(
      new NextRequest(
        'http://localhost/api/management?tenant=tenant-a&organization_id=org-a&project_id=PRJ-A'
      )
    );
    expect(mocks.snapshot).toHaveBeenCalledWith({ tenantSlug: 'tenant-a' }, 'org-a', 'PRJ-A');
  });
});
