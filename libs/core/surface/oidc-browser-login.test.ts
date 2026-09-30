import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeWriteFile, safeExistsSync } from '../secure-io.js';
import {
  completeOidcLogin,
  loginTransactionCookieName,
  resetOidcLoginCachesForTests,
  resolveOidcLoginConfig,
  resolveOidcRedirectOrigin,
  startOidcLogin,
  type OidcLoginDeps,
  type OidcLoginFetchRequest,
} from './oidc-browser-login.js';
import { handleSurfaceAuthRoute } from './surface-auth-routes.js';
import { mintBrowserSessionToken, verifyBrowserSessionToken } from '../authn-providers.js';
import { resolveAuthnPrincipal } from '../authn-principal-resolver.js';
import {
  SURFACE_SESSION_COOKIE,
  extractSurfaceSessionToken,
  parseCookieHeader,
} from './surface-session-cookie.js';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'kyberion-client';
const TMP_DIR = `active/shared/tmp/oidc-browser-login-tests-${process.pid}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = {
  ...(publicKey.export({ format: 'jwk' }) as object),
  kid: 'k1',
  use: 'sig',
  alg: 'RS256',
};

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function idToken(claims: Record<string, unknown>, kid = 'k1'): string {
  const head = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const body = b64(claims);
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString(
    'base64url'
  );
  return `${head}.${body}.${signature}`;
}

let memberRoot = '';
let counter = 0;

function seedMember(external: { issuer: string; subject: string } | null, status = 'active'): void {
  memberRoot = pathResolver.rootResolve(`${TMP_DIR}/members-${++counter}`);
  const dir = `${memberRoot}/knowledge/personal/members`;
  safeMkdir(dir, { recursive: true });
  safeWriteFile(
    `${dir}/carol.json`,
    JSON.stringify({
      member_id: 'carol',
      display_name: 'Carol',
      status,
      memberships: [{ tenant_slug: 'acme-corp', role: 'viewer' }],
      access_registrations: [],
      external_identities: external ? [external] : [],
      created_at: '2026-09-30T00:00:00.000Z',
      updated_at: '2026-09-30T00:00:00.000Z',
    })
  );
}

interface IdpState {
  nonceFor: Map<string, string>;
  tokenClaims: (nonce: string) => Record<string, unknown>;
  calls: OidcLoginFetchRequest[];
  failToken: boolean;
}

function makeIdp(): { state: IdpState; fetchJson: NonNullable<OidcLoginDeps['fetchJson']> } {
  const state: IdpState = {
    nonceFor: new Map(),
    calls: [],
    failToken: false,
    tokenClaims: (nonce) => ({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: 'idp-subject-1',
      nonce,
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  };
  const fetchJson = async (request: OidcLoginFetchRequest): Promise<unknown> => {
    state.calls.push(request);
    if (request.url === `${ISSUER}/.well-known/openid-configuration`) {
      return {
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        jwks_uri: `${ISSUER}/jwks`,
        token_endpoint_auth_methods_supported: ['client_secret_post'],
      };
    }
    if (request.url === `${ISSUER}/jwks`) return { keys: [jwk] };
    if (request.url === `${ISSUER}/token`) {
      if (state.failToken) throw new Error('invalid_grant');
      const code = request.form?.code ?? '';
      const nonce = state.nonceFor.get(code) ?? '';
      return { id_token: idToken(state.tokenClaims(nonce)) };
    }
    throw new Error(`unexpected url ${request.url}`);
  };
  return { state, fetchJson };
}

function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    KYBERION_OIDC_ISSUER: ISSUER,
    KYBERION_OIDC_CLIENT_ID: CLIENT_ID,
    KYBERION_OIDC_CLIENT_SECRET: 'client-secret',
    KYBERION_SESSION_SECRET: 'session-secret-for-tests',
    KYBERION_OIDC_PUBLIC_BASE_URL: 'https://desk.example.com',
    ...extra,
  };
}

async function runLogin(
  deps: OidcLoginDeps,
  idp: ReturnType<typeof makeIdp>,
  options: { next?: string; tamperState?: boolean } = {}
) {
  const started = await startOidcLogin(
    {
      surfaceId: 'concierge',
      requestOrigin: 'https://desk.example.com',
      loopback: false,
      next: options.next,
    },
    deps
  );
  if (started.ok === false) throw new Error('start failed');
  const url = new URL(started.location);
  const code = 'code-1';
  idp.state.nonceFor.set(code, url.searchParams.get('nonce') ?? '');
  return {
    url,
    started,
    result: await completeOidcLogin(
      {
        surfaceId: 'concierge',
        query: { code, state: options.tamperState ? 'other' : url.searchParams.get('state') },
        transactionCookie: started.transactionCookie.value,
      },
      deps
    ),
  };
}

beforeEach(() => resetOidcLoginCachesForTests());
afterAll(() => {
  const dir = pathResolver.rootResolve(TMP_DIR);
  if (safeExistsSync(dir)) safeRmSync(dir, { recursive: true, force: true });
});

describe('resolveOidcLoginConfig', () => {
  it('reports exactly what an operator still has to set', () => {
    const { config, missing } = resolveOidcLoginConfig({ env: {} });
    expect(config).toBeNull();
    expect(missing).toEqual([
      'KYBERION_OIDC_ISSUER',
      'KYBERION_OIDC_CLIENT_ID',
      'KYBERION_SESSION_SECRET',
    ]);
  });

  it('requires a declared public origin off loopback and never trusts Host there', () => {
    const { config } = resolveOidcLoginConfig({
      env: { ...baseEnv(), KYBERION_OIDC_PUBLIC_BASE_URL: '' },
    });
    expect(config).not.toBeNull();
    expect(
      resolveOidcRedirectOrigin(config!, {
        surfaceId: 'concierge',
        requestOrigin: 'https://evil.example',
        loopback: false,
      })
    ).toBeNull();
    expect(
      resolveOidcRedirectOrigin(config!, {
        surfaceId: 'concierge',
        requestOrigin: 'http://127.0.0.1:3050',
        loopback: true,
      })
    ).toBe('http://127.0.0.1:3050');
  });

  it('reuses a loopback-NAMED request origin even when the peer is not proven loopback (Next.js)', () => {
    const { config } = resolveOidcLoginConfig({
      env: { ...baseEnv(), KYBERION_OIDC_PUBLIC_BASE_URL: '' },
    });
    for (const origin of ['http://localhost:3050', 'http://127.0.0.1:3000', 'http://[::1]:3331']) {
      expect(
        resolveOidcRedirectOrigin(config!, {
          surfaceId: 'concierge',
          requestOrigin: origin,
          loopback: false,
        })
      ).toBe(origin);
    }
    // A foreign Host header must never pick the redirect target.
    for (const origin of [
      'https://evil.example',
      'http://localhost.evil.example',
      'http://evil.example:3050',
    ]) {
      expect(
        resolveOidcRedirectOrigin(config!, {
          surfaceId: 'concierge',
          requestOrigin: origin,
          loopback: false,
        })
      ).toBeNull();
    }
  });

  it('prefers a per-surface public origin and rejects plain http off loopback', () => {
    const env = baseEnv({
      KYBERION_OIDC_PUBLIC_BASE_URLS:
        'concierge=https://desk.example.com,chronos-mirror-v2=http://ops.example.com',
    });
    const { config } = resolveOidcLoginConfig({ env });
    expect(
      resolveOidcRedirectOrigin(config!, {
        surfaceId: 'concierge',
        requestOrigin: '',
        loopback: false,
      })
    ).toBe('https://desk.example.com');
    expect(
      resolveOidcRedirectOrigin(config!, {
        surfaceId: 'chronos-mirror-v2',
        requestOrigin: '',
        loopback: false,
      })
    ).toBeNull();
  });
});

describe('OIDC browser login (mock IdP)', () => {
  it('start builds a PKCE+state+nonce authorize URL and a signed transaction cookie', async () => {
    const idp = makeIdp();
    const started = await startOidcLogin(
      {
        surfaceId: 'concierge',
        requestOrigin: 'https://desk.example.com',
        loopback: false,
        next: '/settings',
      },
      { env: baseEnv(), fetchJson: idp.fetchJson }
    );
    if (started.ok === false) throw new Error('start failed');
    const url = new URL(started.location);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('https://desk.example.com/auth/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(started.transactionCookie.name).toBe(loginTransactionCookieName('concierge'));
    expect(started.transactionCookie.value.startsWith('kyt1.')).toBe(true);
  });

  it('mints a session for an id_token whose iss+sub is bound to an active member', async () => {
    seedMember({ issuer: ISSUER, subject: 'idp-subject-1' });
    const idp = makeIdp();
    const deps: OidcLoginDeps = {
      env: baseEnv(),
      fetchJson: idp.fetchJson,
      memberRegistry: { rootDir: memberRoot },
    };
    const { url, result } = await runLogin(deps, idp, { next: '/settings' });
    if (result.ok === false) throw new Error(`expected ok, got ${JSON.stringify(result.view)}`);
    expect(result.next).toBe('/settings');
    expect(result.memberId).toBe('carol');
    const payload = verifyBrowserSessionToken(result.sessionToken, { env: baseEnv() });
    expect(payload).toMatchObject({ idp_iss: ISSUER, sub: 'idp-subject-1' });
    // PKCE verifier must have been sent, and matches the challenge.
    const tokenCall = idp.state.calls.find((c) => c.url === `${ISSUER}/token`)!;
    expect(tokenCall.form?.client_secret).toBe('client-secret');
    expect(createHash('sha256').update(tokenCall.form!.code_verifier!).digest('base64url')).toBe(
      url.searchParams.get('code_challenge')
    );
    expect(tokenCall.form?.redirect_uri).toBe('https://desk.example.com/auth/callback');
  });

  it('gives an unbound IdP account NO session and shows its identifiers instead', async () => {
    seedMember(null);
    const idp = makeIdp();
    const { result } = await runLogin(
      { env: baseEnv(), fetchJson: idp.fetchJson, memberRegistry: { rootDir: memberRoot } },
      idp
    );
    expect(result).toMatchObject({
      ok: false,
      status: 403,
      view: { kind: 'unbound', issuer: ISSUER, subject: 'idp-subject-1' },
    });
  });

  it('refuses a member that is suspended', async () => {
    seedMember({ issuer: ISSUER, subject: 'idp-subject-1' }, 'suspended');
    const idp = makeIdp();
    const { result } = await runLogin(
      { env: baseEnv(), fetchJson: idp.fetchJson, memberRegistry: { rootDir: memberRoot } },
      idp
    );
    expect(result).toMatchObject({ ok: false, view: { kind: 'suspended' } });
  });

  it.each([['a wrong state', { tamperState: true }, 'state_mismatch']])(
    'rejects %s',
    async (_label, options, code) => {
      seedMember({ issuer: ISSUER, subject: 'idp-subject-1' });
      const idp = makeIdp();
      const { result } = await runLogin(
        { env: baseEnv(), fetchJson: idp.fetchJson, memberRegistry: { rootDir: memberRoot } },
        idp,
        options
      );
      expect(result).toMatchObject({ ok: false, view: { kind: 'failed', code } });
    }
  );

  it('rejects a nonce mismatch, wrong audience, wrong issuer and a forged signature', async () => {
    seedMember({ issuer: ISSUER, subject: 'idp-subject-1' });
    for (const mutate of [
      (c: Record<string, unknown>) => ({ ...c, nonce: 'replayed' }),
      (c: Record<string, unknown>) => ({ ...c, aud: 'someone-else' }),
      (c: Record<string, unknown>) => ({ ...c, iss: 'https://evil.example' }),
      (c: Record<string, unknown>) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 10 }),
    ]) {
      resetOidcLoginCachesForTests();
      const idp = makeIdp();
      const original = idp.state.tokenClaims;
      idp.state.tokenClaims = (nonce) => mutate(original(nonce));
      const { result } = await runLogin(
        { env: baseEnv(), fetchJson: idp.fetchJson, memberRegistry: { rootDir: memberRoot } },
        idp
      );
      expect(result).toMatchObject({ ok: false, view: { kind: 'failed', code: 'token_invalid' } });
    }
    // Forged: valid claims, signature from a different key.
    resetOidcLoginCachesForTests();
    const idp = makeIdp();
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const forged = (nonce: string) => {
      const head = b64({ alg: 'RS256', kid: 'k1' });
      const body = b64(idp.state.tokenClaims(nonce));
      return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), other.privateKey).toString('base64url')}`;
    };
    const wrapped: typeof idp.fetchJson = async (request) => {
      if (request.url === `${ISSUER}/token`) {
        const nonce = idp.state.nonceFor.get(request.form?.code ?? '') ?? '';
        return { id_token: forged(nonce) };
      }
      return idp.fetchJson(request);
    };
    const { result } = await runLogin(
      { env: baseEnv(), fetchJson: wrapped, memberRegistry: { rootDir: memberRoot } },
      idp
    );
    expect(result).toMatchObject({ ok: false, view: { kind: 'failed', code: 'token_invalid' } });
  });

  it('reports a token exchange failure and an expired/missing transaction', async () => {
    seedMember({ issuer: ISSUER, subject: 'idp-subject-1' });
    const idp = makeIdp();
    idp.state.failToken = true;
    const { result } = await runLogin(
      { env: baseEnv(), fetchJson: idp.fetchJson, memberRegistry: { rootDir: memberRoot } },
      idp
    );
    expect(result).toMatchObject({ ok: false, view: { kind: 'failed', code: 'exchange_failed' } });
    const missing = await completeOidcLogin(
      { surfaceId: 'concierge', query: { code: 'x', state: 'y' }, transactionCookie: null },
      { env: baseEnv(), fetchJson: idp.fetchJson }
    );
    expect(missing).toMatchObject({ ok: false, view: { kind: 'failed', code: 'expired' } });
  });

  it('a transaction cookie from another surface cannot complete this one', async () => {
    seedMember({ issuer: ISSUER, subject: 'idp-subject-1' });
    const idp = makeIdp();
    const deps: OidcLoginDeps = {
      env: baseEnv(),
      fetchJson: idp.fetchJson,
      memberRegistry: { rootDir: memberRoot },
    };
    const started = await startOidcLogin(
      {
        surfaceId: 'chronos-mirror-v2',
        requestOrigin: 'https://desk.example.com',
        loopback: false,
      },
      deps
    );
    if (started.ok === false) throw new Error('start failed');
    const url = new URL(started.location);
    idp.state.nonceFor.set('c', url.searchParams.get('nonce') ?? '');
    const result = await completeOidcLogin(
      {
        surfaceId: 'concierge',
        query: { code: 'c', state: url.searchParams.get('state') },
        transactionCookie: started.transactionCookie.value,
      },
      deps
    );
    expect(result).toMatchObject({ ok: false, view: { kind: 'failed', code: 'state_mismatch' } });
  });

  it('does not start when SSO is not configured and says what is missing', async () => {
    const started = await startOidcLogin(
      { surfaceId: 'concierge', requestOrigin: 'http://127.0.0.1:3050', loopback: true },
      { env: {} }
    );
    expect(started).toMatchObject({ ok: false, view: { kind: 'unconfigured' } });
  });
});

