/**
 * surface-session-cookie — edge-safe helpers for the browser login session.
 *
 * Pure string logic with NO Node imports, so a Next.js middleware (edge
 * runtime) and Express adapters can share one definition of:
 *   - the cookie names and the `Set-Cookie` serialization,
 *   - which requests are browser page navigations (→ redirect to /login)
 *     versus API calls (→ keep the JSON 401),
 *   - open-redirect-safe `next` handling,
 *   - the same-origin check that guards cookie-authenticated mutations.
 *
 * Nothing here decides authorization. A cookie is only a credential carrier:
 * the signature, expiry and member binding are verified server-side by the
 * `browser-session` authn provider (authn-providers.ts). The optional
 * `peekSessionExpiry` exists purely so a middleware can bounce an expired
 * cookie to /login without waiting for the first API 401.
 */

export const SURFACE_SESSION_COOKIE = 'kyberion_session';
export const SURFACE_LOGIN_TX_COOKIE_PREFIX = 'kyberion_oidc_tx_';
export const SURFACE_SESSION_TOKEN_PREFIX = 'kys1.';

export const SURFACE_LOGIN_PATH = '/login';
export const SURFACE_AUTH_START_PATH = '/auth/start';
export const SURFACE_AUTH_CALLBACK_PATH = '/auth/callback';
export const SURFACE_LOGOUT_PATH = '/logout';

export const SURFACE_AUTH_PATHS: readonly string[] = [
  SURFACE_LOGIN_PATH,
  SURFACE_AUTH_START_PATH,
  SURFACE_AUTH_CALLBACK_PATH,
  SURFACE_LOGOUT_PATH,
];

export function isSurfaceAuthPath(pathname: string): boolean {
  return SURFACE_AUTH_PATHS.includes(pathname);
}

/** Static assets a login page may need; never gated behind a session. */
export function isSurfacePublicAssetPath(pathname: string): boolean {
  return (
    pathname === '/favicon.ico' ||
    pathname.startsWith('/_next/') ||
    pathname === '/kyberion-ui.css' ||
    pathname === '/api/healthz'
  );
}

/** Strip trailing `/` without a backtracking regex (linear in the input). */
export function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charAt(end - 1) === '/') end -= 1;
  return value.slice(0, end);
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in out) continue; // first occurrence wins
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

/** The kys1. session token carried by the Cookie header, or ''. */
export function extractSurfaceSessionToken(cookieHeader: string | null | undefined): string {
  const value = parseCookieHeader(cookieHeader)[SURFACE_SESSION_COOKIE] ?? '';
  return value.startsWith(SURFACE_SESSION_TOKEN_PREFIX) ? value : '';
}

export type SurfaceCredentialSource = 'header' | 'session-cookie' | 'none';

/**
 * The credential a request carries. An explicit `Authorization: Bearer` header
 * always wins over the session cookie so scripted callers stay deterministic;
 * `source` tells the adapter whether the credential was cookie-borne (and so
 * must pass {@link isSameOriginMutation} for unsafe methods).
 */
export function extractSurfaceCredential(input: {
  authorization?: string | null;
  cookie?: string | null;
}): { token: string; source: SurfaceCredentialSource } {
  // Linear scan, no regex: a backtracking pattern over a caller-controlled
  // header is a ReDoS vector (`Bearer\t\t\t…`).
  const authorization = (input.authorization ?? '').trim();
  const bearer =
    authorization.length > 6 &&
    authorization.slice(0, 6).toLowerCase() === 'bearer' &&
    /\s/.test(authorization.charAt(6))
      ? authorization.slice(7).trim()
      : '';
  if (bearer) return { token: bearer, source: 'header' };
  const session = extractSurfaceSessionToken(input.cookie);
  if (session) return { token: session, source: 'session-cookie' };
  return { token: '', source: 'none' };
}

export interface SerializeCookieOptions {
  maxAgeSeconds?: number;
  secure?: boolean;
  sameSite?: 'Lax' | 'Strict';
  path?: string;
}

export function serializeCookie(
  name: string,
  value: string,
  options: SerializeCookieOptions = {}
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? '/'}`, 'HttpOnly'];
  parts.push(`SameSite=${options.sameSite ?? 'Lax'}`);
  if (options.secure) parts.push('Secure');
  if (options.maxAgeSeconds !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  }
  return parts.join('; ');
}

export function serializeClearedCookie(name: string, secure = false): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, secure });
}

/**
 * Only same-site absolute paths survive: `//evil`, `/\evil`, `https://…`,
 * control characters and auth routes themselves (redirect loops) collapse to
 * `/`. The value is always treated as a path, never as a URL.
 */
