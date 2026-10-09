import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { handleConciergeAuthRoute } from './surface-auth-route';
import { GET } from '../app/login/route';

describe('concierge auth route adapter', () => {
  it('serves the HTML login page when OIDC is not configured', async () => {
    const res = await handleConciergeAuthRoute(new NextRequest('http://localhost:3050/login'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBeTruthy();
    expect(await res.text()).toContain('/signin');
  });

  it('is wired through the login route handler', async () => {
    const res = await GET(new NextRequest('http://localhost:3050/login'));
    expect(res.status).toBe(200);
  });
});

describe('concierge validated logout cleanup', () => {
  it.each(['GET', 'POST'])('serves cleanup only after a same-origin %s logout', async (method) => {
    const res = await handleConciergeAuthRoute(
      new NextRequest('https://concierge.example/logout?lang=ja&next=https://untrusted.invalid', {
        method,
        headers: { 'sec-fetch-site': 'same-origin' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie')).toContain('kyberion_session=;');
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(res.headers.get('set-cookie')).toContain('Secure');
    const html = await res.text();
    expect(html).toContain('window.sessionStorage');
    expect(html).toContain('このタブを閉じて');
    expect(html).not.toContain('untrusted.invalid');
  });

  it.each([
    { method: 'GET', site: 'cross-site', status: 403 },
    { method: 'POST', site: 'same-site', status: 403 },
    { method: 'PUT', site: 'same-origin', status: 405 },
    { method: 'HEAD', site: 'same-origin', status: 405 },
  ])('preserves denied $method/$site responses', async ({ method, site, status }) => {
    const res = await handleConciergeAuthRoute(
      new NextRequest('http://localhost:3050/logout', {
        method,
        headers: { 'sec-fetch-site': site },
      })
    );
    expect(res.status).toBe(status);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).not.toContain('window.sessionStorage');
    if (status === 405) expect(res.headers.get('allow')).toBe('GET, POST');
  });

  it('keeps the shared referrer-origin denial intact', async () => {
    const res = await handleConciergeAuthRoute(
      new NextRequest('http://localhost:3050/logout', {
        headers: { origin: 'https://untrusted.invalid' },
      })
    );
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).not.toContain('window.sessionStorage');
  });
});
