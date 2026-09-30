/**
 * oidc-browser-login — generic OIDC Authorization Code + PKCE login for the
 * browser surfaces.
 *
 * Flow (standards only, no IdP-specific code paths — Google and Microsoft
 * Entra both work through discovery):
 *
 *   start    → discovery, then a redirect to the IdP with state + nonce +
 *              PKCE (S256). Those three secrets live only in a short-lived,
 *              HMAC-signed, HttpOnly, per-surface transaction cookie.
 *   callback → verify the transaction cookie and `state`, exchange the code
 *              (client secret when configured, always the PKCE verifier),
 *              verify the id_token (signature via the IdP's JWKS, issuer,
 *              audience = client id, azp, exp/nbf, nonce), then require that
 *              the verified `iss`+`sub` is bound to an ACTIVE Kyberion member
 *              (member-registry `external_identities`).
 *   session  → only then mint the stateless `kys1.` cookie. Authorization is
 *              never in the cookie: every request re-derives the principal
 *              from the member registry (authn `browser-session` provider),
 *              so suspension / membership changes apply immediately.
 *
 * An IdP account that is not a bound member never receives a session: with a
 * public IdP such as Google, "authenticated" would otherwise mean "anyone".
 *
 * Network access goes through `secureFetch` (egress policy + audit) unless a
 * caller injects `deps.fetchJson`. The id_token is never stored.
 */

import { createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

import {
  AuthnError,
  resolveAuthnPrincipal,
  type AuthnResolveDeps,
} from '../authn-principal-resolver.js';
import {
  browserSessionKey,
  mintBrowserSessionToken,
  verifyJwtSignature,
  type OidcConfig,
} from '../authn-providers.js';
import { getRegisteredEnvText, isVitestProcess } from '../foundation/env.js';
import { auditChain } from '../governance/audit-chain.js';
import type { MemberRegistryPathOptions } from '../organization/member-registry.js';
import {
  SURFACE_LOGIN_TX_COOKIE_PREFIX,
  sanitizeNextPath,
  trimTrailingSlashes,
} from './surface-session-cookie.js';
import type { SurfaceLoginFailureCode, SurfaceLoginView } from './surface-login-pages.js';

export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const TX_TTL_SECONDS = 10 * 60;
const TX_PREFIX = 'kyt1.';
const DISCOVERY_CACHE_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface OidcLoginConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  scopes: string;
  providerLabel: string;
  sessionTtlSeconds: number;
  /** Default public origin plus per-surface overrides (surface id → origin). */
  publicBaseUrl?: string;
  publicBaseUrlBySurface: Record<string, string>;
}

export interface OidcLoginFetchRequest {
  url: string;
  method: 'GET' | 'POST';
  /** application/x-www-form-urlencoded body fields (token endpoint). */
  form?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface OidcLoginAuditEvent {
  operation: string;
  result: 'completed' | 'error';
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface OidcLoginDeps {
  env?: Record<string, string | undefined>;
  now?: number;
  memberRegistry?: MemberRegistryPathOptions;
  /** Returns the parsed JSON body; throws on a non-2xx or transport failure. */
  fetchJson?: (request: OidcLoginFetchRequest) => Promise<unknown>;
  audit?: (event: OidcLoginAuditEvent) => void;
}

function authnDeps(deps: OidcLoginDeps): AuthnResolveDeps {
  return {
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.memberRegistry ? { memberRegistry: deps.memberRegistry } : {}),
  };
}

function envText(deps: OidcLoginDeps, name: string): string | undefined {
  return getRegisteredEnvText(name, deps.env ? { env: deps.env } : undefined)?.trim() || undefined;
}

function normalizeIssuer(issuer: string): string {
  return trimTrailingSlashes(issuer.trim());
}

/**
 * Google documents two `iss` spellings for the same issuer
 * (`https://accounts.google.com` and the bare `accounts.google.com`); every
 * other IdP must match the configured issuer exactly.
 */
function issuerMatches(configured: string, claimed: string): boolean {
  if (claimed === configured) return true;
  return configured === 'https://accounts.google.com' && claimed === 'accounts.google.com';
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === 'localhost'
  );
}

