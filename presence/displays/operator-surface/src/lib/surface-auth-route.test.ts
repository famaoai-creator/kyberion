import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { handleOperatorAuthRoute } from './surface-auth-route.js';

afterEach(() => vi.unstubAllEnvs());

describe('operator-surface login route adapter', () => {
  it('serves the login page as HTML with security headers, naming the missing OIDC config', async () => {
    vi.stubEnv('KYBERION_OIDC_ISSUER', '');
    const res = await handleOperatorAuthRoute(
      new NextRequest('http://ops.example/login', { headers: { accept: 'text/html' } })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(await res.text()).toContain('KYBERION_OIDC_ISSUER');
  });

  it('logout clears the session cookie and redirects to /login', async () => {
    const res = await handleOperatorAuthRoute(new NextRequest('http://ops.example/logout'));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login');
    expect(res.headers.get('set-cookie')).toContain('kyberion_session=');
  });
});
