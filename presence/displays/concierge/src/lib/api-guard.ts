import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeSurfaceMutation,
  extractSurfaceBearerToken,
} from '@agent/core/surface-mutation-guard';
import { guardConciergeRequest, resolveConciergeViewer } from './viewer-context';

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
  const decision = authorizeSurfaceMutation({
    url: req.url,
    getHeader: (name) => req.headers.get(name),
  });
  if (!decision.ok) {
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }

  // Do not let a readonly API-token success become an implicit write grant for
  // approval, setup, ingest, or mission-control routes.
  const bearer = extractSurfaceBearerToken(req.headers.get('authorization'));
  if (bearer) {
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
