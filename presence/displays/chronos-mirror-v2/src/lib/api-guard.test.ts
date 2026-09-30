import type { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function makeReq(
  options: {
    ip?: string;
    authorization?: string;
    cookie?: string;
    hostname?: string;
    forwardedFor?: string;
    method?: string;
    session?: string;
    headers?: Record<string, string>;
  } = {}
) {
  return {
    ip: options.ip,
    method: options.method ?? 'GET',
    headers: {
      get(name: string) {
        if (options.headers && name.toLowerCase() in options.headers) {
          return options.headers[name.toLowerCase()];
        }
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
        if (name === 'kyberion_session' && options.session) return { value: options.session };
        return undefined;
      },
    },
    nextUrl: {
      hostname: options.hostname,
    },
  } as unknown as NextRequest;
}

function mockSessionRole(role: 'readonly' | 'localadmin') {
  vi.doMock('@agent/core/authn-principal-resolver', () => ({
    resolveAuthnPrincipal: () => ({ principal: { role } }),
  }));
}

describe('api guard', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('@agent/core/authn-principal-resolver');
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

  it('does not trust a spoofed forwarded loopback peer unless proxy trust is enabled', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(resolveChronosAccessRole(makeReq({ forwardedFor: '127.0.0.1' }))).toBeNull();
  });

  it('still allows explicit loopback requests when the runtime exposes a local ip', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(resolveChronosAccessRole(makeReq({ ip: '127.0.0.1' }))).toBe('localadmin');
  });

  it('does not treat a localhost host header as a local peer when the client ip is unavailable', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(resolveChronosAccessRole(makeReq({ hostname: '127.0.0.1' }))).toBeNull();
    expect(resolveChronosAccessRole(makeReq({ hostname: 'localhost' }))).toBeNull();
  });

  it('does not trust a localhost hostname when forwarded identity is present', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    const request = makeReq({ hostname: '127.0.0.1', forwardedFor: '203.0.113.10' });
    expect(resolveChronosAccessRole(request)).toBeNull();
  });

  it('does not trust a localhost host header from a non-loopback peer', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    const { resolveChronosAccessRole } = await import('./api-guard.js');
    expect(
      resolveChronosAccessRole(makeReq({ ip: '203.0.113.10', hostname: 'localhost' }))
    ).toBeNull();
  });

  it('accepts the loopback forwarding address added by the self-hosted Next.js server', async () => {
    vi.stubEnv('KYBERION_LOCALHOST_AUTOADMIN', 'true');
    vi.stubEnv('KYBERION_TRUST_PROXY', 'true');
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

  it('accepts the registry boolean 1 form for explicit unauthenticated remote readonly access', async () => {
    vi.stubEnv('KYBERION_ALLOW_UNAUTH_REMOTE', '1');
    const { resolveChronosAccessRole } = await import('./api-guard.js');

    expect(resolveChronosAccessRole(makeReq({ ip: '203.0.113.10' }))).toBe('readonly');
  });

  describe('session cookie credential', () => {
    const session = 'kys1.payload.sig';
    const cookie = `kyberion_session=${session}`;

    it('falls back to the kyberion_session cookie after the legacy cookie', async () => {
      const { resolveChronosToken } = await import('./api-guard.js');
      expect(resolveChronosToken(makeReq({ session }))).toBe(session);
      expect(resolveChronosToken(makeReq({ session, cookie: 'legacy' }))).toBe('legacy');
      expect(resolveChronosToken(makeReq({ session, authorization: 'Bearer hdr' }))).toBe('hdr');
    });

    it('blocks a cross-origin cookie-authenticated POST with 403', async () => {
      mockSessionRole('localadmin');
      const { requireChronosAccess } = await import('./api-guard.js');
      const req = makeReq({
        ip: '127.0.0.1',
        method: 'POST',
        session,
        headers: { cookie, host: 'chronos.example', origin: 'https://evil.example' },
      });
      const res = requireChronosAccess(req, 'readonly');
      expect(res?.status).toBe(403);
      expect(await res?.json()).toEqual({ error: 'Cross-origin request blocked.' });
    });

    it('prefers a live browser session over a stale legacy token cookie', async () => {
      const live = `kys1.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')}.sig`;
      const expired = `kys1.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 600 })).toString('base64url')}.sig`;
      const { resolveChronosToken } = await import('./api-guard.js');
      expect(resolveChronosToken(makeReq({ session: live, cookie: 'legacy' }))).toBe(live);
      // an expired/unreadable session never masks a legacy token
      expect(resolveChronosToken(makeReq({ session: expired, cookie: 'legacy' }))).toBe('legacy');
      expect(
        resolveChronosToken(makeReq({ session: 'kys1.unreadable.sig', cookie: 'legacy' }))
      ).toBe('legacy');
      // a header still outranks both
      expect(
        resolveChronosToken(
          makeReq({ session: live, cookie: 'legacy', authorization: 'Bearer hdr' })
        )
      ).toBe('hdr');
    });

    it('resolves the access role of an OIDC browser session from the authn seam (fails closed otherwise)', async () => {
      const resolveAuthnPrincipal = vi.fn((request: { credential: { token: string } }) => {
        if (request.credential.token === session) return { principal: { role: 'readonly' } };
        throw new Error('browser session invalid or expired');
      });
      vi.doMock('@agent/core/authn-principal-resolver', () => ({ resolveAuthnPrincipal }));
      const { resolveChronosAccessRole } = await import('./api-guard.js');
      expect(resolveChronosAccessRole(makeReq({ session }))).toBe('readonly');
      expect(resolveChronosAccessRole(makeReq({ session: 'kys1.forged.sig' }))).toBeNull();
      // A session must not fall through to the loopback auto-admin path either.
      expect(
        resolveChronosAccessRole(makeReq({ ip: '127.0.0.1', session: 'kys1.forged.sig' }))
      ).toBeNull();
      vi.doUnmock('@agent/core/authn-principal-resolver');
    });

    it('treats a kys1. value planted in the legacy cookie as a session for the CSRF check', async () => {
      mockSessionRole('localadmin');
      const { requireChronosAccess } = await import('./api-guard.js');
      const req = makeReq({
        method: 'POST',
        cookie: session,
        headers: {
          cookie: `kyberion_token=${session}`,
          host: 'chronos.example',
          origin: 'https://evil.example',
        },
      });
      expect(requireChronosAccess(req, 'readonly')?.status).toBe(403);
    });

    it('does not apply the CSRF check to the pre-existing kyberion_token cookie', async () => {
      // plugin-views-e2e (and other scripted clients) replay the legacy token
      // cookie on POSTs without an Origin header; that path must keep working.
      vi.stubEnv('KYBERION_LOCALADMIN_TOKEN', 'legacy-token');
      const { requireChronosAccess } = await import('./api-guard.js');
      const req = makeReq({
        method: 'POST',
        cookie: 'legacy-token',
        headers: { cookie: 'kyberion_token=legacy-token', host: 'chronos.example' },
      });
      expect(requireChronosAccess(req, 'readonly')).toBeNull();
      // ...even when an (unused) session cookie is also present.
      const both = makeReq({
        method: 'POST',
        cookie: 'legacy-token',
        session,
        headers: { cookie, host: 'chronos.example', origin: 'https://evil.example' },
      });
      expect(requireChronosAccess(both, 'readonly')).toBeNull();
    });

    it('allows a same-origin cookie POST and never checks header-authenticated requests', async () => {
      mockSessionRole('localadmin');
      const { requireChronosAccess } = await import('./api-guard.js');
      const same = makeReq({
        method: 'POST',
        session,
        headers: { cookie, host: 'chronos.example', origin: 'https://chronos.example' },
      });
      expect(requireChronosAccess(same, 'readonly')).toBeNull();
      const header = makeReq({
        method: 'POST',
        authorization: `Bearer ${session}`,
        session,
        headers: { cookie, host: 'chronos.example', origin: 'https://evil.example' },
      });
      expect(requireChronosAccess(header, 'readonly')).toBeNull();
    });
  });
});
