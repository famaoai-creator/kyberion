#!/usr/bin/env node
/**
 * dev_oidc_idp — a throw-away OpenID Connect provider for LOCAL surface login.
 *
 * The surfaces' remote login (`/login`) needs a real IdP (Google / Entra). For
 * a local check that is a lot of console clicking, so this script runs a tiny
 * IdP on 127.0.0.1 that signs in ANY visitor as one fixed subject. It speaks
 * just enough OIDC for `libs/core/surface/oidc-browser-login.ts`:
 * discovery, authorize (code + PKCE S256), token, JWKS, RS256 id_token.
 *
 * Safety: it authenticates nobody, so it is hard-wired to loopback — it binds
 * 127.0.0.1 only, only redirects to loopback `/auth/callback` URLs, and
 * refuses to start under NODE_ENV=production. The surfaces still require the
 * subject to be bound to an active member, so signing in grants nothing until
 * `pnpm organization member link-identity` has been run for it.
 */
import {
  createHash,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getRegisteredEnvText } from '@agent/core/foundation/env';
import {
  currentProcessArgv,
  defineScript,
  isDirectScript,
  ScriptExitError,
} from './lib/harness.js';

const DEFAULT_PORT = 9099;
const DEFAULT_CLIENT_ID = 'kyberion-dev';
const DEFAULT_SUBJECT = 'dev-user';
const CODE_TTL_MS = 5 * 60 * 1000;
const ID_TOKEN_TTL_SECONDS = 10 * 60;

export interface DevOidcIdpOptions {
  port: number;
  clientId: string;
  subject: string;
  email?: string;
}

export interface DevOidcIdp {
  issuer: string;
  server: Server;
  close(): Promise<void>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string;
  exp: number;
}

