import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  access: vi.fn(),
  viewer: vi.fn(),
  collect: vi.fn(),
}));
vi.mock('../../../lib/api-guard', () => ({
  guardRequest: mocks.guard,
  requireChronosAccess: mocks.access,
}));
vi.mock('../../../lib/viewer-context', () => ({
  resolveViewerContextForRequest: mocks.viewer,
  viewerErrorResponse: (error: Error) => new Response(error.message, { status: 403 }),
}));
vi.mock('../../../lib/organization-dashboard', () => ({
  collectOrganizationDashboard: mocks.collect,
}));
import { GET } from './route';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.guard.mockReturnValue(null);
  mocks.access.mockReturnValue(null);
  mocks.viewer.mockReturnValue({ context: { memberId: 'server-alice' } });
  mocks.collect.mockReturnValue({ ok: true });
});
const request = (query = '') =>
  new NextRequest('http://localhost/api/organization-dashboard' + query);
it('checks access before data collection', () => {
  mocks.access.mockReturnValue(new Response('denied', { status: 403 }));
  expect(GET(request()).status).toBe(403);
  expect(mocks.viewer).not.toHaveBeenCalled();
  expect(mocks.collect).not.toHaveBeenCalled();
});
it('requires request-resolved authentication', () => {
  mocks.viewer.mockReturnValue({ response: new Response('denied', { status: 401 }) });
  expect(GET(request()).status).toBe(401);
  expect(mocks.collect).not.toHaveBeenCalled();
});
it.each(['?mode=invalid', '?mode=mine&mode=scope', '?tenant=a&tenant=b'])(
  'rejects ambiguous or invalid request %s',
  (query) => {
    expect(GET(request(query)).status).toBeGreaterThanOrEqual(400);
    expect(mocks.collect).not.toHaveBeenCalled();
  }
);
it('uses server identity and non-cacheable responses; user parameters never supply identity', async () => {
  const response = GET(request('?mode=mine&memberId=bob&tenant=acme'));
  expect(mocks.collect).toHaveBeenCalledWith(
    { memberId: 'server-alice' },
    { tenant_slug: 'acme' },
    'mine'
  );
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ok: true });
});
