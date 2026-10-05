import { createHash, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  completeOidcLogin,
  resetOidcLoginCachesForTests,
  startOidcLogin,
} from '@agent/core/surface/oidc-browser-login';
import { startDevOidcIdp, type DevOidcIdp } from './dev_oidc_idp.js';

let idp: DevOidcIdp | undefined;

afterEach(async () => {
  await idp?.close();
  idp = undefined;
  resetOidcLoginCachesForTests();
});

// One port per test: undici pools keep-alive sockets per origin, and reusing a
// port would hand a later test a socket the previous server already closed.
let nextPort = 39099;
const takePort = (): number => nextPort++;
const SESSION_SECRET = 'a'.repeat(40);

function envFor(port: number) {
  return {
    KYBERION_OIDC_ISSUER: `http://localhost:${port}`,
    KYBERION_OIDC_CLIENT_ID: 'kyberion-dev',
    KYBERION_SESSION_SECRET: SESSION_SECRET,
  };
}

describe('dev OIDC IdP', () => {
  it('serves discovery and JWKS for the configured issuer', async () => {
    let port = 0;
    idp = await startDevOidcIdp({
      port: (port = takePort()),
      clientId: 'kyberion-dev',
      subject: 'dev-user',
    });
    const discovery = await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json();
    expect(discovery.issuer).toBe(`http://localhost:${port}`);
    const jwks = await (await fetch(discovery.jwks_uri)).json();
    expect(jwks.keys[0]).toMatchObject({ kty: 'RSA', alg: 'RS256' });
  });

  it('rejects non-loopback redirect URIs and unknown clients', async () => {
    let port = 0;
    idp = await startDevOidcIdp({
      port: (port = takePort()),
      clientId: 'kyberion-dev',
      subject: 'dev-user',
    });
    const base = {
      response_type: 'code',
      code_challenge: 'x',
      code_challenge_method: 'S256',
    };
    const evil = new URLSearchParams({
      ...base,
      client_id: 'kyberion-dev',
      redirect_uri: 'https://evil.example/auth/callback',
    });
    expect((await fetch(`${idp.issuer}/authorize?${evil}`)).status).toBe(400);
    const other = new URLSearchParams({
      ...base,
      client_id: 'someone-else',
      redirect_uri: 'http://localhost:3050/auth/callback',
    });
    expect((await fetch(`${idp.issuer}/authorize?${other}`)).status).toBe(400);
  });

  it('refuses the token exchange when the PKCE verifier is wrong', async () => {
    let port = 0;
    idp = await startDevOidcIdp({
      port: (port = takePort()),
      clientId: 'kyberion-dev',
      subject: 'dev-user',
    });
    const verifier = randomBytes(32).toString('base64url');
    const form = new URLSearchParams({
      client_id: 'kyberion-dev',
      redirect_uri: 'http://localhost:3050/auth/callback',
      response_type: 'code',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const approve = await fetch(`${idp.issuer}/authorize`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    const code = new URL(approve.headers.get('location')!).searchParams.get('code')!;
    const token = await fetch(`${idp.issuer}/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'http://localhost:3050/auth/callback',
        client_id: 'kyberion-dev',
        code_verifier: 'wrong',
      }),
    });
    expect(token.status).toBe(400);
  });

  it('completes the surface login flow up to the member-binding check', async () => {
    let port = 0;
    idp = await startDevOidcIdp({
      port: (port = takePort()),
      clientId: 'kyberion-dev',
      subject: 'dev-user',
    });
    const env = envFor(port);
    const start = await startOidcLogin(
      { surfaceId: 'concierge', requestOrigin: 'http://localhost:3050', loopback: false },
      { env }
    );
    if (!start.ok) throw new Error('start failed');
    const approve = await fetch(start.location, {
      redirect: 'manual',
    });
    expect(approve.status).toBe(200); // confirm page
    const params = new URL(start.location).searchParams;
    const post = await fetch(`${idp.issuer}/authorize`, {
      method: 'POST',
      body: new URLSearchParams(params),
      redirect: 'manual',
    });
    const callback = new URL(post.headers.get('location')!);
    const result = await completeOidcLogin(
      {
        surfaceId: 'concierge',
        query: {
          code: callback.searchParams.get('code'),
          state: callback.searchParams.get('state'),
        },
        transactionCookie: start.transactionCookie.value,
      },
      { env }
    );
    // The id_token verified (otherwise this would be `token_invalid`); the
    // account is simply not bound to a member yet, which is the fail-closed
    // outcome the operator fixes with `link-identity`.
    expect(result.ok).toBe(false);
    expect((result as { view?: unknown }).view).toMatchObject({
      kind: 'unbound',
      subject: 'dev-user',
    });
  });
});
