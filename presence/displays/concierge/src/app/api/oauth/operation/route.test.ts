import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ access: vi.fn(), read: vi.fn() }));
vi.mock('@agent/core/oauth-session-store', () => ({ readOAuthOperation: mocks.read }));
vi.mock('../../../../lib/operator-service-access', () => ({
  resolveOperatorServiceAccess: mocks.access,
  operatorServiceError: (error: string, status: number) =>
    NextResponse.json({ ok: false, error }, { status }),
}));
import { GET } from './route';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockReturnValue({ principal: { principalId: 'operator-a' } });
});
const request = () =>
  new NextRequest(
    'http://127.0.0.1:3050/api/oauth/operation?service_id=github&operation_id=opaque_operation'
  );
describe('OAuth observation scope', () => {
  it('uses the resolved principal and returns a no-store operation view', async () => {
    mocks.read.mockReturnValue({
      operationId: 'opaque_operation',
      serviceId: 'github',
      status: 'connected',
      expiresAt: '2026-10-28T00:10:00Z',
    });
    const response = await GET(request());
    expect(mocks.read).toHaveBeenCalledWith('github', 'opaque_operation', 'operator-a');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ ok: true, operation: { status: 'connected' } });
  });
  it('never observes pending state when the viewer gate denies access', async () => {
    mocks.access.mockReturnValue({ response: NextResponse.json({ ok: false }, { status: 403 }) });
    expect((await GET(request())).status).toBe(403);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('does not distinguish another operator operation from an absent attempt', async () => {
    mocks.read.mockReturnValue(null);
    expect((await GET(request())).status).toBe(404);
    mocks.read.mockImplementation(() => {
      throw new Error('private state path');
    });
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private state');
  });
});
