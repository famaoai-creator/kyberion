import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('next/headers', () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@agent/core/surface/surface-authn', () => ({
  resolveAuthnSurfaceViewerScope: mocks.resolve,
}));

import { SurfaceViewerScopeError } from '@agent/core/surface/surface-mutation-guard';
import { requireOperatorViewerAccess, resolveOperatorViewer } from './viewer-context.js';

const headersOf = (map: Record<string, string>) => ({
  get: (name: string) => map[name.toLowerCase()] ?? null,
});

beforeEach(() => {
  mocks.resolve.mockReset();
  mocks.resolve.mockReturnValue({ scope: { role: 'readonly', source: 'token', principalId: 'p' } });
});

describe('operator-surface viewer context', () => {
  it('passes the cookie session as bearer with loopback proof and read-only loopback role', () => {
    const viewer = resolveOperatorViewer({ cookie: 'kyberion_session=kys1.a.b', loopback: false });
    expect(mocks.resolve).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'kys1.a.b',
        local: false,
        allowLoopback: true,
        loopbackRole: 'readonly',
        surface: 'operator-surface',
      })
    );
    expect(viewer.credentialSource).toBe('session-cookie');
  });

  it('prefers an Authorization bearer over the cookie', () => {
    const viewer = resolveOperatorViewer({
      authorization: 'Bearer abc',
      cookie: 'kyberion_session=kys1.a.b',
      loopback: false,
    });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ token: 'abc' }));
    expect(viewer.credentialSource).toBe('header');
  });

  it('answers 401 JSON when the authn layer refuses', async () => {
    mocks.resolve.mockImplementation(() => {
      throw new SurfaceViewerScopeError(401, 'A viewer principal is required.');
    });
    const res = requireOperatorViewerAccess({
      method: 'POST',
      headers: headersOf({}),
      loopback: false,
    });
    expect(res?.status).toBe(401);
  });

  it('rejects a cross-origin cookie-authenticated mutation with 403', () => {
    const res = requireOperatorViewerAccess({
      method: 'POST',
      headers: headersOf({
        cookie: 'kyberion_session=kys1.a.b',
        host: 'ops.example',
        origin: 'https://evil.example',
      }),
      loopback: false,
    });
    expect(res?.status).toBe(403);
  });

  it('allows a same-origin cookie mutation and a loopback request', () => {
    expect(
      requireOperatorViewerAccess({
        method: 'POST',
        headers: headersOf({
          cookie: 'kyberion_session=kys1.a.b',
          host: 'ops.example',
          origin: 'https://ops.example',
        }),
        loopback: false,
      })
    ).toBeNull();
    expect(
      requireOperatorViewerAccess({ method: 'POST', headers: headersOf({}), loopback: true })
    ).toBeNull();
  });
});