describe('handleSurfaceAuthRoute', () => {
  const req = (over: Partial<Parameters<typeof handleSurfaceAuthRoute>[0]>) => ({
    surfaceId: 'concierge',
    surfaceLabel: 'Concierge',
    method: 'GET',
    pathname: '/login',
    searchParams: new URLSearchParams(),
    requestOrigin: 'https://desk.example.com',
    loopback: false,
    ...over,
  });

  it('ignores paths outside the login flow', async () => {
    expect(
      await handleSurfaceAuthRoute(req({ pathname: '/api/me' }), { env: baseEnv() })
    ).toBeNull();
  });

  it('serves an explanatory page (not JSON) when SSO is unconfigured', async () => {
    const res = await handleSurfaceAuthRoute(req({}), { env: {} });
    expect(res?.status).toBe(200);
    expect(res?.headers['Content-Type']).toContain('text/html');
    expect(res?.body).toContain('KYBERION_OIDC_ISSUER');
    expect(res?.headers['Content-Security-Policy']).toContain("default-src 'none'");
  });

  it('renders the sign-in button with a safe next and localizes to Japanese', async () => {
    const res = await handleSurfaceAuthRoute(
      req({
        searchParams: new URLSearchParams({ next: '//evil.example/x' }),
        acceptLanguage: 'ja-JP,ja;q=0.9',
      }),
      { env: baseEnv() }
    );
    expect(res?.body).toContain('でサインイン');
    expect(res?.body).toContain('href="/auth/start"');
    expect(res?.body).not.toContain('evil.example');
  });

  it('completes the whole flow: start → callback sets an HttpOnly session cookie and redirects to next', async () => {
    seedMember({ issuer: ISSUER, subject: 'idp-subject-1' });
    const idp = makeIdp();
    const deps: OidcLoginDeps = {
      env: baseEnv(),
      fetchJson: idp.fetchJson,
      memberRegistry: { rootDir: memberRoot },
    };
    const start = await handleSurfaceAuthRoute(
      req({ pathname: '/auth/start', searchParams: new URLSearchParams({ next: '/settings' }) }),
      deps
    );
    expect(start?.status).toBe(302);
    const authorize = new URL(start!.headers.Location!);
    idp.state.nonceFor.set('code-9', authorize.searchParams.get('nonce') ?? '');
    const txCookie = start!.setCookies[0]!;
    expect(txCookie).toContain('HttpOnly');
    expect(txCookie).toContain('Secure');
    const cookieHeader = txCookie.split(';')[0]!;
    const callback = await handleSurfaceAuthRoute(
      req({
        pathname: '/auth/callback',
        searchParams: new URLSearchParams({
          code: 'code-9',
          state: authorize.searchParams.get('state') ?? '',
        }),
        cookieHeader,
      }),
      deps
    );
    expect(callback?.status).toBe(302);
    expect(callback?.headers.Location).toBe('/settings');
    const session = callback!.setCookies.find((c) => c.startsWith(`${SURFACE_SESSION_COOKIE}=`))!;
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Secure');
    const token = extractSurfaceSessionToken(session.split(';')[0]);
    expect(verifyBrowserSessionToken(token, { env: baseEnv() })?.sub).toBe('idp-subject-1');
    // The transaction cookie is cleared.
    expect(
      callback!.setCookies.some((c) => c.includes('Max-Age=0') && c.startsWith('kyberion_oidc_tx_'))
    ).toBe(true);
  });

  it('logout clears the session cookie', async () => {
    const res = await handleSurfaceAuthRoute(req({ pathname: '/logout' }), { env: baseEnv() });
    expect(res?.status).toBe(302);
    expect(res?.headers.Location).toBe('/login?signedout=1');
    expect(parseCookieHeader(res!.setCookies[0])[SURFACE_SESSION_COOKIE]).toBe('');
    expect(res!.setCookies[0]).toContain('Max-Age=0');
  });
});

