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
  /** Where a surface that supports pasted access tokens (concierge `/signin`) offers that path. */
  tokenSignInHref?: string;
}

export interface SurfaceAuthRouteResponse {
  status: number;
  /** Single-valued headers (Location, Content-Type, security headers, …). */
  headers: Record<string, string>;
  /** One entry per Set-Cookie header. */
  setCookies: string[];
  body: string;
}

function html(
  req: SurfaceAuthRouteRequest,
  status: number,
  view: SurfaceLoginView,
  setCookies: string[] = []
): SurfaceAuthRouteResponse {
  const locale = resolveLoginLocale(req.searchParams.get('lang'), req.acceptLanguage);
  return {
    status,
    headers: { ...SURFACE_LOGIN_PAGE_HEADERS },
    setCookies,
    body: renderSurfaceLoginPage({ surfaceLabel: req.surfaceLabel, view, locale }),
  };
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
      if (method !== 'GET' && method !== 'HEAD')
        return html(req, 405, { kind: 'failed', code: 'expired' });
      const { config, missing } = resolveOidcLoginConfig(deps);
      if (!config) {
        return html(req, 200, { kind: 'unconfigured', missing, tokenHref: req.tokenSignInHref });
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
      });
    }

    case SURFACE_AUTH_START_PATH: {
      if (method !== 'GET') return html(req, 405, { kind: 'failed', code: 'expired' });
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
      if (method !== 'GET') return html(req, 405, { kind: 'failed', code: 'expired' });
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
      if (method !== 'GET' && method !== 'POST')
        return html(req, 405, { kind: 'failed', code: 'expired' });
      return redirect(`${SURFACE_LOGIN_PATH}?signedout=1`, [
        serializeClearedCookie(SURFACE_SESSION_COOKIE, secure),
      ]);
    }

    default:
      return null;
  }
}
