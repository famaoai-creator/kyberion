import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ guard: vi.fn(), peer: vi.fn(), viewer: vi.fn() }));
vi.mock('./api-guard', () => ({ requireConciergeMutationAccess: mocks.guard }));
vi.mock('./loopback-peer', () => ({ isLoopbackPeer: mocks.peer }));
vi.mock('./viewer-context', () => ({ resolveConciergeViewer: mocks.viewer }));
import { resolveOperatorServiceAccess } from './operator-service-access';
const local = { role: 'localadmin', source: 'loopback', principalId: 'human:operator' };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.peer.mockReturnValue(true);
  mocks.viewer.mockReturnValue({ context: local });
});
describe('operator-only service access', () => {
  it('admits a proven local GET without requiring the Origin header browsers omit on GET', () => {
    expect(
      resolveOperatorServiceAccess(new NextRequest('http://127.0.0.1:3050/api/services/operator'))
        .principal
    ).toMatchObject({ ...local, loopback: true });
    expect(mocks.guard).not.toHaveBeenCalled();
  });
  it.each([
    { ...local, source: 'token' },
    { ...local, role: 'readonly' },
    { ...local, principalId: undefined },
    { ...local, memberId: 'remote-owner' },
    { ...local, registrationLabel: 'member-token' },
  ])('denies member or unproven principal %j', (context) => {
    mocks.viewer.mockReturnValue({ context });
    expect(
      resolveOperatorServiceAccess(new NextRequest('http://127.0.0.1:3050/api/services/operator'))
        .response?.status
    ).toBe(403);
  });
  it('denies spoofed headers without adapter peer proof', () => {
    mocks.peer.mockReturnValue(false);
    const req = new NextRequest('http://127.0.0.1:3050/api/services/operator', {
      headers: { 'x-real-ip': '127.0.0.1', 'x-forwarded-for': '127.0.0.1' },
    });
    expect(resolveOperatorServiceAccess(req).response?.status).toBe(403);
  });
  it('preserves the existing unsafe-method CSRF gate before resolving authority', () => {
    mocks.guard.mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect(
      resolveOperatorServiceAccess(
        new NextRequest('http://127.0.0.1:3050/api/services/operator', { method: 'POST' })
      ).response?.status
    ).toBe(403);
    expect(mocks.viewer).not.toHaveBeenCalled();
  });
  it('denies cross-site metadata requests', () => {
    expect(
      resolveOperatorServiceAccess(
        new NextRequest('http://127.0.0.1:3050/api/services/operator', {
          headers: { 'sec-fetch-site': 'cross-site' },
        })
      ).response?.status
    ).toBe(403);
  });
  it('maps unresolved viewers to a fixed safe response', async () => {
    mocks.viewer.mockReturnValue({
      response: NextResponse.json({ error: 'opaque-internal-detail' }, { status: 401 }),
    });
    const response = resolveOperatorServiceAccess(
      new NextRequest('http://127.0.0.1:3050/api/services/operator')
    ).response!;
    expect(await response.json()).toEqual({ ok: false, error: 'local_operator_required' });
  });
});