describe('browser-session authn provider', () => {
  const env = baseEnv();

  function mint(subject: string, ttlSeconds = 600, now?: number) {
    return mintBrowserSessionToken(
      { idpIssuer: ISSUER, subject, ttlSeconds },
      { env, ...(now ? { now } : {}) }
    ).token;
  }
  const resolveSession = (token: string, extra: Record<string, unknown> = {}) =>
    resolveAuthnPrincipal(
      { credential: { type: 'bearer', token } },
      {
        providerIds: ['browser-session'],
        deps: { env, memberRegistry: { rootDir: memberRoot }, ...extra },
      }
    );

  it('resolves a bound member and re-reads the registry on every request', () => {
    seedMember({ issuer: ISSUER, subject: 's1' });
    const resolution = resolveSession(mint('s1'));
    expect(resolution.principal).toMatchObject({
      memberId: 'carol',
      provider: 'browser-session',
      source: 'oidc',
      role: 'readonly',
      tenantSlugs: ['acme-corp'],
    });
    // Suspension takes effect on the next request even though the cookie is unchanged.
    const token = mint('s1');
    seedMember({ issuer: ISSUER, subject: 's1' }, 'suspended');
    expect(() => resolveSession(token)).toThrow(/suspended/);
  });

  it('rejects an unbound subject instead of degrading to the ext- path', () => {
    seedMember(null);
    expect(() => resolveSession(mint('nobody'))).toThrow(/not a bound member/);
  });

  it('rejects a tampered signature and an expired session', () => {
    seedMember({ issuer: ISSUER, subject: 's1' });
    const token = mint('s1');
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(() => resolveSession(tampered)).toThrow(/invalid or expired/);
    const expired = mint('s1', 60, Date.now() - 3_600_000);
    expect(() => resolveSession(expired)).toThrow(/invalid or expired/);
  });

  it('rejects a token signed with a different secret', () => {
    seedMember({ issuer: ISSUER, subject: 's1' });
    const foreign = mintBrowserSessionToken(
      { idpIssuer: ISSUER, subject: 's1', ttlSeconds: 600 },
      { env: { ...env, KYBERION_SESSION_SECRET: 'another-secret' } }
    ).token;
    expect(() => resolveSession(foreign)).toThrow(/invalid or expired/);
  });

  it('is not eligible without a signing key (falls through instead of judging)', () => {
    expect(() =>
      resolveAuthnPrincipal(
        { credential: { type: 'bearer', token: 'kys1.a.b' } },
        { providerIds: ['browser-session'], deps: { env: {} } }
      )
    ).toThrow();
  });
});

