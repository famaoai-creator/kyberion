import { NextRequest, NextResponse } from 'next/server';
import { authorizeSurfaceMutation } from '@agent/core';

/** Thin NextRequest wrapper over the shared surface mutation guard. */
export function requireConciergeMutationAccess(req: NextRequest): NextResponse | null {
  const decision = authorizeSurfaceMutation({
    url: req.url,
    getHeader: (name) => req.headers.get(name),
  });
  if (!decision.ok) {
    return NextResponse.json({ ok: false, error: decision.reason }, { status: decision.status });
  }
  return null;
}
