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
  } = {}
) {
  return {
    ip: options.ip,
    headers: {
      get(name: string) {
        const key = name.toLowerCase();
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
        return undefined;
      },
    },
    nextUrl: {
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
});
