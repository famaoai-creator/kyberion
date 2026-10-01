import { NextRequest, NextResponse } from 'next/server';
import { authorizeSurfaceMutation } from '@agent/core/surface/surface-mutation-guard';
import { isSameOriginMutation } from '@agent/core/surface/surface-session-cookie';
import {
  checkConciergeRateLimit,
  conciergeCredential,
  guardConciergeRequest,
  resolveConciergeViewer,
} from './viewer-context';

/**
 * Thin NextRequest wrapper over the shared surface mutation guard.
 *
 * The shared guard answers the CSRF/origin question; a bearer credential also
 * has to resolve to a localadmin viewer before Concierge writes are allowed.
 * Same-origin remains the local UI compatibility path.
 */
export function requireConciergeMutationAccess(req: NextRequest): NextResponse | null {
  const rateLimitResponse = guardConciergeRequest(req);
  if (rateLimitResponse) return rateLimitResponse;
  const credential = conciergeCredential(req);
  // A cookie rides along on cross-site requests, so a cookie-borne unsafe
  // request must be same-origin. Header-authenticated requests skip this.
  if (
    credential.source === 'session-cookie' &&
    !isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') ?? new URL(req.url).host,
    })
  ) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden. Cross-origin session request.' },
      { status: 403 }
    );
  }
  const decision = authorizeSurfaceMutation({
    url: req.url,
    getHeader: (name) => req.headers.get(name),
  });
  if (!decision.ok) {
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }

  // Do not let a readonly API-token success become an implicit write grant for
  // approval, setup, ingest, or mission-control routes.
  if (credential.token) {
    const viewer = resolveConciergeViewer(req);
    if (viewer.response) return viewer.response;
    if (viewer.context.role !== 'localadmin') {
      return NextResponse.json(
        { ok: false, error: 'Concierge mutation requires a localadmin viewer.' },
        { status: 403 }
      );
    }
  }
  return null;
}

/**
 * Guard for the join flow (`/api/invites/join`). Joining is done by someone who
 * is authenticated but may not hold a mutation role yet (a verified OIDC subject
 * with no membership resolves to a read-only viewer), so the usual
 * "localadmin viewer" requirement does not apply. What does apply: a tight
 * per-principal rate limit (an invite code is a one-time grant, not something
 * to guess at), and the CSRF check for cookie-borne requests. The identity that
 * joins is never taken from the request (see invite-server.ts).
 */
export function requireConciergeJoinAccess(req: NextRequest): NextResponse | null {
  const limited = checkConciergeRateLimit(req, { limit: 10 });
  if (!limited.ok) {
    return NextResponse.json(
      { ok: false, error: 'Concierge rate limit exceeded. Try again later.' },
      {
        status: 429,
        headers: limited.retryAfterSeconds
          ? { 'Retry-After': String(limited.retryAfterSeconds) }
          : undefined,
      }
    );
  }
  const credential = conciergeCredential(req);
  if (
    credential.source === 'session-cookie' &&
    req.method !== 'GET' &&
    !isSameOriginMutation({
      method: req.method,
      headers: req.headers,
      expectedHost: req.headers.get('host') ?? new URL(req.url).host,
    })
  ) {
    return NextResponse.json(
      { ok: false, error: 'Forbidden. Cross-origin session request.' },
      { status: 403 }
    );
  }
  return null;
}