export function sanitizeNextPath(value: string | null | undefined): string {
  if (!value) return '/';
  const candidate = value.trim();
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return '/';
  if (candidate.length > 1024) return '/';
  const pathname = candidate.split(/[?#]/)[0] ?? '/';
  if (isSurfaceAuthPath(pathname)) return '/';
  return candidate;
}

export function buildLoginRedirectPath(nextPathAndQuery: string): string {
  const next = sanitizeNextPath(nextPathAndQuery);
  return next === '/'
    ? SURFACE_LOGIN_PATH
    : `${SURFACE_LOGIN_PATH}?next=${encodeURIComponent(next)}`;
}

interface HeaderLookup {
  get(name: string): string | null | undefined;
}

function header(
  headers: HeaderLookup | Record<string, string | string[] | undefined>,
  name: string
) {
  if (typeof (headers as HeaderLookup).get === 'function') {
    return (headers as HeaderLookup).get(name) ?? undefined;
  }
  const raw = (headers as Record<string, string | string[] | undefined>)[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * A top-level browser page load. `Sec-Fetch-Mode: navigate` is sent by every
 * current browser and cannot be set by page script; `Accept: text/html` is the
 * fallback for older clients and curl-style probes. An explicit JSON Accept
 * keeps API semantics (401), and anything that is not GET/HEAD never counts.
 */
export function isHtmlNavigationRequest(input: {
  method: string;
  headers: HeaderLookup | Record<string, string | string[] | undefined>;
}): boolean {
  const method = input.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  const mode = header(input.headers, 'sec-fetch-mode');
  const dest = header(input.headers, 'sec-fetch-dest');
  if (mode) return mode === 'navigate' && (!dest || dest === 'document' || dest === 'iframe');
  const accept = header(input.headers, 'accept') ?? '';
  if (!accept.includes('text/html')) return false;
  return (
    !accept.includes('application/json') ||
    accept.indexOf('text/html') < accept.indexOf('application/json')
  );
}

/** Non-verifying expiry peek for UX-only redirects. Never an auth decision. */
export function peekSessionExpiry(
  token: string,
  nowMs: number = Date.now()
): 'valid' | 'expired' | 'malformed' {
  if (!token.startsWith(SURFACE_SESSION_TOKEN_PREFIX)) return 'malformed';
  const body = token.slice(SURFACE_SESSION_TOKEN_PREFIX.length);
  const dot = body.lastIndexOf('.');
  if (dot <= 0) return 'malformed';
  try {
    const base64 = body.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(
      atob(padded)
        .split('')
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join('')
    );
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    if (typeof exp !== 'number') return 'malformed';
    return exp * 1000 > nowMs ? 'valid' : 'expired';
  } catch {
    return 'malformed';
  }
}

export interface LoginRedirectInput {
  method: string;
  pathname: string;
  search?: string;
  headers: HeaderLookup | Record<string, string | string[] | undefined>;
  /** Adapter-proven loopback peer (never inferred from Host). */
  loopback: boolean;
  /** Any credential at all (Authorization header, legacy token cookie, session cookie). */
  hasCredential: boolean;
}

/**
 * Where an UNAUTHENTICATED browser page navigation should go, or null when the
 * request must pass through (API calls, assets, auth routes, loopback, or an
 * already-credentialed request). Loopback is exempt so the documented
 * `KYBERION_LOCALHOST_AUTOADMIN` developer path keeps working untouched.
 */
export function resolveLoginRedirect(input: LoginRedirectInput): string | null {
  if (input.loopback || input.hasCredential) return null;
  if (isSurfaceAuthPath(input.pathname) || isSurfacePublicAssetPath(input.pathname)) return null;
  if (input.pathname.startsWith('/api/') || input.pathname.startsWith('/a2ui')) return null;
  if (!isHtmlNavigationRequest({ method: input.method, headers: input.headers })) return null;
  return buildLoginRedirectPath(`${input.pathname}${input.search ?? ''}`);
}

/**
 * Same-origin gate for cookie-authenticated unsafe requests. A cookie rides
 * along on cross-site requests; `SameSite=Lax` already blocks most, and this
 * closes the rest (same-site subdomain, top-level POST quirks) by requiring
 * the `Origin` (or, failing that, `Referer`) host to equal the request host.
 * A header-authenticated request (`Authorization`) is not cookie-borne and
 * must not be passed through this check.
 */
export function isSameOriginMutation(input: {
  method: string;
  headers: HeaderLookup | Record<string, string | string[] | undefined>;
  /** Host the server considers itself to be (public base host or request Host). */
  expectedHost: string;
}): boolean {
  const method = input.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  const site = header(input.headers, 'sec-fetch-site');
  if (site === 'cross-site') return false;
  const source = header(input.headers, 'origin') || header(input.headers, 'referer');
  if (!source) return site === 'same-origin';
  try {
    return new URL(source).host.toLowerCase() === input.expectedHost.toLowerCase();
  } catch {
    return false;
  }
}
