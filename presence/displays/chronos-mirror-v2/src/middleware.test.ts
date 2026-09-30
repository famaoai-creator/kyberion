import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { middleware } from './middleware.js';

function makeReq(
  options: {
    pathname?: string;
    ip?: string;
    authorization?: string;
    cookie?: string;
    forwardedFor?: string;
    realIp?: string;
    method?: string;
    headers?: Record<string, string>;
    session?: string;
    search?: string;
  } = {}
) {
  return {
    ip: options.ip,
    url: `https://chronos.example.com${options.pathname ?? '/api/status'}${options.search ?? ''}`,
    method: options.method ?? 'GET',
    headers: {
      get(name: string) {
        const key = name.toLowerCase();
        if (options.headers && key in options.headers) return options.headers[key];
        if (key === 'authorization') return options.authorization || null;
        if (key === 'x-forwarded-for') return options.forwardedFor || null;
        if (key === 'x-real-ip') return options.realIp || null;
        return null;
      },
    },
    cookies: {
      get(name: string) {
        if (name === 'kyberion_token' && options.cookie) {
          return { value: options.cookie };
        }
        if (name === 'kyberion_session' && options.session) return { value: options.session };
        return undefined;
      },
    },
    nextUrl: {
      search: options.search ?? '',
      pathname: options.pathname ?? '/api/missions',
    },
  } as unknown as NextRequest;
}

describe('chronos middleware', () => {
  beforeEach(() => {
    vi.stubEnv('KYBERION_TRUST_PROXY', '');
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a spoofed forwarded loopback peer when proxy trust is disabled', () => {
    expect(middleware(makeReq({ forwardedFor: '127.0.0.1' })).status).toBe(401);
    expect(middleware(makeReq({ realIp: '127.0.0.1' })).status).toBe(401);
  });

  it('rejects forwarded loopback for explicitly falsy trust-proxy values', () => {
    for (const value of ['0', 'false', 'no', 'off', '', 'maybe']) {
      vi.stubEnv('KYBERION_TRUST_PROXY', value);
      expect(middleware(makeReq({ forwardedFor: '127.0.0.1' })).status).toBe(401);
    }
  });

  it('accepts a forwarded loopback peer when proxy trust is enabled', () => {
    for (const value of ['1', 'true', 'YES', 'On']) {
      vi.stubEnv('KYBERION_TRUST_PROXY', value);
      expect(middleware(makeReq({ forwardedFor: '127.0.0.1' })).status).not.toBe(401);
      expect(middleware(makeReq({ realIp: '::1' })).status).not.toBe(401);
    }
  });

  it('still rejects a trusted forwarded peer that is not loopback', () => {
    vi.stubEnv('KYBERION_TRUST_PROXY', '1');
    expect(middleware(makeReq({ forwardedFor: '203.0.113.7' })).status).toBe(401);
  });

  it('accepts a direct loopback peer without proxy trust', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(middleware(makeReq({ ip })).status).not.toBe(401);
    }
  });

  it('rejects a direct remote peer without a credential', () => {
    expect(middleware(makeReq({ ip: '203.0.113.7' })).status).toBe(401);
  });

  it('accepts any request that carries a credential', () => {
    expect(middleware(makeReq({ authorization: 'Bearer token' })).status).not.toBe(401);
    expect(middleware(makeReq({ cookie: 'session-token' })).status).not.toBe(401);
    expect(
      middleware(makeReq({ ip: '203.0.113.7', authorization: 'Bearer token' })).status
    ).not.toBe(401);
  });

  it('leaves /api/healthz open as the sole public probe', () => {
    expect(middleware(makeReq({ pathname: '/api/healthz' })).status).not.toBe(401);
  });

  describe('browser login redirect', () => {
    const nav = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    const token = (exp: number) =>
      `kys1.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`;
    const future = Math.floor(Date.now() / 1000) + 3600;

    it('redirects an unauthenticated remote page navigation to /login', () => {
      const res = middleware(
        makeReq({ pathname: '/missions', ip: '203.0.113.7', headers: nav, search: '?a=1' })
      );
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') ?? '');
      expect(location.origin).toBe('https://chronos.example.com');
      expect(location.pathname).toBe('/login');
      expect(location.searchParams.get('next')).toBe('/missions?a=1');
    });

    it('keeps API calls as 401 JSON even with navigation headers', () => {
      const res = middleware(makeReq({ ip: '203.0.113.7', headers: nav }));
      expect(res.status).toBe(401);
    });

    it('never redirects loopback', () => {
      const res = middleware(makeReq({ pathname: '/', ip: '127.0.0.1', headers: nav }));
      expect(res.status).not.toBe(302);
    });

    it('leaves the login routes reachable unauthenticated', () => {
      for (const pathname of ['/login', '/auth/start', '/auth/callback', '/logout']) {
        const res = middleware(makeReq({ pathname, ip: '203.0.113.7', headers: nav }));
        expect(res.status).toBe(200);
      }
    });

    it('accepts a session cookie as a credential', () => {
      const session = token(future);
      expect(
        middleware(makeReq({ pathname: '/', ip: '203.0.113.7', headers: nav, session })).status
      ).toBe(200);
      expect(middleware(makeReq({ ip: '203.0.113.7', session })).status).toBe(200);
    });

    it('redirects a page navigation whose only credential is an expired session cookie', () => {
      const session = token(Math.floor(Date.now() / 1000) - 10);
      const res = middleware(makeReq({ pathname: '/', ip: '203.0.113.7', headers: nav, session }));
      expect(res.status).toBe(302);
      // APIs still defer verification to the route guard.
      expect(middleware(makeReq({ ip: '203.0.113.7', session })).status).toBe(200);
    });

    it('does not redirect header-authenticated page requests', () => {
      const res = middleware(
        makeReq({ pathname: '/', ip: '203.0.113.7', headers: nav, authorization: 'Bearer t' })
      );
      expect(res.status).toBe(200);
    });
  });
});
