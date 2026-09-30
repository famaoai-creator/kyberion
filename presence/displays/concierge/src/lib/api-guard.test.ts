import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type GuardResponse = { status: number };

const mocks = vi.hoisted(() => ({
  authorizeSurfaceMutation: vi.fn(),
  guardConciergeRequest: vi.fn<() => GuardResponse | null>(() => null),
  resolveConciergeViewer: vi.fn(),
  conciergeCredential: vi.fn(),
}));

vi.mock('@agent/core/surface/surface-mutation-guard', () => ({
  authorizeSurfaceMutation: mocks.authorizeSurfaceMutation,
  extractSurfaceBearerToken: (authorization: string | null) =>
    authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '',
}));

vi.mock('./viewer-context', () => ({
  guardConciergeRequest: mocks.guardConciergeRequest,
  resolveConciergeViewer: mocks.resolveConciergeViewer,
  conciergeCredential: mocks.conciergeCredential,
}));

import { requireConciergeMutationAccess } from './api-guard';

function request(authorization = 'Bearer scoped-token') {
  return new NextRequest('http://localhost/api/concierge/mutation', {
    headers: { authorization },
  });
}

describe('requireConciergeMutationAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeSurfaceMutation.mockReturnValue({ ok: true, status: 200, reason: 'token' });
    mocks.guardConciergeRequest.mockReturnValue(null);
    mocks.conciergeCredential.mockImplementation((req: NextRequest) => {
      const auth = req.headers.get('authorization');
      if (auth) return { token: auth.replace(/^Bearer\s+/i, ''), source: 'header' };
      if (req.headers.get('cookie')?.includes('kyberion_session='))
        return { token: 'kys1.x.y', source: 'session-cookie' };
      return { token: null, source: 'none' };
    });
  });

  it('403s a cross-origin cookie-session POST before resolving the viewer', () => {
    const req = new NextRequest('https://app.example/api/x', {
      method: 'POST',
      headers: {
        cookie: 'kyberion_session=kys1.x.y',
        host: 'app.example',
        origin: 'https://evil.example',
      },
    });
    expect(requireConciergeMutationAccess(req)?.status).toBe(403);
    expect(mocks.resolveConciergeViewer).not.toHaveBeenCalled();
  });

  it('allows a same-origin cookie-session POST for a localadmin viewer', () => {
    mocks.resolveConciergeViewer.mockReturnValue({ context: { role: 'localadmin' } });
    const req = new NextRequest('https://app.example/api/x', {
      method: 'POST',
      headers: {
        cookie: 'kyberion_session=kys1.x.y',
        host: 'app.example',
        origin: 'https://app.example',
      },
    });
    expect(requireConciergeMutationAccess(req)).toBeNull();
  });

  it('rejects a same-origin cookie session whose viewer is readonly', () => {
    mocks.resolveConciergeViewer.mockReturnValue({ context: { role: 'readonly' } });
    const req = new NextRequest('https://app.example/api/x', {
      method: 'POST',
      headers: {
        cookie: 'kyberion_session=kys1.x.y',
        host: 'app.example',
        origin: 'https://app.example',
      },
    });
    expect(requireConciergeMutationAccess(req)?.status).toBe(403);
  });

  it('rejects a bearer token whose resolved role is readonly', async () => {
    mocks.resolveConciergeViewer.mockReturnValue({
      context: { role: 'readonly' },
    });

    const response = requireConciergeMutationAccess(request());

    expect(response?.status).toBe(403);
    await expect(response?.json()).resolves.toEqual({
      ok: false,
      error: 'Concierge mutation requires a localadmin viewer.',
    });
  });

  it('allows a bearer token whose resolved role is localadmin', () => {
    mocks.resolveConciergeViewer.mockReturnValue({
      context: { role: 'localadmin' },
    });

    expect(requireConciergeMutationAccess(request())).toBeNull();
  });

  it('keeps same-origin compatibility independent of bearer role resolution', () => {
    mocks.authorizeSurfaceMutation.mockReturnValue({
      ok: true,
      status: 200,
      reason: 'same-origin',
    });

    expect(requireConciergeMutationAccess(request(''))).toBeNull();
    expect(mocks.resolveConciergeViewer).not.toHaveBeenCalled();
  });

  it('rejects a request after the shared token/method rate limit is exceeded', () => {
    mocks.guardConciergeRequest.mockReturnValue({ status: 429 });

    const response = requireConciergeMutationAccess(request());

    expect(response?.status).toBe(429);
    expect(mocks.authorizeSurfaceMutation).not.toHaveBeenCalled();
  });
});
