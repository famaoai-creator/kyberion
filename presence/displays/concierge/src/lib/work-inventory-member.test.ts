import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type GuardResponse = { status: number };

const mocks = vi.hoisted(() => ({
  authorizeSurfaceMutation: vi.fn(),
  guardConciergeRequest: vi.fn<() => GuardResponse | null>(() => null),
}));

vi.mock('@agent/core/surface-mutation-guard', () => ({
  authorizeSurfaceMutation: mocks.authorizeSurfaceMutation,
}));

vi.mock('./viewer-context', async () => {
  const actual = await vi.importActual<typeof import('./viewer-context')>('./viewer-context');
  return {
    ...actual,
    guardConciergeRequest: mocks.guardConciergeRequest,
  };
});

import { requireConciergeSelfServiceAccess } from './work-inventory-member';

function request(authorization = '') {
  return new NextRequest('http://localhost/api/work-inventory/consent', {
    headers: authorization ? { authorization } : {},
  });
}

/**
 * WI-18: `requireConciergeSelfServiceAccess` shares the CSRF/rate-limit
 * posture of `requireConciergeMutationAccess` (see `api-guard.test.ts`), but
 * — unlike it — never rejects a readonly-role bearer token on its own. The
 * member-resolution gate (`requireWorkInventoryMember`) is what actually
 * authorizes a self-service write; this guard has no role check.
 */
describe('requireConciergeSelfServiceAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeSurfaceMutation.mockReturnValue({ ok: true, status: 200, reason: 'token' });
    mocks.guardConciergeRequest.mockReturnValue(null);
  });

  it('allows a readonly-role bearer token through — no role check of its own', () => {
    expect(requireConciergeSelfServiceAccess(request('Bearer reader-token'))).toBeNull();
  });

  it('allows same-origin requests, matching the shared CSRF posture', () => {
    mocks.authorizeSurfaceMutation.mockReturnValue({
      ok: true,
      status: 200,
      reason: 'same-origin',
    });
    expect(requireConciergeSelfServiceAccess(request())).toBeNull();
  });

  it('rejects a request the shared CSRF check denies', async () => {
    mocks.authorizeSurfaceMutation.mockReturnValue({
      ok: false,
      status: 403,
      reason:
        'Forbidden. Use the same origin or provide KYBERION_API_TOKEN / KYBERION_LOCALADMIN_TOKEN.',
    });
    const response = requireConciergeSelfServiceAccess(request());
    expect(response?.status).toBe(403);
  });

  it('rejects a request after the shared token/method rate limit is exceeded', () => {
    mocks.guardConciergeRequest.mockReturnValue({ status: 429 });
    const response = requireConciergeSelfServiceAccess(request());
    expect(response?.status).toBe(429);
    expect(mocks.authorizeSurfaceMutation).not.toHaveBeenCalled();
  });
});
