/**
 * surface-auth-routes — framework-neutral `/login`, `/auth/start`,
 * `/auth/callback`, `/logout` handler shared by all five surfaces.
 *
 * Each surface adapts its own request object (Next route handler or Express)
 * to {@link SurfaceAuthRouteRequest} and writes back the returned
 * {@link SurfaceAuthRouteResponse}; no surface implements login logic. The
 * adapter owns transport proof: it supplies `loopback` (socket peer, never
 * the Host header) and `requestOrigin`.
 */

import {
  completeOidcLogin,
  loginTransactionCookieName,
  resolveOidcLoginConfig,
  resolveOidcRedirectOrigin,
  startOidcLogin,
  type OidcLoginDeps,
} from './oidc-browser-login.js';
import {
  SURFACE_LOGIN_PAGE_HEADERS,
  renderSurfaceLoginPage,
  resolveLoginLocale,
  type SurfaceLoginView,
} from './surface-login-pages.js';
import {
  SURFACE_AUTH_CALLBACK_PATH,
  SURFACE_AUTH_START_PATH,
  SURFACE_LOGIN_PATH,
  SURFACE_LOGOUT_PATH,
  SURFACE_SESSION_COOKIE,
  isSurfaceAuthPath,
  parseCookieHeader,
  sanitizeNextPath,
  serializeClearedCookie,
  serializeCookie,
} from './surface-session-cookie.js';

export interface SurfaceAuthRouteRequest {
  /** Stable surface id, e.g. `concierge`, `chronos-mirror-v2`. */
  surfaceId: string;
  /** Human label shown on the login screen. */
  surfaceLabel: string;
  method: string;
  pathname: string;
  searchParams: URLSearchParams;
  cookieHeader?: string | null;
  acceptLanguage?: string | null;
  /** `scheme://host[:port]` the client used. Only trusted on loopback. */
  requestOrigin: string;
  /** Adapter-proven loopback peer. */
  loopback: boolean;
  /**
   * Stable per-client bucket for rate limiting, supplied by the adapter ONLY
   * from a peer it can trust (never a caller-controlled header unless a trusted
   * proxy rewrites it). Omit on surfaces that already rate-limit at the HTTP
   * layer; the per-surface cap below still applies when it is present.
   */
  clientKey?: string;
  /** `Sec-Fetch-Site` of the request, when the client sent one. */
  secFetchSite?: string | null;
  /** Origin (or Referer origin) header, consulted only when `Sec-Fetch-Site` is absent. */
  referrerOrigin?: string | null;
  /** Where a surface that supports pasted access tokens (concierge `/signin`) offers that path. */
  tokenSignInHref?: string;
  /** First-run setup page, supplied by the adapter only while setup is still open. */
  firstRunSetupHref?: string;
}

export interface SurfaceAuthRouteResponse {
  status: number;
  /** Single-valued headers (Location, Content-Type, security headers, …). */
  headers: Record<string, string>;
  /** One entry per Set-Cookie header. */
  setCookies: string[];
  body: string;
}

/** `/login` with the caller's `next` and `lang` carried along. */
function loginHrefFor(req: SurfaceAuthRouteRequest): string {
  const params = new URLSearchParams();
  const next = sanitizeNextPath(req.searchParams.get('next'));
  if (next !== '/') params.set('next', next);
  const lang = req.searchParams.get('lang');
  if (lang === 'ja' || lang === 'en') params.set('lang', lang);
  const query = params.toString();
  return query ? `${SURFACE_LOGIN_PATH}?${query}` : SURFACE_LOGIN_PATH;
}

function html(
  req: SurfaceAuthRouteRequest,
  status: number,
  view: SurfaceLoginView,
  setCookies: string[] = [],
  extraHeaders: Record<string, string> = {}
): SurfaceAuthRouteResponse {
  const locale = resolveLoginLocale(req.searchParams.get('lang'), req.acceptLanguage);
  return {
    status,
    headers: { ...SURFACE_LOGIN_PAGE_HEADERS, ...extraHeaders },
    setCookies,
    body: renderSurfaceLoginPage({
      surfaceLabel: req.surfaceLabel,
      view,
      locale,
      loginHref: loginHrefFor(req),
    }),
  };
}

// ---------------------------------------------------------------------------
// Rate limit (framework-neutral, in-memory, per process)
// ---------------------------------------------------------------------------

