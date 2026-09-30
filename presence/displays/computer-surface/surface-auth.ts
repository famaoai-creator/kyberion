import { rateLimit } from 'express-rate-limit';
import type { Express, Request, RequestHandler } from 'express';
import { handleSurfaceAuthRoute } from '@agent/core/surface/surface-auth-routes';
import {
  SURFACE_AUTH_PATHS,
  extractSurfaceSessionToken,
  peekSessionExpiry,
  resolveLoginRedirect,
} from '@agent/core/surface/surface-session-cookie';
import { isComputerSurfaceLoopbackRequest } from './auth.js';

/**
 * Login routes and the page-navigation redirect read credentials, so they sit
 * behind the same kind of limiter as the API: remote callers only (loopback is
 * skipped, like the API limiter), generous enough for page + asset loads.
 */
export const computerSurfaceAuthRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  skip: (req) => isComputerSurfaceLoopbackRequest(req),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ ok: false, error: 'Computer Surface rate limit exceeded.' });
  },
});

const SURFACE_ID = 'computer-surface';
const SURFACE_LABEL = 'Computer Surface';

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function hasCredential(req: Request): boolean {
  const authorization = first(req.headers.authorization);
  if (typeof authorization === 'string' && authorization.trim()) return true;
  const token = extractSurfaceSessionToken(first(req.headers.cookie));
  return Boolean(token) && peekSessionExpiry(token) === 'valid';
}

/** Login routes (/login, /auth/start, /auth/callback, /logout) — unauthenticated. */
export function registerComputerSurfaceAuthRoutes(app: Express): void {
  const handler: RequestHandler = async (req, res, next) => {
    try {
      const url = new URL(req.originalUrl, 'http://placeholder.invalid');
      const result = await handleSurfaceAuthRoute({
        surfaceId: SURFACE_ID,
        surfaceLabel: SURFACE_LABEL,
        method: req.method,
        pathname: url.pathname,
        searchParams: url.searchParams,
        cookieHeader: first(req.headers.cookie) ?? null,
        acceptLanguage: first(req.headers['accept-language']) ?? null,
        requestOrigin: `${req.protocol}://${req.headers.host ?? ''}`,
        loopback: isComputerSurfaceLoopbackRequest(req),
      });
      if (!result) {
        next();
        return;
      }
      res.status(result.status);
      for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
      for (const cookie of result.setCookies) res.append('Set-Cookie', cookie);
      res.send(result.body);
    } catch (error) {
      next(error);
    }
  };
  app.get([...SURFACE_AUTH_PATHS], computerSurfaceAuthRateLimiter, handler);
  app.post([...SURFACE_AUTH_PATHS], computerSurfaceAuthRateLimiter, handler);
}

/** 302 -> /login?next=... for unauthenticated remote browser page navigations only. */
export function computerSurfaceLoginRedirect(): RequestHandler {
  return (req, res, next) => {
    const url = new URL(req.originalUrl, 'http://placeholder.invalid');
    const target = resolveLoginRedirect({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      headers: req.headers,
      loopback: isComputerSurfaceLoopbackRequest(req),
      hasCredential: hasCredential(req),
    });
    if (target) {
      res.redirect(302, target);
      return;
    }
    next();
  };
}
