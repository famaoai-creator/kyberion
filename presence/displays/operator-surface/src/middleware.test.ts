import type { NextRequest } from 'next/server';
import { NextRequest as RealNextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOOPBACK_HEADER } from './lib/peer.js';
import { middleware, config } from './middleware.js';

const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;

function session(exp: number): string {
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `kys1.${body}.sig`;
}

function makeReq(
  options: {
    pathname?: string;
    method?: string;
    ip?: string;
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const req = new RealNextRequest(`http://ops.example${options.pathname ?? '/'}`, {
    method: options.method ?? 'GET',
    headers: options.headers,
  });
  if (options.ip) Object.defineProperty(req, 'ip', { value: options.ip });
  return req as NextRequest;
}

const nav = { 'sec-fetch-mode': 'navigate', accept: 'text/html' };

afterEach(() => vi.unstubAllEnvs());

describe('operator-surface middleware', () => {
  it('redirects an unauthenticated remote page navigation to /login', () => {
    const res = middleware(makeReq({ pathname: '/audit', headers: nav }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/login?next=%2Faudit');
  });

  it('returns 401 JSON for unauthenticated remote API calls', async () => {
    const res = middleware(makeReq({ pathname: '/api/inbox', method: 'POST' }));
    expect(res.status).toBe(401);
    expect((await res.json()).ok).toBe(false);
  });

  it('passes loopback peers through and marks them', () => {
    const res = middleware(makeReq({ pathname: '/audit', ip: '127.0.0.1', headers: nav }));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-' + LOOPBACK_HEADER)).toBe('1');
  });

  it('never trusts Host or an inbound loopback marker', () => {
    const res = middleware(
      makeReq({
        pathname: '/audit',
        headers: { ...nav, host: 'localhost:3331', [LOOPBACK_HEADER]: '1' },
      })
    );
    expect(res.status).toBe(302);
  });

  it('ignores forwarded headers unless KYBERION_TRUST_PROXY is set', () => {
    const headers = { ...nav, 'x-forwarded-for': '127.0.0.1' };
    expect(middleware(makeReq({ pathname: '/', headers })).status).toBe(302);
    vi.stubEnv('KYBERION_TRUST_PROXY', '1');
    expect(middleware(makeReq({ pathname: '/', headers })).status).toBe(200);
  });

  it('passes a remote request with an unexpired session cookie (server verifies)', () => {
    const res = middleware(
      makeReq({
        pathname: '/audit',
        headers: { ...nav, cookie: `kyberion_session=${session(FUTURE)}` },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-' + LOOPBACK_HEADER)).toBeNull();
  });

  it('redirects an expired or malformed session cookie', () => {
    for (const value of [session(PAST), 'garbage']) {
      const res = middleware(
        makeReq({ pathname: '/', headers: { ...nav, cookie: `kyberion_session=${value}` } })
      );
      expect(res.status).toBe(302);
    }
  });

  it('passes an Authorization header through to the route guard', () => {
    const res = middleware(
      makeReq({ pathname: '/api/inbox', method: 'POST', headers: { authorization: 'Bearer t' } })
    );
    expect(res.status).toBe(200);
  });

  it('keeps login routes reachable unauthenticated', () => {
    for (const pathname of ['/login', '/auth/start', '/auth/callback', '/logout']) {
      expect(middleware(makeReq({ pathname, headers: nav })).status).toBe(200);
    }
  });

  it('matches everything except static assets', () => {
    expect(config.matcher[0]).toContain('_next/static');
    expect(config.matcher[0]).toContain('favicon.ico');
  });
});