const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_PER_CLIENT = 120;
/** Whole-surface ceiling: a rotating caller-supplied key cannot exceed it. */
const RATE_LIMIT_PER_SURFACE = 600;
const DEFAULT_RATE_MAX_TRACKED_KEYS = 5_000;
let rateMaxTrackedKeys = DEFAULT_RATE_MAX_TRACKED_KEYS;
const rateBuckets = new Map<string, { windowStart: number; count: number }>();

export function resetSurfaceAuthRateLimitForTests(maxTrackedKeys?: number): void {
  rateBuckets.clear();
  rateMaxTrackedKeys = maxTrackedKeys ?? DEFAULT_RATE_MAX_TRACKED_KEYS;
}

function takeRateToken(key: string, limit: number, now: number): boolean {
  const bucket = rateBuckets.get(key);
  if (bucket && now - bucket.windowStart < RATE_WINDOW_MS) {
    // Re-insert so Map order tracks recency: eviction below drops the least
    // recently used bucket, never a hot attacker's.
    rateBuckets.delete(key);
    rateBuckets.set(key, bucket);
  }
  if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
    if (rateBuckets.size >= rateMaxTrackedKeys) {
      // Bound memory under key-rotation abuse: drop expired buckets, then the oldest.
      for (const [k, v] of rateBuckets) {
        if (now - v.windowStart >= RATE_WINDOW_MS) rateBuckets.delete(k);
      }
      if (rateBuckets.size >= rateMaxTrackedKeys) {
        const oldest = rateBuckets.keys().next().value;
        if (oldest !== undefined) rateBuckets.delete(oldest);
      }
    }
    rateBuckets.set(key, { windowStart: now, count: 1 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

/** Client key the adapter returns when it cannot tell callers apart (no trusted peer IP). */
const SHARED_CLIENT_KEY = 'shared';

/**
 * True when this request may proceed. Only applies when the adapter gave a
 * clientKey. Loopback is exempt (matches the Express surfaces). When callers
 * cannot be told apart (`shared`), a per-client cap would let one anonymous
 * flood lock every user out, so only the whole-surface ceiling applies.
 */
function withinRateLimit(req: SurfaceAuthRouteRequest, now: number): boolean {
  if (req.clientKey === undefined || req.loopback) return true;
  const surfaceOk = takeRateToken(`s:${req.surfaceId}`, RATE_LIMIT_PER_SURFACE, now);
  if (req.clientKey === SHARED_CLIENT_KEY) return surfaceOk;
  const clientOk = takeRateToken(`c:${req.surfaceId}:${req.clientKey}`, RATE_LIMIT_PER_CLIENT, now);
  return surfaceOk && clientOk;
}

function originHost(origin: string): string | null {
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

/**
 * A GET/POST /logout that a third party triggered. Browsers tag fetches with
 * `Sec-Fetch-Site`; only `same-origin` and `none` (typed URL) may sign out.
 * Without the header (older browsers) fall back to Origin/Referer: a present
 * origin whose host is not ours is rejected; an absent one is allowed.
 */
function isForeignLogout(req: SurfaceAuthRouteRequest, ownOrigins: string[]): boolean {
  if (req.secFetchSite) return req.secFetchSite !== 'same-origin' && req.secFetchSite !== 'none';
  if (!req.referrerOrigin) return false;
  const host = originHost(req.referrerOrigin);
  if (host === null) return true;
  return !ownOrigins.some((o) => originHost(o) === host);
}

function redirect(location: string, setCookies: string[] = []): SurfaceAuthRouteResponse {
  return {
    status: 302,
    headers: { Location: location, 'Cache-Control': 'no-store' },
    setCookies,
    body: '',
  };
}

function isSecureOrigin(origin: string): boolean {
  return origin.startsWith('https://');
}

function startHref(next: string): string {
  return next === '/'
    ? SURFACE_AUTH_START_PATH
    : `${SURFACE_AUTH_START_PATH}?next=${encodeURIComponent(next)}`;
}

function notAllowed(req: SurfaceAuthRouteRequest): SurfaceAuthRouteResponse {
  const allow = req.pathname === SURFACE_LOGOUT_PATH ? 'GET, POST' : 'GET, HEAD';
  return html(req, 405, { kind: 'failed', code: 'method_not_allowed' }, [], { Allow: allow });
}

/** Whether `pathname` belongs to the shared login flow. */
export { isSurfaceAuthPath } from './surface-session-cookie.js';

/**
 * Handle one login-flow request. Returns null for paths outside the flow so
 * an adapter can call it unconditionally.
 */
export async function handleSurfaceAuthRoute(
  req: SurfaceAuthRouteRequest,
  deps: OidcLoginDeps = {}
): Promise<SurfaceAuthRouteResponse | null> {
  const method = req.method.toUpperCase();
  if (isSurfaceAuthPath(req.pathname) && !withinRateLimit(req, deps.now ?? Date.now())) {
    return html(req, 429, { kind: 'failed', code: 'rate_limited' }, [], { 'Retry-After': '60' });
  }
  const next = sanitizeNextPath(req.searchParams.get('next'));
  // `Secure` follows the origin the browser actually uses: the DECLARED public
  // origin when there is one (a TLS-terminating proxy hands the app an http
  // request origin even though the user is on https), else the request origin.
  const loginConfig = resolveOidcLoginConfig(deps).config;
  const publicOrigin = loginConfig
    ? resolveOidcRedirectOrigin(loginConfig, {
        surfaceId: req.surfaceId,
        requestOrigin: req.requestOrigin,
        loopback: req.loopback,
      })
    : null;
  const secure = isSecureOrigin(publicOrigin ?? req.requestOrigin);

  switch (req.pathname) {
    case SURFACE_LOGIN_PATH: {
      if (method !== 'GET' && method !== 'HEAD') return notAllowed(req);
      const { config, missing } = resolveOidcLoginConfig(deps);
      if (!config) {
        return html(req, 200, {
          kind: 'unconfigured',
          missing,
          tokenHref: req.tokenSignInHref,
          setupHref: req.firstRunSetupHref,
        });
      }
      if (req.searchParams.get('error')) {
        return html(req, 200, { kind: 'failed', code: 'idp_error' });
      }
      if (req.searchParams.get('signedout') === '1') {
        return html(req, 200, {
          kind: 'signed-out',
          providerLabel: config.providerLabel,
          startHref: startHref(next),
        });
      }
      return html(req, 200, {
        kind: 'ready',
        providerLabel: config.providerLabel,
        startHref: startHref(next),
        tokenHref: req.tokenSignInHref,
        setupHref: req.firstRunSetupHref,
      });
    }

    case SURFACE_AUTH_START_PATH: {
      if (method !== 'GET') return notAllowed(req);
      const started = await startOidcLogin(
        {
          surfaceId: req.surfaceId,
          requestOrigin: req.requestOrigin,
          loopback: req.loopback,
          next,
        },
        deps
      );
      if (started.ok === false)
        return html(req, started.view.kind === 'unconfigured' ? 200 : 502, started.view);
      return redirect(started.location, [
        serializeCookie(started.transactionCookie.name, started.transactionCookie.value, {
          maxAgeSeconds: started.transactionCookie.maxAgeSeconds,
          secure,
          // The IdP redirects back with a top-level GET: Lax carries the cookie.
          sameSite: 'Lax',
        }),
      ]);
    }

    case SURFACE_AUTH_CALLBACK_PATH: {
      if (method !== 'GET') return notAllowed(req);
      const txName = loginTransactionCookieName(req.surfaceId);
      const cookies = parseCookieHeader(req.cookieHeader);
      const result = await completeOidcLogin(
        {
          surfaceId: req.surfaceId,
          query: {
            code: req.searchParams.get('code'),
            state: req.searchParams.get('state'),
            error: req.searchParams.get('error'),
          },
          transactionCookie: cookies[txName] ?? null,
        },
        deps
      );
      const clearTx = serializeClearedCookie(txName, secure);
      if (result.ok === false) return html(req, result.status, result.view, [clearTx]);
      return redirect(result.next, [
        clearTx,
        serializeCookie(SURFACE_SESSION_COOKIE, result.sessionToken, {
          maxAgeSeconds: result.sessionTtlSeconds,
          secure,
          sameSite: 'Lax',
        }),
      ]);
    }

    case SURFACE_LOGOUT_PATH: {
      if (method !== 'GET' && method !== 'POST') return notAllowed(req);
      // An <img> or link on another origin (or a sibling subdomain) must not be
      // able to sign the user out.
      if (isForeignLogout(req, [req.requestOrigin, ...(publicOrigin ? [publicOrigin] : [])])) {
        return html(req, 403, { kind: 'failed', code: 'logout_blocked' });
      }
      return redirect(`${SURFACE_LOGIN_PATH}?signedout=1`, [
        serializeClearedCookie(SURFACE_SESSION_COOKIE, secure),
      ]);
    }

    default:
      return null;
  }
}
