import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({ access: vi.fn(), begin: vi.fn() }));
vi.mock('@agent/core/oauth-broker', () => ({ beginInteractiveServiceOAuth: mocks.begin }));
vi.mock('@agent/core/surface/surface-runtime', () => ({
  loadSurfaceManifest: () => ({ surfaces: [] }),
  probeSurfaceHealth: vi.fn(),
}));
vi.mock('../../../../lib/operator-service-access', () => ({
  resolveOperatorServiceAccess: mocks.access,
  operatorServiceError: (error: string, status: number) =>
    NextResponse.json({ ok: false, error }, { status }),
}));
import { POST } from './route';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockReturnValue({ principal: { principalId: 'operator-a' } });
  mocks.begin.mockReturnValue({
    authorizationUrl: 'https://provider.example/authorize',
    state: 'csrf-state-not-an-operation-id',
    codeVerifier: 'synthetic-private-verifier',
    operationId: 'opaque_operation',
    expiresAt: '2026-10-28T01:00:00Z',
  });
});
const request = () =>
  new NextRequest('http://127.0.0.1:3050/api/oauth/begin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ service_id: 'microsoft-365' }),
  });
describe('OAuth operation initiation', () => {
  it('binds the existing broker attempt to the resolved operator and returns only its observation handle', async () => {
    const response = await POST(request());
    expect(mocks.begin).toHaveBeenCalledWith(
      'm365',
      expect.objectContaining({ observerPrincipalId: 'operator-a' })
    );
    const body = await response.json();
    expect(body).toMatchObject({
      operation_id: 'opaque_operation',
      service_id: 'm365',
      expires_at: '2026-10-28T01:00:00Z',
    });
    expect(body).not.toHaveProperty('state');
    expect(body).not.toHaveProperty('codeVerifier');
    expect(JSON.stringify(body)).not.toContain('synthetic-private-verifier');
  });
  it('does not initiate authorization when operator mutation access is denied', async () => {
    mocks.access.mockReturnValue({ response: NextResponse.json({ ok: false }, { status: 403 }) });
    expect((await POST(request())).status).toBe(403);
    expect(mocks.begin).not.toHaveBeenCalled();
  });
});
