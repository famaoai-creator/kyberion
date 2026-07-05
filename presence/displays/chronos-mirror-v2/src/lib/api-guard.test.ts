import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeReq(
  options: {
    ip?: string;
    authorization?: string;
    cookie?: string;
  } = {}
) {
  return {
    ip: options.ip,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'authorization') {
          return options.authorization || null;
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
