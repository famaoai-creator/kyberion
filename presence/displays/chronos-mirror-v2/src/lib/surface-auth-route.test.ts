import type { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

function makeReq(pathname: string, ip?: string) {
  const url = new URL(`https://chronos.example${pathname}`);
  return {
    ip,
    method: 'GET',
    headers: { get: () => null },
    cookies: { get: () => undefined },
    nextUrl: url,
  } as unknown as NextRequest;
}

describe('chronos surface auth route helper', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('serves the login page as html with security headers when OIDC is unconfigured', async () => {
    vi.stubEnv('KYBERION_OIDC_ISSUER', '');
    const { handleChronosAuthRoute } = await import('./surface-auth-route.js');
    const res = await handleChronosAuthRoute(makeReq('/login', '203.0.113.7'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(await res.text()).toContain('KYBERION_OIDC_ISSUER');
  });

  it('returns 404 for paths that are not auth routes', async () => {
    const { handleChronosAuthRoute } = await import('./surface-auth-route.js');
    expect((await handleChronosAuthRoute(makeReq('/other'))).status).toBe(404);
  });
});
