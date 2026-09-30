import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authn = vi.hoisted(() => ({ resolve: vi.fn() }));

vi.mock('@agent/core/surface/surface-authn', () => ({
  resolveAuthnSurfaceViewerScope: authn.resolve,
}));
vi.mock('@agent/core/chronos-access-registry', async () => ({
  ...(await vi.importActual<typeof import('@agent/core/chronos-access-registry')>(
    '@agent/core/chronos-access-registry'
  )),
  readChronosTokenRegistrations: () => [],
}));

import { conciergeCredential, resolveConciergeViewerContext } from './viewer-context';

const SCOPE = {
  role: 'localadmin' as const,
  tenantSlugs: ['t'],
  organizationIds: 'all' as const,
  projectIds: 'all' as const,
  tierAccess: ['confidential', 'public'] as Array<'confidential' | 'public'>,
  source: 'token' as const,
};

function req(headers: Record<string, string>) {
  return new NextRequest('https://app.example/api/me', { headers });
}

describe('concierge session-cookie credential', () => {
  beforeEach(() => {
    authn.resolve.mockReset();
    authn.resolve.mockReturnValue({ scope: SCOPE, principal: undefined });
  });

  it('reports the credential source', () => {
    expect(conciergeCredential(req({ authorization: 'Bearer abc' }))).toEqual({
      token: 'abc',
      source: 'header',
    });
    expect(conciergeCredential(req({ cookie: 'kyberion_session=kys1.a.b' }))).toEqual({
      token: 'kys1.a.b',
      source: 'session-cookie',
    });
    expect(conciergeCredential(req({}))).toEqual({ token: null, source: 'none' });
  });

  it('resolves a viewer from the session cookie via the authn layer', () => {
    const ctx = resolveConciergeViewerContext(req({ cookie: 'kyberion_session=kys1.a.b' }));
    expect(authn.resolve.mock.calls[0][0].token).toBe('kys1.a.b');
    expect(ctx.role).toBe('localadmin');
  });

  it('prefers the Authorization header over the cookie', () => {
    resolveConciergeViewerContext(
      req({ authorization: 'Bearer hdr', cookie: 'kyberion_session=kys1.a.b' })
    );
    expect(authn.resolve.mock.calls[0][0].token).toBe('hdr');
  });
});
