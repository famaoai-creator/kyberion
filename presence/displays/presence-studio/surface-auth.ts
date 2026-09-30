import type { Express, Request, RequestHandler } from 'express';
import { handleSurfaceAuthRoute } from '@agent/core/surface/surface-auth-routes';
import {
  extractSurfaceCredential,
  isSurfaceAuthPath,
  peekSessionExpiry,
  resolveLoginRedirect,
} from '@agent/core/surface/surface-session-cookie';
import { logger } from '@agent/core/core';
import {
  getPresenceStudioClientAddress,
  isLoopbackAddress,
  isPresenceStudioRemoteAccessEnabled,
  requirePresenceStudioRateLimit,
} from './security.js';

const SURFACE_ID = 'presence-studio';
const SURFACE_LABEL = 'Presence Studio';

function requestUrl(req: Request): { pathname: string; search: string } {
  const raw = String(req.originalUrl || req.url || '/');
  const index = raw.indexOf('?');
  return index < 0
    ? { pathname: raw, search: '' }
    : { pathname: raw.slice(0, index), search: raw.slice(index) };
}

function isLoopbackPeer(req: Request): boolean {
  // Peer = socket address, never the Host header.
  return isLoopbackAddress(getPresenceStudioClientAddress(req));
}

/** Mount /login, /auth/start, /auth/callback, /logout (unauthenticated, before any page route). */
export function registerPresenceStudioAuthRoutes(app: Express): void {
  const handler: RequestHandler = async (req, res, next) => {
    const { pathname, search } = requestUrl(req);
    try {
      const result = await handleSurfaceAuthRoute({
        surfaceId: SURFACE_ID,
        surfaceLabel: SURFACE_LABEL,
        method: req.method,
        pathname,
        searchParams: new URLSearchParams(search),
        cookieHeader: req.headers.cookie ?? null,
        acceptLanguage: req.headers['accept-language'] ?? null,
        requestOrigin: `${req.protocol}://${req.get('host') || ''}`,
        loopback: isLoopbackPeer(req),
      });
      if (!result) return next();
      res.status(result.status);
      for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
      for (const cookie of result.setCookies) res.append('Set-Cookie', cookie);
      res.send(result.body);
    } catch (error) {
      logger.warn(
        `[presence-studio][auth] login route failed — ${error instanceof Error ? error.message : String(error)} | retry sign-in | path=${pathname}`
      );
      res.status(500).type('text/plain').send('Sign-in is unavailable.');
    }
  };
  const limiter = requirePresenceStudioRateLimit();
  app.get(['/login', '/auth/start', '/auth/callback', '/logout'], limiter, handler);
  app.post(['/login', '/auth/start', '/auth/callback', '/logout'], limiter, handler);
}

/** 302 an unauthenticated remote browser page navigation to /login?next=... */
export function presenceStudioLoginRedirect(): RequestHandler {
  return (req, res, next) => {
    // Remote disabled => the request is a flat 403 regardless of login; a redirect
    // would only lead to a sign-in that cannot help.
    if (!isPresenceStudioRemoteAccessEnabled()) return next();
    const { pathname, search } = requestUrl(req);
    if (isSurfaceAuthPath(pathname)) return next();
    const credential = extractSurfaceCredential({
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    const hasCredential =
      credential.source === 'header' ||
      (credential.source === 'session-cookie' && peekSessionExpiry(credential.token) === 'valid');
    const target = resolveLoginRedirect({
      method: req.method,
      pathname,
      search,
      headers: req.headers,
      loopback: isLoopbackPeer(req),
      hasCredential,
    });
    if (!target) return next();
    return res.redirect(302, target);
  };
}
