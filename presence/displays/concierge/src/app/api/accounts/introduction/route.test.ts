import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
const mocks = vi.hoisted(() => ({
  mutation: vi.fn(),
  viewer: vi.fn(),
  access: vi.fn(),
  installation: vi.fn(),
  preview: vi.fn(),
  request: vi.fn(),
  status: vi.fn(),
  apply: vi.fn(),
}));
vi.mock('@agent/core/secret/account-introduction', () => ({
  previewAccountIntroduction: mocks.preview,
  proposeAccountIntroduction: mocks.request,
  accountIntroductionStatus: mocks.status,
  applyAccountIntroduction: mocks.apply,
}));
vi.mock('../../../../lib/api-guard', () => ({ requireConciergeMutationAccess: mocks.mutation }));
vi.mock('../../../../lib/viewer-context', () => ({ resolveConciergeViewer: mocks.viewer }));
vi.mock('../../../../lib/account-introduction-server', () => ({
  accountIntroductionAccess: mocks.access,
}));
vi.mock('../../../../lib/installation-access', () => ({
  requireConciergeInstallationAccess: mocks.installation,
}));
vi.mock('../../../../lib/onboarding-authority-server', () => ({
  asOnboardingOwner: (run: () => unknown) => run(),
}));
import { POST } from './route';
const principal = { accountableId: 'user:owner' };
const request = (body: unknown) =>
  new NextRequest('http://localhost/api/accounts/introduction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.viewer.mockReturnValue({ context: {} });
  mocks.access.mockReturnValue({ principal, scope: { kind: 'person' } });
  mocks.installation.mockReturnValue({});
  mocks.preview.mockReturnValue({ binding_id: 'selected', service_id: 'github' });
  mocks.apply.mockResolvedValue({ status: 'applied', generation: 'new' });
});
describe('account introduction HTTP boundary', () => {
  it('passes only the server-resolved principal and selected binding to preview', async () => {
    const response = await POST(request({ action: 'preview', binding_id: 'selected' }));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.preview).toHaveBeenCalledWith(principal, 'selected');
  });
  it.each([
    { action: 'preview', binding_id: 'selected', tenant_slug: 'other' },
    { action: 'preview', binding_id: 'selected', material: { GITHUB_TOKEN: 'synthetic' } },
    { action: 'apply', binding_id: '../other', approval_id: 'id', material: {} },
    { action: 'apply', binding_id: 'selected', approval_id: 'id', material: { BAD: 1 } },
    {
      action: 'apply',
      binding_id: 'selected',
      approval_id: 'id',
      material: { BAD: 'x'.repeat(16385) },
    },
  ])('refuses malformed or out-of-phase fields before applying', async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('does no account work after a mutation refusal', async () => {
    mocks.mutation.mockReturnValue(NextResponse.json({ ok: false }, { status: 403 }));
    expect((await POST(request({ action: 'preview', binding_id: 'selected' }))).status).toBe(403);
    expect(mocks.access).not.toHaveBeenCalled();
  });
  it('requires installation write assurance before collecting a personal account', async () => {
    mocks.installation.mockReturnValue({
      response: NextResponse.json({ ok: false }, { status: 403 }),
    });
    expect(
      (
        await POST(
          request({
            action: 'apply',
            binding_id: 'selected',
            approval_id: 'id',
            material: { GITHUB_TOKEN: 'synthetic' },
          })
        )
      ).status
    ).toBe(403);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it('never echoes failed storage or broker output or submitted tokens', async () => {
    mocks.apply.mockRejectedValue(new Error('synthetic-secret /private/path provider response'));
    const response = await POST(
      request({
        action: 'apply',
        binding_id: 'selected',
        approval_id: 'id',
        material: { GITHUB_TOKEN: 'synthetic-secret' },
      })
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: 'account_registration_unavailable' });
  });
});
