import { beforeEach, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ load: vi.fn(), gate: vi.fn() }));
vi.mock('../../../../lib/installation-access', () => ({
  requireConciergeInstallationAccess: mocks.gate,
}));
vi.mock('../../../../lib/personal-approval-server', () => ({
  loadConciergeApproval: mocks.load,
}));
vi.mock('../../../../lib/viewer-context', () => ({
  resolveConciergeViewer: () => ({ context: { tierAccess: ['personal', 'public'] } }),
  withConciergeViewerContext: (_viewer: unknown, read: () => unknown) => read(),
  conciergeErrorResponse: () => new Response(null, { status: 500 }),
}));

import { GET } from './route';

const id = '7397aef8-815e-4e9a-8e32-ac7836985d73';
const request = () => new NextRequest(`http://localhost/api/voice/approval-status?id=${id}`);
const local = {
  scope: { tier: 'personal' },
  accountability: { effectBinding: 'voice:playback' },
  status: 'approved',
  effect: 'private content',
};

beforeEach(() => {
  mocks.load.mockReset();
  mocks.gate.mockReturnValue({});
});

it.each([
  [{}, 'approved'],
  [{ status: 'pending' }, 'pending'],
  [{ expiresAt: '2001-01-01T00:00:00Z' }, 'expired'],
  [{ revocation: { revokedAt: '2020-01-01T00:00:00Z' } }, 'revoked'],
])('returns only the decision status for a local voice request', async (update, status) => {
  mocks.load.mockReturnValue({ ...local, ...update });
  const response = GET(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, id, status });
  expect(mocks.load).toHaveBeenCalledWith(expect.anything(), 'external-operation', id);
});

it('denies tenant approvals and never reads without installation access', () => {
  mocks.load.mockReturnValue({ ...local, scope: { tier: 'personal', tenant_slug: 'other' } });
  expect(GET(request()).status).toBe(404);
  mocks.load.mockClear();
  mocks.gate.mockReturnValue({ response: new Response(null, { status: 403 }) });
  expect(GET(request()).status).toBe(403);
  expect(mocks.load).not.toHaveBeenCalled();
});
