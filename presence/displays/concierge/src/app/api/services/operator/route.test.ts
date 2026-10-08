import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  list: vi.fn(),
  probe: vi.fn(),
  propose: vi.fn(),
  apply: vi.fn(),
  approval: vi.fn(),
}));
vi.mock('@agent/core/governance/approval-store', () => ({ loadApprovalRequest: mocks.approval }));
vi.mock('@agent/core/authority', () => ({
  withExecutionContextAsync: (_role: string, callback: () => unknown) => callback(),
}));
vi.mock('@agent/core/service/operator-service-connection', () => ({
  listOperatorServiceConnections: mocks.list,
  probeOperatorServiceConnection: mocks.probe,
}));
vi.mock('@agent/core/secret/secret-introduction', () => ({
  proposeSecretIntroduction: mocks.propose,
  applySecretIntroduction: mocks.apply,
  SECRET_INTRODUCTION_RECOVERY_REQUIRED: 'safe-recovery-required',
}));
vi.mock('../../../../lib/operator-service-access', () => ({
  resolveOperatorServiceAccess: mocks.access,
  operatorServiceError: (error: string, status = 400) =>
    NextResponse.json({ ok: false, error }, { status }),
}));
import { GET, POST } from './route';
const principal = {
  role: 'localadmin',
  source: 'loopback',
  principalId: 'human:operator',
  loopback: true,
};
const approvalId = '11111111-1111-1111-1111-111111111111';
const descriptor = {
  serviceId: 'github',
  label: 'GitHub',
  secretKey: 'ACCESS_TOKEN',
  credential_present: false,
};
const request = (body: unknown) =>
  new NextRequest('http://127.0.0.1:3050/api/services/operator', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:3050' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockReturnValue({ principal });
  mocks.list.mockReturnValue([descriptor]);
  mocks.propose.mockReturnValue({ approvalId, status: 'approved' });
  mocks.probe.mockResolvedValue({
    serviceId: 'github',
    status: 'authenticated',
    checkedAt: '2026-10-08T00:00:00Z',
  });
});
describe('local operator Web registration API', () => {
  it('returns only catalog registration metadata and never a false verified state on reload', async () => {
    const response = await GET(new NextRequest('http://127.0.0.1:3050/api/services/operator'));
    expect(await response.json()).toEqual({ ok: true, services: [descriptor] });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it('does no secret or provider work when access is denied', async () => {
    mocks.access.mockReturnValue({ response: NextResponse.json({ ok: false }, { status: 403 }) });
    expect(
      (
        await POST(
          request({ action: 'apply', serviceId: 'github', approvalId, value: 'synthetic' })
        )
      ).status
    ).toBe(403);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    { action: 'probe', serviceId: 'github', url: 'https://attacker.invalid' },
    { action: 'propose', serviceId: 'github', riskLevel: 'low' },
    { action: 'propose', serviceId: 'github', autoApprove: true },
    { action: 'probe', serviceId: 'github', value: 'unwanted' },
    { action: '__proto__', serviceId: 'github' },
    { action: 'probe', serviceId: 'unknown' },
    {
      action: 'apply',
      serviceId: 'github',
      approvalId,
      value: 'synthetic',
      storageChannel: 'terminal',
    },
  ])('rejects noncanonical action fields %j', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.propose).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it('server-binds proposal scope and principal without a value', async () => {
    expect((await POST(request({ action: 'propose', serviceId: 'github' }))).status).toBe(200);
    expect(mocks.propose).toHaveBeenCalledWith(
      expect.objectContaining({
        serviceId: 'github',
        secretKey: 'ACCESS_TOKEN',
        channel: 'concierge',
        storageChannel: 'concierge',
        requestedBy: principal.principalId,
        requestedByContext: {
          surface: 'api',
          actorId: principal.principalId,
          actorRole: 'sovereign',
        },
      })
    );
    expect(mocks.propose.mock.calls[0][0]).not.toHaveProperty('value');
  });
  it('checks the existing pending approval without creating another proposal', async () => {
    mocks.approval.mockReturnValue({
      id: approvalId,
      kind: 'secret_mutation',
      status: 'pending',
      requestedBy: principal.principalId,
      requestedByContext: { actorId: principal.principalId },
      target: {
        serviceId: 'github',
        secretKey: 'ACCESS_TOKEN',
        store: 'os_keychain',
        mutation: 'set',
      },
      channel: 'concierge',
      storageChannel: 'concierge',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    const response = await POST(request({ action: 'status', serviceId: 'github', approvalId }));
    expect(await response.json()).toEqual({ ok: true, approvalId, status: 'pending' });
    expect(mocks.propose).not.toHaveBeenCalled();
    mocks.approval.mockReturnValue({
      ...mocks.approval.mock.results[0].value,
      requestedBy: 'another-user',
    });
    expect(
      (await POST(request({ action: 'status', serviceId: 'github', approvalId }))).status
    ).toBe(403);
  });
  it('passes the exact server expectation and returns registered separately from verified', async () => {
    const response = await POST(
      request({ action: 'apply', serviceId: 'github', approvalId, value: 'synthetic-token' })
    );
    expect(mocks.apply).toHaveBeenCalledWith({
      approvalId,
      value: 'synthetic-token',
      appliedBy: principal.principalId,
      expected: {
        principalId: principal.principalId,
        serviceId: 'github',
        secretKey: 'ACCESS_TOKEN',
        storageChannel: 'concierge',
        channel: 'concierge',
      },
    });
    expect(await response.json()).toEqual({ ok: true, serviceId: 'github', status: 'registered' });
    expect(mocks.probe).not.toHaveBeenCalled();
  });
  it('projects only the probe status even if an internal result gains sensitive fields', async () => {
    mocks.probe.mockResolvedValue({
      serviceId: 'github',
      status: 'authenticated',
      checkedAt: 'now',
      access_token: 'synthetic-hidden',
    });
    const response = await POST(request({ action: 'probe', serviceId: 'github' }));
    expect(await response.json()).toEqual({
      ok: true,
      serviceId: 'github',
      status: 'authenticated',
      checkedAt: 'now',
    });
  });
  it('reports partial storage as recovery required, without automatic retry', async () => {
    mocks.apply.mockRejectedValue(new Error('safe-recovery-required'));
    const response = await POST(
      request({ action: 'apply', serviceId: 'github', approvalId, value: 'synthetic-token' })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'recovery_required' });
    expect(mocks.apply).toHaveBeenCalledTimes(1);
  });
  it.each(['list', 'probe', 'propose', 'apply'] as const)(
    'does not echo %s exception text',
    async (operation) => {
      const secret = 'synthetic-leak-sentinel';
      if (operation === 'list')
        mocks.list.mockImplementation(() => {
          throw new Error(secret);
        });
      else if (operation === 'propose')
        mocks.propose.mockImplementation(() => {
          throw new Error(secret);
        });
      else mocks[operation].mockRejectedValue(new Error(secret));
      const action = operation === 'list' ? 'probe' : operation;
      const response = await POST(
        request(
          action === 'apply'
            ? { action, serviceId: 'github', approvalId, value: secret }
            : { action, serviceId: 'github' }
        )
      );
      expect(await response.text()).not.toContain(secret);
    }
  );
});
