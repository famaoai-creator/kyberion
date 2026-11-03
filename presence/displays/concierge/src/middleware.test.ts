import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const bootstrap = vi.hoisted(() => ({ open: true }));
vi.mock('@agent/core/surface/first-run-setup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/surface/first-run-setup')>()),
  readFirstRunStatus: () => ({
    state: bootstrap.open ? 'unclaimed' : 'claimed',
    code_active: false,
  }),
}));

import { resetInstallationBootstrapCache } from '@agent/core/surface/installation-owner-access';
import { proxy as middleware, config } from './proxy';
import { withLocalPeerRequest } from '../test/local-peer-fixture';

const NAV = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

function session(expSeconds: number): string {
  const body = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `kys1.${body}.sig`;
}

function run(path: string, headers: Record<string, string> = {}, loopback = false) {
  const req = new NextRequest(`https://app.example${path}`, {
    headers,
  });
  return loopback ? withLocalPeerRequest(req, middleware) : middleware(req);
}

describe('concierge middleware', () => {
  afterEach(() => {
    delete process.env.KYBERION_TRUST_PROXY;
    vi.unstubAllEnvs();
    bootstrap.open = true;
    resetInstallationBootstrapCache();
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

  it('never redirects loopback while bootstrap is open', () => {
    expect(run('/', NAV, true).headers.get('location')).toBeNull();
  });

  it('sends a credential-less loopback navigation to /login once an owner is bound', () => {
    bootstrap.open = false;
    resetInstallationBootstrapCache();
    const res = run('/settings', NAV, true);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://app.example/login?next=' + encodeURIComponent('/settings')
    );
    // First-run setup and the login flow stay reachable.
    expect(run('/setup/first-run', NAV, true).headers.get('location')).toBeNull();
    expect(run('/login', NAV, true).headers.get('location')).toBeNull();
  });

  it('keeps loopback unredirected with the anonymous-loopback escape hatch', () => {
    bootstrap.open = false;
    resetInstallationBootstrapCache();
    vi.stubEnv('KYBERION_CONCIERGE_ALLOW_ANONYMOUS_LOOPBACK', '1');
    expect(run('/', NAV, true).headers.get('location')).toBeNull();
  });

  it('does not grant a loopback navigation hint from forwarded headers', () => {
    process.env.KYBERION_TRUST_PROXY = '1';
    expect(run('/', { ...NAV, 'x-real-ip': '127.0.0.1' }).status).toBe(302);
    expect(config).not.toHaveProperty('runtime');
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
    for (const p of [
      '/login',
      '/signin',
      '/setup/first-run',
      '/auth/start',
      '/auth/callback',
      '/logout',
    ]) {
      expect(run(p, NAV).headers.get('location')).toBeNull();
    }
  });

  it('excludes static assets from the matcher', () => {
    expect(config.matcher[0]).toContain('_next/static');
    expect(config.matcher[0]).toContain('favicon.ico');
  });
});
