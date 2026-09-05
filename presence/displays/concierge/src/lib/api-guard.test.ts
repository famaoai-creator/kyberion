import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type GuardResponse = { status: number };

const mocks = vi.hoisted(() => ({
  authorizeSurfaceMutation: vi.fn(),
  guardConciergeRequest: vi.fn<() => GuardResponse | null>(() => null),
  resolveConciergeViewer: vi.fn(),
}));

vi.mock('@agent/core/surface-mutation-guard', () => ({
  authorizeSurfaceMutation: mocks.authorizeSurfaceMutation,
  extractSurfaceBearerToken: (authorization: string | null) =>
    authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '',
}));

vi.mock('./viewer-context', () => ({
  guardConciergeRequest: mocks.guardConciergeRequest,
  resolveConciergeViewer: mocks.resolveConciergeViewer,
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
