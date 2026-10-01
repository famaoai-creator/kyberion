import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import type { ConciergeViewerContext } from '../../../../lib/viewer-context';
const mocks = vi.hoisted(() => ({
  viewer: vi.fn(),
  member: vi.fn(),
  summaries: vi.fn(),
  consents: vi.fn(),
}));
vi.mock('../../../../lib/viewer-context', async () => ({
  ...(await vi.importActual<typeof import('../../../../lib/viewer-context')>(
    '../../../../lib/viewer-context'
  )),
  resolveConciergeViewer: mocks.viewer,
}));
vi.mock('../../../../lib/work-inventory-member', () => ({
  requireWorkInventoryMember: mocks.member,
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContext: (_role: string, fn: () => unknown) => fn(),
}));
vi.mock('@agent/core/workforce/work-inventory-observation', () => ({
  listObservationSummaries: mocks.summaries,
}));
vi.mock('@agent/core/workforce/work-inventory-consent', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/workforce/work-inventory-consent')>(
    '@agent/core/workforce/work-inventory-consent'
  )),
  listWorkInventoryConsents: mocks.consents,
}));
import { GET } from './route';
const viewer: ConciergeViewerContext = {
  role: 'readonly',
  tenantSlugs: ['acme'],
  organizationIds: 'all',
  projectIds: 'all',
  tierAccess: ['confidential'],
  source: 'token',
  principalId: 'user:member-a',
  memberId: 'member-a',
};
const request = (query = 'tenant=acme') =>
  new NextRequest(`https://concierge.example/api/work-inventory/review-digest?${query}`);
beforeEach(() => {
  vi.resetAllMocks();
  mocks.viewer.mockReturnValue({ context: { ...viewer } });
  mocks.member.mockReturnValue({
    member: {
      member_id: 'member-a',
      status: 'active',
      memberships: [{ tenant_slug: 'acme', role: 'viewer' }],
    },
  });
  mocks.summaries.mockReturnValue([]);
  mocks.consents.mockReturnValue([]);
});
describe('personal review GET boundary', () => {
  it('uses only server member and permitted concrete tenant with no-store', async () => {
    const response = GET(request('tenant=acme&member_id=other&tier=personal'));
    expect(response.status).toBe(200);
    expect(mocks.summaries).toHaveBeenCalledWith('member-a');
    expect(mocks.consents).toHaveBeenCalledWith('member-a');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true, pendingCount: 0, attentionCount: 0 });
  });
  it('passes through authentication and unresolved member failures without reads', () => {
    mocks.viewer.mockReturnValue({ response: NextResponse.json({}, { status: 401 }) });
    expect(GET(request()).status).toBe(401);
    expect(mocks.member).not.toHaveBeenCalled();
    mocks.viewer.mockReturnValue({ context: viewer });
    mocks.member.mockReturnValue({ response: NextResponse.json({}, { status: 404 }) });
    expect(GET(request()).status).toBe(404);
    expect(mocks.summaries).not.toHaveBeenCalled();
  });
  it.each(['', 'tenant=all', 'tenant=other', 'tenant=../acme'])(
    'denies absent/forged/broad tenant %s',
    (query) => {
      expect(GET(request(query)).status).toBe(403);
      expect(mocks.summaries).not.toHaveBeenCalled();
    }
  );
  it.each<Partial<ConciergeViewerContext>>([
    { tenantSlugs: ['other'] },
    { organizationIds: ['org-one'] },
    { projectIds: ['project-one'] },
    { tierAccess: ['public'] },
  ])('cannot widen viewer scope %j', (change) => {
    mocks.viewer.mockReturnValue({ context: { ...viewer, ...change } });
    expect(GET(request()).status).toBe(403);
    expect(mocks.summaries).not.toHaveBeenCalled();
  });
  it('denies anonymous identity and suspended membership', () => {
    mocks.viewer.mockReturnValue({ context: { ...viewer, source: 'anonymous' } });
    expect(GET(request()).status).toBe(401);
    mocks.viewer.mockReturnValue({ context: viewer });
    mocks.member.mockReturnValue({
      member: {
        member_id: 'member-a',
        status: 'suspended',
        memberships: [{ tenant_slug: 'acme' }],
      },
    });
    expect(GET(request()).status).toBe(403);
    expect(mocks.summaries).not.toHaveBeenCalled();
  });
  it('hides storage failures and never caches failure responses', async () => {
    mocks.summaries.mockImplementation(() => {
      throw new Error('/private/secret/path');
    });
    const response = GET(request());
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.stringify(await response.json())).not.toContain('/private/secret/path');
  });
});