function parseBaseUrls(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of (raw ?? '').split(',')) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const surface = entry.slice(0, index).trim();
    const url = entry.slice(index + 1).trim();
    if (surface && url) out[surface] = url;
  }
  return out;
}

export interface OidcLoginConfigResolution {
  config: OidcLoginConfig | null;
  /** Names an operator still has to provide; empty when `config` is set. */
  missing: string[];
}

export function resolveOidcLoginConfig(deps: OidcLoginDeps = {}): OidcLoginConfigResolution {
  const issuer = envText(deps, 'KYBERION_OIDC_ISSUER');
  const clientId = envText(deps, 'KYBERION_OIDC_CLIENT_ID');
  const missing: string[] = [];
  if (!issuer) missing.push('KYBERION_OIDC_ISSUER');
  if (!clientId) missing.push('KYBERION_OIDC_CLIENT_ID');
  if (!browserSessionKey(authnDeps(deps))) missing.push('KYBERION_SESSION_SECRET (>= 32 bytes)');
  if (!issuer || !clientId || missing.length) return { config: null, missing };
  const ttl = Number(envText(deps, 'KYBERION_SESSION_TTL_SECONDS'));
  return {
    missing,
    config: {
      issuer: normalizeIssuer(issuer),
      clientId,
      clientSecret: envText(deps, 'KYBERION_OIDC_CLIENT_SECRET'),
      scopes: envText(deps, 'KYBERION_OIDC_SCOPES') ?? 'openid',
      providerLabel: envText(deps, 'KYBERION_OIDC_PROVIDER_LABEL') ?? 'SSO',
      sessionTtlSeconds:
        Number.isFinite(ttl) && ttl >= 60 ? Math.floor(ttl) : DEFAULT_SESSION_TTL_SECONDS,
      publicBaseUrl: envText(deps, 'KYBERION_OIDC_PUBLIC_BASE_URL'),
      publicBaseUrlBySurface: parseBaseUrls(envText(deps, 'KYBERION_OIDC_PUBLIC_BASE_URLS')),
    },
  };
}

/**
 * True when the request origin's HOST is itself a loopback name
 * (`localhost` / `127.0.0.1` / `[::1]`). Next.js 15+ cannot prove a
 * same-machine peer, so `loopback` alone misses a local browser; a
 * loopback-named origin is safe to reuse as the redirect target because the
 * IdP sends the browser back to the user's OWN machine — an attacker cannot
 * turn it into a redirect to a foreign host.
 */
function isLoopbackNamedOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * The origin the IdP redirects back to. A remote surface must declare its
 * public origin: the Host header is caller-controlled and would otherwise
 * pick the redirect URI. Local use (a proven loopback peer, or a
 * loopback-named origin) falls back to the request origin so signing in from
 * the same machine needs no extra variable.
 */
export function resolveOidcRedirectOrigin(
  config: OidcLoginConfig,
  input: { surfaceId: string; requestOrigin: string; loopback: boolean }
): string | null {
  const declared = config.publicBaseUrlBySurface[input.surfaceId] ?? config.publicBaseUrl;
  const local = input.loopback || isLoopbackNamedOrigin(input.requestOrigin);
  const raw = declared ?? (local ? input.requestOrigin : undefined);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discovery + JWKS (cached)
// ---------------------------------------------------------------------------

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

interface JwksDocument {
  keys: Record<string, unknown>[];
}

const discoveryCache = new Map<string, { at: number; doc: OidcDiscovery }>();
const jwksCache = new Map<string, { at: number; jwks: JwksDocument }>();

export function resetOidcLoginCachesForTests(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

function assertEndpointUrl(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`discovery: ${label} missing`);
  const url = new URL(value);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackHost(url.hostname))) {
    throw new Error(`discovery: ${label} must be https`);
  }
  return url.toString();
}

