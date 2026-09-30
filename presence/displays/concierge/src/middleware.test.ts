import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';
import { middleware, config } from './middleware';

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

function session(expSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `kys1.${body}.sig`;
}

function run(path: string, headers: Record<string, string> = {}, loopback = false) {
  const req = new NextRequest(`https://app.example${path}`, {
    headers: loopback ? { ...headers, 'x-real-ip': '127.0.0.1' } : headers,
  });
  if (loopback) process.env.KYBERION_TRUST_PROXY = '1';
  return middleware(req);
}

describe('concierge middleware', () => {
  afterEach(() => {
    delete process.env.KYBERION_TRUST_PROXY;
  });

  it('redirects an unauthenticated remote page navigation to /login?next', () => {
    const res = run('/settings?tab=a', NAV);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example/login?next=' + encodeURIComponent('/settings?tab=a')
    );
  });

  it('serves installability assets to an unauthenticated remote browser (no /login bounce)', () => {
    for (const path of [
      '/manifest.webmanifest',
      '/sw.js',
      '/offline.html',
      '/icons/icon-192.png',
    ]) {
      expect(run(path, NAV).headers.get('location')).toBeNull();
    }
    // Lookalikes are not exempt.
    expect(run('/sw.js.map', NAV).status).toBe(302);
    expect(run('/iconsx/a.png', NAV).status).toBe(302);
  });

  it('never redirects loopback', () => {
    expect(run('/', NAV, true).headers.get('location')).toBeNull();
  });

  it('leaves API calls untouched', () => {
    expect(run('/api/me', { accept: 'application/json' }).headers.get('location')).toBeNull();
    expect(run('/api/me', NAV).headers.get('location')).toBeNull();
  });

  it('passes through with the token hint cookie, Authorization, or a valid session', () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    expect(
      run('/', { ...NAV, cookie: 'kyberion_client_token=1' }).headers.get('location')
    ).toBeNull();
    expect(run('/', { ...NAV, authorization: 'Bearer t' }).headers.get('location')).toBeNull();
    expect(
      run('/', { ...NAV, cookie: `kyberion_session=${session(future)}` }).headers.get('location')
    ).toBeNull();
  });

  it('redirects an expired or malformed session cookie', () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    expect(run('/', { ...NAV, cookie: `kyberion_session=${session(past)}` }).status).toBe(302);
    expect(run('/', { ...NAV, cookie: 'kyberion_session=garbage' }).status).toBe(302);
  });

  it('keeps /login, /signin and auth routes reachable', () => {
    for (const p of ['/login', '/signin', '/auth/start', '/auth/callback', '/logout']) {
      expect(run(p, NAV).headers.get('location')).toBeNull();
    }
  });

  it('excludes static assets from the matcher', () => {
    expect(config.matcher[0]).toContain('_next/static');
    expect(config.matcher[0]).toContain('favicon.ico');
  });
});
