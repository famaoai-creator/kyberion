import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  readiness: vi.fn(),
  propose: vi.fn(),
  apply: vi.fn(),
  approval: vi.fn(),
  oauth: vi.fn(),
}));
vi.mock('@agent/core/authority', () => ({
  withExecutionContextAsync: (_role: string, callback: () => unknown) => callback(),
}));
vi.mock('@agent/core/secret/secret-introduction', () => ({
  describeIntroductionReadiness: mocks.readiness,
  proposeSecretIntroduction: mocks.propose,
  applySecretIntroduction: mocks.apply,
  SECRET_INTRODUCTION_RECOVERY_REQUIRED: 'safe-recovery-required',
}));
vi.mock('@agent/core/secret/secret-identity', () => ({
  listServiceSecretKeys: () => ['ACCESS_TOKEN'],
}));
vi.mock('@agent/core/governance/approval-store', () => ({ loadApprovalRequest: mocks.approval }));
vi.mock('@agent/core/oauth-broker', () => ({ beginInteractiveServiceOAuth: mocks.oauth }));
vi.mock('@agent/core/surface/surface-runtime', () => ({
  loadSurfaceManifest: () => ({ surfaces: [] }),
  probeSurfaceHealth: vi.fn(),
}));
vi.mock('../../../lib/operator-service-access', () => ({
  resolveOperatorServiceAccess: mocks.access,
  operatorServiceError: (error: string, status = 400) =>
    NextResponse.json({ ok: false, error }, { status }),
}));
import { GET as readiness, POST as propose } from './introduce/route';
import { POST as apply } from './apply/route';
import { POST as oauth } from '../oauth/begin/route';
const approvalId = '11111111-1111-1111-1111-111111111111';
const principal = {
  role: 'localadmin',
  source: 'loopback',
  principalId: 'human:operator',
  loopback: true,
};
const request = (body: unknown) =>
  new NextRequest('http://127.0.0.1:3050/api/secrets/introduce', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3050' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockReturnValue({ principal });
  mocks.approval.mockReturnValue({ target: { serviceId: 'github', secretKey: 'ACCESS_TOKEN' } });
  mocks.apply.mockResolvedValue({
    approvalId,
    status: 'applied',
    identity: { envName: 'GITHUB_ACCESS_TOKEN' },
    changedKeys: ['access_token'],
  });
  mocks.propose.mockReturnValue({
    approvalId,
    status: 'approved',
    autoApproved: true,
    identity: { envName: 'GITHUB_ACCESS_TOKEN' },
  });
});
describe('legacy global credential endpoints cannot bypass operator admission', () => {
  it.each([
    [
      'readiness',
      () =>
        readiness(new NextRequest('http://127.0.0.1:3050/api/secrets/introduce?serviceId=github')),
    ],
    ['proposal', () => propose(request({ serviceId: 'github', secretKey: 'ACCESS_TOKEN' }))],
    ['apply', () => apply(request({ approvalId, value: 'synthetic-token' }))],
    ['OAuth', () => oauth(request({ service_id: 'notion' }))],
  ])('denies remote %s without reaching credentials or a provider', async (_label, action) => {
    mocks.access.mockReturnValue({
      response: NextResponse.json({ ok: false, error: 'local_operator_required' }, { status: 403 }),
    });
    expect((await action()).status).toBe(403);
    expect(mocks.readiness).not.toHaveBeenCalled();
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.approval).not.toHaveBeenCalled();
    expect(mocks.oauth).not.toHaveBeenCalled();
  });
  it('server-binds legacy proposal identity and storage', async () => {
    expect(
      (
        await propose(
          request({ serviceId: 'github', secretKey: 'ACCESS_TOKEN', reason: 'Use existing token' })
        )
      ).status
    ).toBe(200);
    expect(mocks.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedBy: principal.principalId,
        storageChannel: 'concierge',
        channel: 'concierge',
        requestedByContext: {
          surface: 'api',
          actorId: principal.principalId,
          actorRole: 'sovereign',
        },
      })
    );
  });
  it('requires strict apply even through the old generic form', async () => {
    const response = await apply(
      request({
        approvalId,
        value: 'synthetic-token',
        channel: 'concierge',
        storageChannel: 'concierge',
      })
    );
    expect(response.status).toBe(200);
    expect(mocks.apply.mock.calls[0][0].expected).toEqual({
      principalId: principal.principalId,
      serviceId: 'github',
      secretKey: 'ACCESS_TOKEN',
      channel: 'concierge',
      storageChannel: 'concierge',
    });
    expect(await response.text()).not.toContain('synthetic-token');
  });
  it('rejects cross-store requests before approval reads', async () => {
    expect(
      (await apply(request({ approvalId, value: 'synthetic', storageChannel: 'terminal' }))).status
    ).toBe(400);
    expect(mocks.approval).not.toHaveBeenCalled();
  });
  it('returns a fixed error for secret-bearing failures', async () => {
    mocks.apply.mockRejectedValue(new Error('synthetic-leak-token'));
    expect(await (await apply(request({ approvalId, value: 'synthetic-token' }))).json()).toEqual({
      ok: false,
      error: 'approval_required',
    });
  });
});
