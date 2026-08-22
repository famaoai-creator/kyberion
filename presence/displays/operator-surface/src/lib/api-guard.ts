import { NextRequest, NextResponse } from 'next/server';
import { authorizeSurfaceMutation, type SurfaceMutationDecision } from '@agent/core';

export function authorizeOperatorSurfaceMutation(
  req: Pick<NextRequest, 'headers' | 'url'>
): SurfaceMutationDecision {
  return authorizeSurfaceMutation({
    url: req.url,
    getHeader: (name) => req.headers.get(name),
  });
}

export function requireOperatorSurfaceMutationAccess(req: NextRequest): NextResponse | null {
  const decision = authorizeOperatorSurfaceMutation(req);
  if (!decision.ok) {
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }
  return null;
}
