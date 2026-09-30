import { NextRequest, NextResponse } from 'next/server';
import {
  authorizeSurfaceMutation,
  type SurfaceMutationDecision,
} from '@agent/core/surface/surface-mutation-guard';
import { isLoopbackRequest } from './peer';
import { requireOperatorViewerAccess } from './viewer-context';

export function authorizeOperatorSurfaceMutation(
  req: Pick<NextRequest, 'headers' | 'url'>
): SurfaceMutationDecision {
  return authorizeSurfaceMutation({
    url: req.url,
    getHeader: (name) => req.headers.get(name),
  });
}

export function requireOperatorSurfaceMutationAccess(req: NextRequest): NextResponse | null {
  // Viewer first (401 without a credential from a remote peer; cookie-borne
  // sessions must also be same-origin), then the existing origin check.
  const viewerDenied = requireOperatorViewerAccess({
    method: req.method,
    headers: req.headers,
    loopback: isLoopbackRequest(req),
  });
  if (viewerDenied) return viewerDenied;
  const decision = authorizeOperatorSurfaceMutation(req);
  if (!decision.ok) {
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }
  return null;
}
