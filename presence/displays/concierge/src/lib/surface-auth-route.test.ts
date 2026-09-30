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
