import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  viewer: vi.fn(),
  start: vi.fn(),
}));

vi.mock('../../../../lib/api-guard', () => ({ requireConciergeMutationAccess: mocks.guard }));
vi.mock('../../../../lib/viewer-context', () => ({ resolveConciergeViewer: mocks.viewer }));
vi.mock('../../../../lib/loopback-peer', () => ({ isLoopbackPeer: () => false }));
vi.mock('../../../../lib/first-run-server', () => ({
  startIdentityLinkForViewer: mocks.start,
}));

import { POST } from './route';

const req = { url: 'http://localhost:3050/api/setup/link-identity' } as unknown as NextRequest;
const context = { role: 'localadmin', source: 'token', principalId: 'p', memberId: 'owner' };

describe('/api/setup/link-identity', () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.guard.mockReturnValue(null);
    mocks.viewer.mockReturnValue({ context });
  });

  it('stops at the mutation guard (auth / cross-origin cookie)', async () => {
    mocks.guard.mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect((await POST(req)).status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('starts the link for the resolved viewer and sets the transaction cookie', async () => {
    mocks.start.mockResolvedValue({
      ok: true,
      location: 'https://idp.example/authorize?x=1',
      setCookies: ['kyberion_oidc_tx_concierge=v; HttpOnly; SameSite=Lax'],
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, location: 'https://idp.example/authorize?x=1' });
    expect(res.headers.get('set-cookie')).toContain('kyberion_oidc_tx_concierge=v');
    expect(mocks.start).toHaveBeenCalledWith(context, {
      requestOrigin: 'http://localhost:3050',
      loopback: false,
      next: '/setup/sso?linked=1',
    });
  });

  it('passes through refusals without a cookie', async () => {
    mocks.start.mockResolvedValue({ ok: false, status: 403, error: 'member_required' });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });
});