function b64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function isLoopbackCallback(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
      url.pathname === '/auth/callback'
    );
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 16 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function startDevOidcIdp(options: DevOidcIdpOptions): Promise<DevOidcIdp> {
  if (getRegisteredEnvText('NODE_ENV') === 'production') {
    throw new Error('dev OIDC IdP signs in anyone; it refuses to run with NODE_ENV=production');
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = b64url(randomBytes(6));
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' };
  const signer = createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const codes = new Map<string, PendingCode>();
  // The issuer must equal KYBERION_OIDC_ISSUER byte for byte; `localhost` keeps
  // it identical to what the operator exports and what Google-style IdP
  // consoles accept for redirect URIs.
  const issuer = `http://localhost:${options.port}`;

  const signIdToken = (claims: Record<string, unknown>): string => {
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
    const body = b64url(JSON.stringify(claims));
    const signature = createSign('RSA-SHA256').update(`${head}.${body}`).sign(signer);
    return `${head}.${body}.${b64url(signature)}`;
  };

  const validateAuthorize = (params: URLSearchParams): string | null => {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    if (clientId !== options.clientId) return `unknown client_id '${clientId}'`;
    if (!isLoopbackCallback(redirectUri)) {
      return 'redirect_uri must be http://localhost:<port>/auth/callback';
    }
    if (params.get('response_type') !== 'code') return 'response_type must be code';
    if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) {
      return 'PKCE S256 is required';
    }
    return null;
  };

  const mintRedirect = (params: URLSearchParams): string => {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const code = randomBytes(18).toString('base64url');
    codes.set(code, {
      clientId,
      redirectUri,
      challenge: params.get('code_challenge')!,
      nonce: params.get('nonce') ?? '',
      exp: Date.now() + CODE_TTL_MS,
    });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    const state = params.get('state');
    if (state) target.searchParams.set('state', state);
    return target.toString();
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', issuer);
      if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        return sendJson(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        });
      }
      if (req.method === 'GET' && url.pathname === '/jwks') {
        return sendJson(res, 200, { keys: [jwk] });
      }
      if (req.method === 'GET' && url.pathname === '/authorize') {
        const error = validateAuthorize(url.searchParams);
        if (error) return sendHtml(res, 400, `<p>${escapeHtml(error)}</p>`);
        // Confirm page instead of an instant redirect so a stray visit can't
        // mint a code silently; one click signs in as the fixed dev subject.
        const hidden = [...url.searchParams.entries()]
          .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
          .join('');
        return sendHtml(
          res,
          200,
          `<!doctype html><meta charset="utf-8"><title>Dev IdP</title>
<body style="font-family:system-ui;max-width:28rem;margin:4rem auto">
<h1>Kyberion dev IdP</h1>
<p>Local testing only. Sign in as <code>${escapeHtml(options.subject)}</code>?</p>
<form method="post" action="/authorize">${hidden}<button type="submit">Sign in</button></form>`
        );
      }
      if (req.method === 'POST' && url.pathname === '/authorize') {
        const form = await readForm(req);
        const error = validateAuthorize(form);
        if (error) return sendHtml(res, 400, `<p>${escapeHtml(error)}</p>`);
        res.writeHead(302, { Location: mintRedirect(form), 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method === 'POST' && url.pathname === '/token') {
        const form = await readForm(req);
        const pending = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? ''); // single use
        const bad = (error: string) =>
          sendJson(res, 400, { error: 'invalid_grant', error_description: error });
        if (!pending || pending.exp < Date.now()) return bad('unknown or expired code');
        if (form.get('grant_type') !== 'authorization_code') return bad('grant_type');
        if (form.get('redirect_uri') !== pending.redirectUri) return bad('redirect_uri mismatch');
        if ((form.get('client_id') ?? pending.clientId) !== pending.clientId)
          return bad('client_id');
        const verifier = form.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== pending.challenge) {
          return bad('PKCE verification failed');
        }
        const now = Math.floor(Date.now() / 1000);
        const idToken = signIdToken({
          iss: issuer,
          sub: options.subject,
          aud: pending.clientId,
          iat: now,
          exp: now + ID_TOKEN_TTL_SECONDS,
          ...(pending.nonce ? { nonce: pending.nonce } : {}),
          ...(options.email ? { email: options.email } : {}),
        });
        return sendJson(res, 200, {
          token_type: 'Bearer',
          access_token: b64url(randomBytes(16)),
          expires_in: ID_TOKEN_TTL_SECONDS,
          id_token: idToken,
        });
      }
      return sendJson(res, 404, { error: 'not_found' });
    })().catch((error: unknown) => {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 127.0.0.1 only: this server authenticates anyone who can reach it.
    server.listen(options.port, '127.0.0.1', resolve);
  });
  return {
    issuer,
    server,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export function devOidcEnvExports(options: DevOidcIdpOptions, sessionSecret: string): string[] {
  return [
    `export KYBERION_OIDC_ISSUER=http://localhost:${options.port}`,
    `export KYBERION_OIDC_CLIENT_ID=${options.clientId}`,
    `export KYBERION_OIDC_PROVIDER_LABEL='Dev IdP'`,
    `export KYBERION_SESSION_SECRET=${sessionSecret}`,
  ];
}

if (
  isDirectScript(import.meta.url, 'dev_oidc_idp.ts') ||
  isDirectScript(import.meta.url, 'dev_oidc_idp.js')
)
  void defineScript({
    name: 'dev:oidc-idp',
    flags: [],
    async run(context) {
      const argv = await createStandardYargs(currentProcessArgv())
        .option('port', { type: 'number', default: DEFAULT_PORT })
        .option('client-id', { type: 'string', default: DEFAULT_CLIENT_ID })
        .option('subject', { type: 'string', default: DEFAULT_SUBJECT })
        .option('email', { type: 'string' })
        .parseAsync(context.argv);
      const options: DevOidcIdpOptions = {
        port: Number(argv.port),
        clientId: String(argv['client-id']),
        subject: String(argv.subject),
        ...(argv.email ? { email: String(argv.email) } : {}),
      };
      if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
        throw new ScriptExitError(2, '--port must be 1-65535');
      }
      const sessionSecret =
        getRegisteredEnvText('KYBERION_SESSION_SECRET')?.trim() || randomBytes(32).toString('hex');
      const idp = await startDevOidcIdp(options);
      context.print(`[dev:oidc-idp] listening on ${idp.issuer} (loopback only; signs in anyone)`);
      context.print('');
      context.print('# 1. In the shell that starts the surfaces:');
      for (const line of devOidcEnvExports(options, sessionSecret)) context.print(line);
      context.print('');
      context.print('# 2. Bind this identity to your member (once), then sign in at /login:');
      context.print(
        `pnpm organization member link-identity <member-id> --issuer ${idp.issuer} --subject ${options.subject}`
      );
      context.print('');
      context.print(
        '# Redirect URI is derived automatically for http://localhost:<surface-port>/auth/callback.'
      );
    },
  })();
