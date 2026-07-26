import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeReq(
  options: {
    ip?: string;
    authorization?: string;
    cookie?: string;
    hostname?: string;
    forwardedFor?: string;
  } = {}
) {
  return {
    ip: options.ip,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'authorization') {
          return options.authorization || null;
        }
        if (name.toLowerCase() === 'x-forwarded-for') {
          return options.forwardedFor || null;
        }
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
      hostname: options.hostname,
    },
  } as unknown as NextRequest;
}

describe('api guard', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not treat forwarded headers as a local admin signal', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(
      resolveChronosAccessRole(
        makeReq({
          ip: undefined,
          authorization: undefined,
          cookie: undefined,
        })
      )
    ).toBeNull();
  });

  it('still allows explicit loopback requests when the runtime exposes a local ip', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(resolveChronosAccessRole(makeReq({ ip: '127.0.0.1' }))).toBe('localadmin');
  });

  it('allows direct localhost requests when self-hosted Next.js omits the client ip', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(resolveChronosAccessRole(makeReq({ hostname: '127.0.0.1' }))).toBe('localadmin');
    expect(resolveChronosAccessRole(makeReq({ hostname: 'localhost' }))).toBe('localadmin');
  });

  it('does not trust a localhost hostname when forwarded identity is present', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    const request = makeReq({ hostname: '127.0.0.1', forwardedFor: '203.0.113.10' });
    expect(resolveChronosAccessRole(request)).toBeNull();
  });

  it('accepts the loopback forwarding address added by the self-hosted Next.js server', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(
      resolveChronosAccessRole({
        ...makeReq({ hostname: '127.0.0.1', forwardedFor: '::ffff:127.0.0.1' }),
        ip: undefined,
      } as any)
    ).toBe('localadmin');
  });

  it('accepts bearer token auth regardless of ip visibility', async () => {
    vi.stubEnv('KYBERION_API_TOKEN', 'api-token');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(
      resolveChronosAccessRole(
        makeReq({
          ip: undefined,
          authorization: 'Bearer api-token',
        })
      )
    ).toBe('readonly');
  });
});