describe('Google / Microsoft Entra specifics', () => {
  it("accepts Google's scheme-less iss spelling but binds against the configured issuer", async () => {
    seedMember({ issuer: 'https://accounts.google.com', subject: 'g-1' });
    resetOidcLoginCachesForTests();
    const google = 'https://accounts.google.com';
    const fetchJson: NonNullable<OidcLoginDeps['fetchJson']> = async (request) => {
      if (request.url === `${google}/.well-known/openid-configuration`) {
        return {
          issuer: google,
          authorization_endpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
          token_endpoint: 'https://oauth2.googleapis.com/token',
          jwks_uri: 'https://www.googleapis.com/oauth2/v3/certs',
          token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        };
      }
      if (request.url === 'https://www.googleapis.com/oauth2/v3/certs') return { keys: [jwk] };
      if (request.url === 'https://oauth2.googleapis.com/token') {
        return {
          id_token: idToken({
            iss: 'accounts.google.com',
            aud: CLIENT_ID,
            sub: 'g-1',
            nonce: nonceBox.value,
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
        };
      }
      throw new Error(`unexpected ${request.url}`);
    };
    const nonceBox = { value: '' };
    const deps: OidcLoginDeps = {
      env: baseEnv({ KYBERION_OIDC_ISSUER: google }),
      fetchJson,
      memberRegistry: { rootDir: memberRoot },
    };
    const started = await startOidcLogin(
      { surfaceId: 'concierge', requestOrigin: 'https://desk.example.com', loopback: false },
      deps
    );
    if (started.ok === false) throw new Error('start failed');
    const url = new URL(started.location);
    nonceBox.value = url.searchParams.get('nonce') ?? '';
    const result = await completeOidcLogin(
      {
        surfaceId: 'concierge',
        query: { code: 'c', state: url.searchParams.get('state') },
        transactionCookie: started.transactionCookie.value,
      },
      deps
    );
    expect(result).toMatchObject({ ok: true, memberId: 'carol' });
  });

  it('explains that Entra /common cannot be used (templated issuer in discovery)', async () => {
    resetOidcLoginCachesForTests();
    const common = 'https://login.microsoftonline.com/common/v2.0';
    const fetchJson: NonNullable<OidcLoginDeps['fetchJson']> = async () => ({
      issuer: 'https://login.microsoftonline.com/{tenantid}/v2.0',
      authorization_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      token_endpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
    });
    const audited: string[] = [];
    const started = await startOidcLogin(
      { surfaceId: 'concierge', requestOrigin: 'https://desk.example.com', loopback: false },
      {
        env: baseEnv({ KYBERION_OIDC_ISSUER: common }),
        fetchJson,
        audit: (event) => audited.push(event.reason ?? ''),
      }
    );
    expect(started).toMatchObject({ ok: false, view: { kind: 'failed', code: 'idp_error' } });
    expect(audited.join(' ')).toContain('tenant-specific issuer');
  });
});