async function defaultFetchJson(request: OidcLoginFetchRequest): Promise<unknown> {
  const { secureFetch } = await import('../network.js');
  const host = new URL(request.url).hostname;
  return secureFetch<unknown>({
    url: request.url,
    method: request.method,
    headers: {
      Accept: 'application/json',
      ...(request.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(request.headers ?? {}),
    },
    ...(request.form ? { data: new URLSearchParams(request.form).toString() } : {}),
    // The token request body carries the code, verifier and client secret —
    // secureFetch would otherwise redact them.
    authenticateRequest: true,
    kyberion_allow_local_network: isLoopbackHost(host),
    timeout: 10_000,
  });
}

function fetchJson(deps: OidcLoginDeps, request: OidcLoginFetchRequest): Promise<unknown> {
  return (deps.fetchJson ?? defaultFetchJson)(request);
}

async function loadDiscovery(config: OidcLoginConfig, deps: OidcLoginDeps): Promise<OidcDiscovery> {
  const now = deps.now ?? Date.now();
  const cached = discoveryCache.get(config.issuer);
  if (cached && now - cached.at < DISCOVERY_CACHE_MS) return cached.doc;
  const raw = (await fetchJson(deps, {
    url: `${config.issuer}/.well-known/openid-configuration`,
    method: 'GET',
  })) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error('discovery: empty document');
  if (typeof raw.issuer !== 'string' || normalizeIssuer(raw.issuer) !== config.issuer) {
    throw new Error(
      'discovery: issuer does not match KYBERION_OIDC_ISSUER (Microsoft Entra needs a tenant-specific issuer such as https://login.microsoftonline.com/<tenant-id>/v2.0, not /common)'
    );
  }
  const doc: OidcDiscovery = {
    issuer: config.issuer,
    authorization_endpoint: assertEndpointUrl(raw.authorization_endpoint, 'authorization_endpoint'),
    token_endpoint: assertEndpointUrl(raw.token_endpoint, 'token_endpoint'),
    jwks_uri: assertEndpointUrl(raw.jwks_uri, 'jwks_uri'),
    ...(Array.isArray(raw.token_endpoint_auth_methods_supported)
      ? {
          token_endpoint_auth_methods_supported: raw.token_endpoint_auth_methods_supported.filter(
            (m): m is string => typeof m === 'string'
          ),
        }
      : {}),
  };
  discoveryCache.set(config.issuer, { at: now, doc });
  return doc;
}

async function loadJwks(
  discovery: OidcDiscovery,
  deps: OidcLoginDeps,
  force: boolean
): Promise<JwksDocument> {
  const now = deps.now ?? Date.now();
  const cached = jwksCache.get(discovery.jwks_uri);
  if (!force && cached && now - cached.at < DISCOVERY_CACHE_MS) return cached.jwks;
  const raw = (await fetchJson(deps, { url: discovery.jwks_uri, method: 'GET' })) as {
    keys?: unknown;
  } | null;
  if (!raw || !Array.isArray(raw.keys) || !raw.keys.length) throw new Error('jwks: no keys');
  const jwks: JwksDocument = { keys: raw.keys as Record<string, unknown>[] };
  jwksCache.set(discovery.jwks_uri, { at: now, jwks });
  return jwks;
}

// ---------------------------------------------------------------------------
// Transaction cookie (state / nonce / PKCE verifier)
// ---------------------------------------------------------------------------

interface LoginTransaction {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  redirectUri: string;
  surface: string;
  exp: number;
}

export function loginTransactionCookieName(surfaceId: string): string {
  return `${SURFACE_LOGIN_TX_COOKIE_PREFIX}${surfaceId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function signTransaction(payloadB64: string, key: Buffer): string {
  return createHmac('sha256', key).update(`${TX_PREFIX}${payloadB64}`).digest('base64url');
}

function sealTransaction(tx: LoginTransaction, key: Buffer): string {
  const payloadB64 = Buffer.from(JSON.stringify(tx)).toString('base64url');
  return `${TX_PREFIX}${payloadB64}.${signTransaction(payloadB64, key)}`;
}

function openTransaction(value: string, key: Buffer, nowMs: number): LoginTransaction | null {
  if (!value.startsWith(TX_PREFIX)) return null;
  const body = value.slice(TX_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return null;
  const payloadB64 = body.slice(0, dot);
  const signature = body.slice(dot + 1);
  const expected = signTransaction(payloadB64, key);
  if (signature.length !== expected.length || !safeEqual(signature, expected)) return null;
  try {
    const tx = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    ) as LoginTransaction;
    if (typeof tx.exp !== 'number' || tx.exp * 1000 <= nowMs) return null;
    if (!tx.state || !tx.nonce || !tx.verifier || !tx.redirectUri) return null;
    return tx;
  } catch {
    return null;
  }
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export type StartOidcLoginResult =
  | {
      ok: true;
      location: string;
      transactionCookie: { name: string; value: string; maxAgeSeconds: number };
    }
  | { ok: false; view: SurfaceLoginView };

export async function startOidcLogin(
  input: {
    surfaceId: string;
    requestOrigin: string;
    loopback: boolean;
    next?: string | null;
  },
  deps: OidcLoginDeps = {}
): Promise<StartOidcLoginResult> {
  const { config, missing } = resolveOidcLoginConfig(deps);
  if (!config) return { ok: false, view: { kind: 'unconfigured', missing } };
  const origin = resolveOidcRedirectOrigin(config, input);
  if (!origin) {
    return {
      ok: false,
      view: { kind: 'unconfigured', missing: ['KYBERION_OIDC_PUBLIC_BASE_URL'] },
    };
  }
  const key = browserSessionKey(authnDeps(deps));
  if (!key) return { ok: false, view: { kind: 'failed', code: 'session_unavailable' } };
  let discovery: OidcDiscovery;
  try {
    discovery = await loadDiscovery(config, deps);
  } catch (error) {
    record(deps, {
      operation: `${input.surfaceId}/start`,
      result: 'error',
      reason: `discovery failed: ${errorText(error)}`,
    });
    return { ok: false, view: { kind: 'failed', code: 'idp_error' } };
  }
  const nowSec = Math.floor((deps.now ?? Date.now()) / 1000);
  const state = randomBytes(18).toString('base64url');
  const nonce = randomBytes(18).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `${origin}/auth/callback`;
  const authorize = new URL(discovery.authorization_endpoint);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', config.clientId);
  authorize.searchParams.set('redirect_uri', redirectUri);
  authorize.searchParams.set(
    'scope',
    config.scopes.includes('openid') ? config.scopes : `openid ${config.scopes}`
  );
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('nonce', nonce);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  const tx: LoginTransaction = {
    state,
    nonce,
    verifier,
    next: sanitizeNextPath(input.next),
    redirectUri,
    surface: input.surfaceId,
    exp: nowSec + TX_TTL_SECONDS,
  };
  return {
    ok: true,
    location: authorize.toString(),
    transactionCookie: {
      name: loginTransactionCookieName(input.surfaceId),
      value: sealTransaction(tx, key),
      maxAgeSeconds: TX_TTL_SECONDS,
    },
  };
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

export type CompleteOidcLoginResult =
  | {
      ok: true;
      next: string;
      sessionToken: string;
      sessionTtlSeconds: number;
      memberId: string;
    }
  | { ok: false; status: number; view: SurfaceLoginView };

function decodeJwtPart<T>(part: string | undefined): T | null {
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
  } catch {
    return null;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(
  deps: OidcLoginDeps,
  surfaceId: string,
  code: SurfaceLoginFailureCode,
  reason: string,
  status = 400
): CompleteOidcLoginResult {
  record(deps, { operation: `${surfaceId}/callback`, result: 'error', reason });
  return { ok: false, status, view: { kind: 'failed', code } };
}

export async function completeOidcLogin(
  input: {
    surfaceId: string;
    query: { code?: string | null; state?: string | null; error?: string | null };
    transactionCookie?: string | null;
  },
  deps: OidcLoginDeps = {}
): Promise<CompleteOidcLoginResult> {
  const { surfaceId } = input;
  const { config, missing } = resolveOidcLoginConfig(deps);
  if (!config) return { ok: false, status: 503, view: { kind: 'unconfigured', missing } };
  const key = browserSessionKey(authnDeps(deps));
  if (!key) return fail(deps, surfaceId, 'session_unavailable', 'no session key', 503);

  if (input.query.error) {
    return fail(deps, surfaceId, 'idp_error', `idp error: ${input.query.error.slice(0, 80)}`);
  }
  const nowMs = deps.now ?? Date.now();
  const tx = input.transactionCookie ? openTransaction(input.transactionCookie, key, nowMs) : null;
  if (!tx) return fail(deps, surfaceId, 'expired', 'transaction cookie missing/invalid/expired');
  if (tx.surface !== surfaceId) {
    return fail(deps, surfaceId, 'state_mismatch', 'transaction surface mismatch');
  }
  if (!input.query.state || !safeEqual(input.query.state, tx.state)) {
    return fail(deps, surfaceId, 'state_mismatch', 'state mismatch');
  }
  if (!input.query.code) return fail(deps, surfaceId, 'idp_error', 'no authorization code');

  let discovery: OidcDiscovery;
  try {
    discovery = await loadDiscovery(config, deps);
  } catch (error) {
    return fail(deps, surfaceId, 'idp_error', `discovery failed: ${errorText(error)}`);
  }

  // Code exchange. client_secret_post is the widely-supported default; use
  // HTTP Basic only when the IdP advertises Basic and NOT post.
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.query.code,
    redirect_uri: tx.redirectUri,
    client_id: config.clientId,
    code_verifier: tx.verifier,
  };
  const headers: Record<string, string> = {};
  if (config.clientSecret) {
    const methods = discovery.token_endpoint_auth_methods_supported;
    if (
      methods &&
      !methods.includes('client_secret_post') &&
      methods.includes('client_secret_basic')
    ) {
      headers.Authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`
      ).toString('base64')}`;
      delete form.client_id;
    } else {
      form.client_secret = config.clientSecret;
    }
  }
  let tokenResponse: { id_token?: unknown } | null;
  try {
    tokenResponse = (await fetchJson(deps, {
      url: discovery.token_endpoint,
      method: 'POST',
      form,
      headers,
    })) as { id_token?: unknown } | null;
  } catch (error) {
    return fail(deps, surfaceId, 'exchange_failed', `token exchange failed: ${errorText(error)}`);
  }
  const idToken = typeof tokenResponse?.id_token === 'string' ? tokenResponse.id_token : '';
  const parts = idToken.split('.');
  if (parts.length !== 3) return fail(deps, surfaceId, 'token_invalid', 'no id_token');
  const header = decodeJwtPart<{ alg?: string; kid?: string }>(parts[0]);
  const claims = decodeJwtPart<Record<string, unknown>>(parts[1]);
  if (!header?.alg || !claims) return fail(deps, surfaceId, 'token_invalid', 'malformed id_token');
  // Asymmetric algorithms only: never let an HS256 id_token (or `none`) be
  // judged against a shared-secret key, whatever the env flags say.
  if (header.alg !== 'RS256' && header.alg !== 'ES256') {
    return fail(deps, surfaceId, 'token_invalid', `unsupported id_token alg '${header.alg}'`);
  }

  // Signature + exp/nbf + audience. On a signature failure retry once with a
  // freshly fetched JWKS (key rotation), then give up.
  const verifyWith = async (force: boolean): Promise<void> => {
    const jwks = await loadJwks(discovery, deps, force);
    const oidc: OidcConfig = {
      issuer: config.issuer,
      audience: config.clientId,
      jwks: jwks as OidcConfig['jwks'],
    };
    verifyJwtSignature(idToken, header, claims, oidc, authnDeps(deps));
  };
  try {
    try {
      await verifyWith(false);
    } catch (first) {
      if (!(first instanceof AuthnError) || !/signature/i.test(first.message)) throw first;
      await verifyWith(true);
    }
  } catch (error) {
    return fail(deps, surfaceId, 'token_invalid', `id_token rejected: ${errorText(error)}`);
  }
  const claimedIssuer = typeof claims.iss === 'string' ? normalizeIssuer(claims.iss) : '';
  if (!issuerMatches(config.issuer, claimedIssuer)) {
    return fail(deps, surfaceId, 'token_invalid', 'issuer mismatch');
  }
  // Bind and mint against the CONFIGURED issuer so the member binding does not
  // depend on which spelling the IdP used for this particular token.
  const iss = config.issuer;
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, tx.nonce)) {
    return fail(deps, surfaceId, 'token_invalid', 'nonce mismatch');
  }
  // OIDC Core: when `azp` is present it must be this client, regardless of how
  // many audiences the token lists; several audiences make it mandatory.
  const multiAudience = Array.isArray(claims.aud) && claims.aud.length > 1;
  if ((claims.azp !== undefined || multiAudience) && claims.azp !== config.clientId) {
    return fail(deps, surfaceId, 'token_invalid', 'azp mismatch');
  }
  const subject = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!subject) return fail(deps, surfaceId, 'token_invalid', 'no subject');

  // Mint, then prove the session resolves to a bound ACTIVE member. Going
  // through the resolver (not a private lookup) keeps this on exactly the
  // path every later request takes.
  const subjectDigest = createHash('sha256').update(`${iss}#${subject}`).digest('hex').slice(0, 12);
  let minted;
  try {
    minted = mintBrowserSessionToken(
      { idpIssuer: iss, subject, ttlSeconds: config.sessionTtlSeconds },
      authnDeps(deps)
    );
  } catch (error) {
    return fail(deps, surfaceId, 'session_unavailable', errorText(error), 503);
  }
  try {
    const resolution = resolveAuthnPrincipal(
      { credential: { type: 'bearer', token: minted.token } },
      {
        providerIds: ['browser-session'],
        purpose: 'remote_human',
        context: { surface: surfaceId },
        deps: authnDeps(deps),
      }
    );
    const memberId = resolution.principal.memberId;
    if (!memberId) throw new AuthnError(403, 'scope_denied', 'not a bound member');
    record(deps, {
      operation: `${surfaceId}/callback`,
      result: 'completed',
      metadata: { idp_issuer: iss, subject_digest: subjectDigest, member_id: memberId },
    });
    return {
      ok: true,
      next: tx.next,
      sessionToken: minted.token,
      sessionTtlSeconds: config.sessionTtlSeconds,
      memberId,
    };
  } catch (error) {
    const message = errorText(error);
    const suspended = /suspended/i.test(message);
    record(deps, {
      operation: `${surfaceId}/callback`,
      result: 'error',
      reason: suspended ? 'member suspended' : 'identity not bound to a member',
      metadata: { idp_issuer: iss, subject_digest: subjectDigest },
    });
    if (suspended) return { ok: false, status: 403, view: { kind: 'suspended' } };
    if (error instanceof AuthnError && error.status === 403) {
      return { ok: false, status: 403, view: { kind: 'unbound', issuer: iss, subject } };
    }
    return { ok: false, status: 500, view: { kind: 'failed', code: 'session_unavailable' } };
  }
}

function record(deps: OidcLoginDeps, event: OidcLoginAuditEvent): void {
  try {
    if (deps.audit) {
      deps.audit(event);
      return;
    }
    if (isVitestProcess(deps.env)) return;
    auditChain.record({
      agentId: 'surface-login',
      action: 'surface_login',
      operation: event.operation,
      result: event.result,
      reason: event.reason,
      metadata: event.metadata,
    });
  } catch {
    // Audit is best-effort here: a failed append must not break sign-in.
  }
}
